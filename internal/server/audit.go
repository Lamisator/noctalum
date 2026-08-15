package server

import (
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/noctalum/noctalum/internal/store"
)

// Audit action constants — one canonical name per auditable event.
const (
	AuditLoginSuccess       = "login.success"
	AuditLoginFailure       = "login.failure"
	AuditLoginLocked        = "login.locked"
	AuditLoginDisabled      = "login.disabled"
	AuditLogout             = "logout"
	AuditUserCreate         = "user.create"
	AuditUserDelete         = "user.delete"
	AuditUserDisable        = "user.disable"
	AuditUserEnable         = "user.enable"
	AuditUserUnlock         = "user.unlock"
	AuditUserPasswordReset   = "user.password_reset"
	AuditUserPasswordChange  = "user.password_change"
	AuditUserHelperTokenRegen = "user.helper_token_regen"
	AuditUserRolesChange    = "user.roles_change"
	AuditUserUsernameChange = "user.username_change"
	AuditRoleCreate         = "role.create"
	AuditRoleDelete         = "role.delete"
	AuditRolePermsChange    = "role.permissions_change"
	AuditSettingsChange     = "settings.change"
	AuditContestCreate       = "contest.create"
	AuditContestUpdate       = "contest.update"
	AuditContestDelete       = "contest.delete"
	AuditContestGrantAccess  = "contest.grant_access"
	AuditContestRevokeAccess = "contest.revoke_access"
	AuditRigRelease          = "rig.release"
	AuditRigSelect           = "rig.select"
	AuditRigDummyCreate      = "rig.dummy_create"
	AuditRigDummyDelete      = "rig.dummy_delete"
	AuditQSOCreate           = "qso.create"
	AuditQSOUpdate           = "qso.update"
	AuditQSODelete           = "qso.delete"
	AuditContestSelect       = "contest.select"
	AuditPasskeyRegister     = "passkey.register"
	AuditPasskeyDelete       = "passkey.delete"
	AuditSoundUpload         = "sound.upload"
	AuditSoundDelete         = "sound.delete"
	AuditFeatureRequestCreate = "feature_request.create"
	AuditFeatureRequestUpdate = "feature_request.update"
	AuditFeatureRequestDelete = "feature_request.delete"
	AuditCallsignRequestCreate   = "callsign_request.create"
	AuditCallsignRequestWithdraw = "callsign_request.withdraw"
	AuditCallsignRequestApprove  = "callsign_request.approve"
	AuditCallsignRequestReject   = "callsign_request.reject"
	// Backup subsystem.  *.take / *.download / *.delete / *.restore are
	// operator-initiated (HTTP handler audits them directly).  *.auto and
	// *.prune are goroutine-driven and get emitted through the
	// backup.Manager.OnAudit callback with actor="system".
	AuditBackupTake     = "backup.take"
	AuditBackupAuto     = "backup.auto"
	AuditBackupDownload = "backup.download"
	AuditBackupDelete   = "backup.delete"
	AuditBackupPrune    = "backup.prune"
	AuditBackupRestore  = "backup.restore"
	AuditExport              = "export"
	AuditAccessDenied        = "access.denied"
	// Groups + per-contest permission overhaul.
	AuditGroupCreate         = "group.create"
	AuditGroupUpdate         = "group.update"
	AuditGroupDelete         = "group.delete"
	AuditGroupMemberAdd      = "group.member_add"
	AuditGroupMemberRemove   = "group.member_remove"
	AuditGroupMemberRoleChange = "group.member_role_change"
	AuditContestVisibilityChange = "contest.visibility_change"
	AuditContestGroupAccessChange = "contest.group_access_change"
)

