package server

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

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
		s.audit(r, store.AuditInfo, "backup.take", actor, b.Name,
			fmt.Sprintf("manual backup, %d bytes, hash=%s", b.Bytes, b.Hash))
		writeJSON(w, http.StatusCreated, b)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleBackupByName routes /api/backups/<name> download (GET) and
// delete (DELETE). The filename is untrusted user input — we defer to
// backup.Manager to validate it against the noctalum-<ts>-<hash>-*
// naming pattern (which excludes anything containing "/" or "..").
func (s *Server) handleBackupByName(w http.ResponseWriter, r *http.Request) {
	if s.backups == nil {
		writeError(w, http.StatusServiceUnavailable, "backups not configured")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/api/backups/")
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
		s.audit(r, store.AuditInfo, "backup.download", actor, name, "")
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
		s.audit(r, store.AuditWarn, "backup.delete", actor, name, "")
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "GET, DELETE")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
