package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/noctalum/noctalum/internal/store"
)

// handleBackups routes /api/backups list (GET) and create (POST).
// Guarded by PermBackupsManage upstream.
func (s *Server) handleBackups(w http.ResponseWriter, r *http.Request) {
	if s.backups == nil {
		writeError(w, http.StatusServiceUnavailable, "backups not configured")
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := s.backups.List()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		// Return the retention setting alongside the list so the UI
		// doesn't need a second round-trip.
		set, _ := s.store.LoadSettings()
		writeJSON(w, http.StatusOK, map[string]any{
			"backups":               list,
			"backup_retention_days": set.BackupRetentionDays,
		})
	case http.MethodPost:
		b, err := s.backups.Take(r.Context(), false)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		sess, _ := s.sessions.SessionFromRequest(r)
		actor := ""
		if sess != nil {
			actor = sess.Username
		}
		s.audit(r, store.AuditInfo, AuditBackupTake, actor, b.Name,
			fmt.Sprintf("manual backup, %d bytes, hash=%s", b.Bytes, b.Hash))
		writeJSON(w, http.StatusCreated, b)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleBackupByName routes /api/backups/<name> download (GET) and
// delete (DELETE), plus /api/backups/<name>/restore (POST). The
// filename is untrusted user input — we defer to backup.Manager to
// validate it against the noctalum-<ts>-<hash>-* naming pattern
// (which excludes anything containing ".." or extra "/").
func (s *Server) handleBackupByName(w http.ResponseWriter, r *http.Request) {
	if s.backups == nil {
		writeError(w, http.StatusServiceUnavailable, "backups not configured")
		return
	}
	subpath := strings.TrimPrefix(r.URL.Path, "/api/backups/")
	// Route: <name>/restore is the only two-segment path we accept.
	if strings.HasSuffix(subpath, "/restore") {
		name := strings.TrimSuffix(subpath, "/restore")
		if name == "" || strings.Contains(name, "/") {
			writeError(w, http.StatusBadRequest, "invalid backup name")
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		s.handleBackupRestore(w, r, name)
		return
	}
	name := subpath
	if name == "" || strings.Contains(name, "/") {
		writeError(w, http.StatusBadRequest, "invalid backup name")
		return
	}
	switch r.Method {
	case http.MethodGet:
		f, err := s.backups.Open(name)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeError(w, http.StatusNotFound, "backup not found")
				return
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		defer f.Close()
		info, _ := f.Stat()
		w.Header().Set("Content-Type", "application/gzip")
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		if info != nil {
			w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
		}
		if _, err := io.Copy(w, f); err != nil {
			// Client aborted mid-stream; audit the *attempt* below anyway.
			return
		}
		sess, _ := s.sessions.SessionFromRequest(r)
		actor := ""
		if sess != nil {
			actor = sess.Username
		}
		s.audit(r, store.AuditInfo, AuditBackupDownload, actor, name, "")
	case http.MethodDelete:
		if err := s.backups.Delete(name); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeError(w, http.StatusNotFound, "backup not found")
				return
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		sess, _ := s.sessions.SessionFromRequest(r)
		actor := ""
		if sess != nil {
			actor = sess.Username
		}
		// Warn-level because operators may want an alert when
		// backups get removed (defensive posture — losing a
		// backup accidentally is expensive to recover from).
		s.audit(r, store.AuditWarn, AuditBackupDelete, actor, name, "")
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "GET, DELETE")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleBackupRestore validates the request, takes a safety backup of
// the current state, then writes a trigger file that a host-side
// systemd unit picks up (see deploy/systemd/noctalum-restore.*). The
// systemd unit stops the app container, feeds the .sql.gz into
// psql inside the postgres container, and starts the app again. The
// app itself does NOT execute the restore — dropping and reloading
// tables while the app holds live DB connections would be
// self-destructive.
//
// Contract with the systemd side (deploy/systemd/noctalum-restore.sh):
//   - Trigger file: JSON at s.restoreTriggerPath
//     {"backup_file":"<name>","requested_by":"<user>","requested_at":"<rfc3339>"}
//   - Systemd is responsible for deleting the file after processing
//     (success OR failure) so a stale trigger doesn't loop.
//
// Returns 202 Accepted on success — the actual restore happens
// asynchronously after this response is written. Refuses if a trigger
// is already in flight.
func (s *Server) handleBackupRestore(w http.ResponseWriter, r *http.Request, name string) {
	if s.restoreTriggerPath == "" {
		writeError(w, http.StatusServiceUnavailable, "restore not configured on this deploy")
		return
	}
	// Validate the target file exists AND passes the Manager's name filter.
	f, err := s.backups.Open(name)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "backup not found")
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = f.Close()

	// Refuse if a restore is already in flight — two concurrent
	// restores would race the systemd unit.
	if _, err := os.Stat(s.restoreTriggerPath); err == nil {
		writeError(w, http.StatusConflict, "another restore is already in flight")
		return
	}

	sess, _ := s.sessions.SessionFromRequest(r)
	actor := ""
	if sess != nil {
		actor = sess.Username
	}

	// Belt-and-suspenders: take a fresh backup right before switching,
	// so if the restore itself corrupts something we can revert to the
	// last known-good moment. If this pre-backup fails we abort — the
	// operator can retry once whatever's wrong is fixed.
	safety, err := s.backups.Take(r.Context(), false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "pre-restore safety backup failed: "+err.Error())
		return
	}

	// Broadcast BEFORE writing the trigger so browsers can render the
	// "restore in progress" overlay while the countdown to shutdown
	// starts. Once the systemd unit stops the container, the WS drops
	// naturally and the overlay stays until reconnect.
	s.hub.Broadcast(Event{Type: "restore_starting", Payload: map[string]any{
		"backup_file":   name,
		"safety_backup": safety.Name,
		"requested_by":  actor,
	}})

	payload, _ := json.Marshal(map[string]string{
		"backup_file":   name,
		"requested_by":  actor,
		"requested_at":  time.Now().UTC().Format(time.RFC3339),
		"safety_backup": safety.Name,
	})
	// Write atomically via temp + rename so a partially-written trigger
	// can never fire the systemd path unit mid-write.
	tmp := s.restoreTriggerPath + ".part"
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		writeError(w, http.StatusInternalServerError, "write trigger: "+err.Error())
		return
	}
	if err := os.Rename(tmp, s.restoreTriggerPath); err != nil {
		_ = os.Remove(tmp)
		writeError(w, http.StatusInternalServerError, "rename trigger: "+err.Error())
		return
	}

	// Error level: restore is a destructive, rarely-legitimate action.
	// A cluster of these in the audit log should stand out.
	s.audit(r, store.AuditError, AuditBackupRestore, actor, name,
		"safety backup: "+safety.Name)

	writeJSON(w, http.StatusAccepted, map[string]any{
		"backup_file":   name,
		"safety_backup": safety.Name,
		"message":       "restore triggered; container will be stopped by the systemd unit shortly",
	})
}
