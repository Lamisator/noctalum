package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/noctalum/noctalum/internal/store"
)

// ----- admin elevation ("activate admin permissions") -----
//
// Holding an admin role no longer means holding admin powers. A session
// starts with ElevatedPermissions stripped (see Session.EffectivePermissions)
// and gets them only after the operator proves, again, that they are who the
// session says they are. The proof accepts exactly the same evidence as a
// normal login — password, passkey, or an approval from another device the
// same account is already signed in on — because it is the same question.
//
// The grant is a pure idle timeout: every real action pushes the deadline out
// (see touchElevationFor and handleAdminKeepalive), and it lapses silently
// once nothing happens for the configured window. Nothing about it is
// persisted, so a restart de-elevates everyone; and switching accounts drops
// it at once (handleSessionSwitch), because the new operator never proved
// anything.

// Audit actions for the elevation lifecycle.
const (
	AuditAdminElevate     = "admin.elevate"
	AuditAdminElevateFail = "admin.elevate_failed"
	AuditAdminLock        = "admin.lock"
)

// elevationTTL is the idle window configured by the operator, clamped.
func (s *Server) elevationTTL() time.Duration {
	return time.Duration(store.ClampAdminElevationMinutes(s.settings.AdminElevationMinutes)) * time.Minute
}

// elevationState is the payload every elevation endpoint answers with, so the
// frontend has one shape to drive the countdown bar from.
func (s *Server) elevationState(sess *Session) map[string]any {
	out := map[string]any{
		"elevated":       sess.AdminElevated(),
		"can_elevate":    sess.CanElevate(),
		"permissions":    sess.EffectivePermissions(),
		"seconds_left":   0,
		"window_seconds": int(s.elevationTTL().Seconds()),
	}
	if until := sess.AdminUntil(); !until.IsZero() {
		out["until"] = until.UTC().Format(time.RFC3339)
		out["seconds_left"] = int(time.Until(until).Round(time.Second).Seconds())
	}
	return out
}

// grantElevation is the single place an elevation is handed out, so every
// route into it audits identically and no route can skip the "does this
// account actually have admin powers to activate" check.
func (s *Server) grantElevation(w http.ResponseWriter, r *http.Request, sess *Session, method string) {
	if !sess.CanElevate() {
		writeError(w, http.StatusForbidden, "this account has no admin permissions to activate")
		return
	}
	ttl := s.elevationTTL()
	sess.Elevate(ttl)
	s.audit(r, store.AuditWarn, AuditAdminElevate, sess.Username, "",
		"admin permissions activated via "+method+" for "+ttl.String())
	writeJSON(w, http.StatusOK, s.elevationState(sess))
}

// handleAdminElevate re-authenticates with the session's own password.
func (s *Server) handleAdminElevate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sess := sessionFor(s, r)
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	u, err := s.store.GetUserByID(sess.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// An SSO-provisioned account may have no local password at all; say so
	// plainly instead of failing as "wrong password" forever.
	if u.PasswordHash == "" {
		writeError(w, http.StatusBadRequest, "this account has no password — use a passkey or another device")
		return
	}
	if !VerifyPassword(u.PasswordHash, body.Password) {
		s.audit(r, store.AuditWarn, AuditAdminElevateFail, sess.Username, "", "wrong password")
		// Deliberately NOT 401. Everywhere else in this API a 401 means
		// "your session is gone", and the client reacts by dropping to the
		// login screen — which is exactly the wrong response to a typo in a
		// re-auth prompt: the session is perfectly valid, the challenge just
		// failed. 403 plus a code says that without overloading 401.
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error": "wrong password",
			"code":  "bad_credentials",
		})
		return
	}
	s.grantElevation(w, r, sess, "password")
}

// handleAdminElevatePasskey finishes a discoverable-passkey assertion started
// at /api/passkey/login/begin.  The credential must resolve to the account the
// session already belongs to — proving *some* identity is not enough.
func (s *Server) handleAdminElevatePasskey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sess := sessionFor(s, r)
	u, ok := s.finishDiscoverablePasskey(w, r)
	if !ok {
		return
	}
	clearPasskeySessionCookie(w)
	if u.ID != sess.UserID {
		s.audit(r, store.AuditWarn, AuditAdminElevateFail, sess.Username, "",
			"passkey belongs to "+u.Username)
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error": "that passkey belongs to a different account",
			"code":  "wrong_account",
		})
		return
	}
	s.grantElevation(w, r, sess, "passkey")
}