// AllAuditActions is used by the UI to populate the action filter dropdown.
var AllAuditActions = []string{
	AuditLoginSuccess, AuditLoginFailure, AuditLoginLocked, AuditLoginDisabled,
	AuditLogout,
	AuditUserCreate, AuditUserDelete, AuditUserDisable, AuditUserEnable,
	AuditUserUnlock, AuditUserPasswordReset, AuditUserPasswordChange, AuditUserHelperTokenRegen, AuditUserRolesChange, AuditUserUsernameChange,
	AuditRoleCreate, AuditRoleDelete, AuditRolePermsChange,
	AuditSettingsChange,
	AuditContestCreate, AuditContestUpdate, AuditContestDelete, AuditContestGrantAccess, AuditContestRevokeAccess, AuditContestSelect,
	AuditQSOCreate, AuditQSOUpdate, AuditQSODelete,
	AuditRigRelease, AuditRigSelect, AuditRigDummyCreate, AuditRigDummyDelete,
	AuditPasskeyRegister, AuditPasskeyDelete,
	AuditSoundUpload, AuditSoundDelete,
	AuditFeatureRequestCreate, AuditFeatureRequestUpdate, AuditFeatureRequestDelete,
	AuditCallsignRequestCreate, AuditCallsignRequestWithdraw, AuditCallsignRequestApprove, AuditCallsignRequestReject,
	AuditExport,
	AuditAccessDenied,
	AuditGroupCreate, AuditGroupUpdate, AuditGroupDelete,
	AuditGroupMemberAdd, AuditGroupMemberRemove, AuditGroupMemberRoleChange,
	AuditContestVisibilityChange, AuditContestGroupAccessChange,
	AuditLoginPairApprove, AuditLoginPairDeny,
}

// audit writes one entry to the store, discarding errors after logging them.
func (s *Server) audit(r *http.Request, level store.AuditLevel, action, actor, target, details string) {
	ip := clientIP(r)
	if err := s.store.InsertAuditLog(level, action, actor, target, details, ip); err != nil {
		log.Printf("audit log write error: %v", err)
	}
}

// clientIP extracts the remote IP, honouring X-Forwarded-For from trusted proxies.
func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		return strings.TrimSpace(strings.SplitN(fwd, ",", 2)[0])
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

// handleAuditLog serves GET /api/audit.
func (s *Server) handleAuditLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	q := r.URL.Query()
	f := store.AuditFilter{
		Level:    q.Get("level"),
		Action:   q.Get("action"),
		Search:   q.Get("search"),
		SortBy:   q.Get("sort"),
		SortDesc: q.Get("dir") != "asc",
	}
	if v := q.Get("since"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid since timestamp")
			return
		}
		f.Since = &t
	}
	if v := q.Get("until"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid until timestamp")
			return
		}
		f.Until = &t
	}
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Limit = n
		}
	}
	if v := q.Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Offset = n
		}
	}

	entries, total, err := s.store.ListAuditLogs(f)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if entries == nil {
		entries = []store.AuditEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"total":   total,
		"entries": entries,
		"actions": AllAuditActions,
	})
}

// handleSystemLog serves GET /api/system-log. Shape mirrors handleAuditLog
// (level/search/date/sort/limit/offset) so the frontend can reuse the
// same fetch + pagination scaffolding — but the record shape is
// simpler: no actor/IP/action, just level/source/message.
func (s *Server) handleSystemLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	q := r.URL.Query()
	f := store.SysFilter{
		Level:    q.Get("level"),
		Source:   q.Get("source"),
		Search:   q.Get("search"),
		SortBy:   q.Get("sort"),
		SortDesc: q.Get("dir") != "asc",
	}
	if v := q.Get("since"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid since timestamp")
			return
		}
		f.Since = &t
	}
	if v := q.Get("until"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid until timestamp")
			return
		}
		f.Until = &t
	}
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Limit = n
		}
	}
	if v := q.Get("offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Offset = n
		}
	}

	entries, total, err := s.store.ListSystemLogs(f)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if entries == nil {
		entries = []store.SysEntry{}
	}
	sources, err := s.store.SystemLogSources()
	if err != nil {
		// Non-fatal — the filter dropdown just won't be pre-populated.
		s.sysLog(store.SysWarn, "system-log", "list sources: "+err.Error())
		sources = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"total":   total,
		"entries": entries,
		"sources": sources,
		"levels":  AllSystemLogLevels,
	})
}