// handleAdminElevatePairCreate opens a device-approval request for elevation.
// Unlike the login variant the caller is already signed in, so the request
// records who asked and only that same account may approve it.
func (s *Server) handleAdminElevatePairCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sess := sessionFor(s, r)
	if !sess.CanElevate() {
		writeError(w, http.StatusForbidden, "this account has no admin permissions to activate")
		return
	}
	id := randomID(24)
	now := time.Now()
	expires := now.Add(loginRequestTTL)
	if err := s.store.CreateLoginRequest(id, clientIP(r), truncate(r.UserAgent(), 512),
		store.LoginRequestPurposeElevate, sess.UserID, now, expires); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":          id,
		"expires_at":  expires.UTC().Format(time.RFC3339),
		"ttl_seconds": int(loginRequestTTL.Seconds()),
	})
}

// handleAdminElevatePairStatus long-polls one elevation request, mirroring
// handleLoginRequestStatus.  On approval it elevates the *calling* session
// rather than minting a new one.
func (s *Server) handleAdminElevatePairStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	sess := sessionFor(s, r)
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	deadline := time.Now().Add(loginRequestPollTimeout)
	for {
		req, err := s.store.GetLoginRequest(id)
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "expired"})
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		// Only the session that opened the request may watch it, and only
		// for as long as it is fresh.
		if req.Purpose != store.LoginRequestPurposeElevate || req.RequesterUserID != sess.UserID {
			writeError(w, http.StatusNotFound, "request not found")
			return
		}
		if time.Now().After(req.ExpiresAt) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "expired"})
			return
		}
		switch req.Status {
		case store.LoginRequestApproved:
			approverID, err := s.store.ConsumeLoginRequest(id, store.LoginRequestPurposeElevate, time.Now())
			if err != nil {
				writeJSON(w, http.StatusOK, map[string]any{"status": "consumed"})
				return
			}
			// Belt and braces: DecideLoginRequest already refuses an
			// approver other than the requester, but the grant is the
			// security boundary, so it re-checks rather than trusting it.
			if approverID != sess.UserID {
				s.audit(r, store.AuditWarn, AuditAdminElevateFail, sess.Username, "",
					"device approval came from a different account")
				writeError(w, http.StatusForbidden, "approved by a different account")
				return
			}
			s.grantElevation(w, r, sess, "device approval")
			return
		case store.LoginRequestDenied:
			writeJSON(w, http.StatusOK, map[string]any{"status": "denied"})
			return
		case store.LoginRequestConsumed:
			writeJSON(w, http.StatusOK, map[string]any{"status": "consumed"})
			return
		}
		if time.Now().After(deadline) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "pending"})
			return
		}
		time.Sleep(loginRequestPollInterval)
	}
}

// handleAdminKeepalive restarts the idle countdown.  The frontend calls it
// (throttled) when it observes real input, which is what makes plain browsing
// count as activity — the server-side touch in touchElevationFor only fires on
// mutating requests, deliberately ignoring background polling.
//
// It cannot revive a lapsed elevation: TouchElevation returns the zero time,
// and the response then simply reports elevated=false so the bar disappears.
func (s *Server) handleAdminKeepalive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sess := sessionFor(s, r)
	sess.TouchElevation()
	writeJSON(w, http.StatusOK, s.elevationState(sess))
}

// handleAdminLock gives back the elevated permissions before the timer runs
// out — the "Lock now" button on the countdown bar.
func (s *Server) handleAdminLock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sess := sessionFor(s, r)
	if sess.AdminElevated() {
		s.audit(r, store.AuditInfo, AuditAdminLock, sess.Username, "", "admin permissions locked")
	}
	sess.DropElevation()
	writeJSON(w, http.StatusOK, s.elevationState(sess))
}
