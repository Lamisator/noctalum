package server

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/noctalum/noctalum/internal/store"
)

const (
	// loginRequestTTL is how long a pending device-pairing request stays
	// alive before the requesting device must start over.  Kept short so a
	// stale QR code can't be scanned hours later.
	loginRequestTTL = 2 * time.Minute
	// loginRequestPollTimeout caps a single long-poll on the status
	// endpoint.  When it elapses without a decision the requester issues
	// another poll — this keeps the connection healthy through proxies
	// and lets the browser observe network errors quickly.
	loginRequestPollTimeout = 25 * time.Second
	// loginRequestPollInterval is how often the long-poll goroutine
	// re-checks the DB for state changes.
	loginRequestPollInterval = 500 * time.Millisecond
)

// Audit actions for the device-pairing login flow.  The successful pairing
// is recorded as AuditLoginSuccess (like every other login) with the
// details string "device-pair"; the approve/deny events below record the
// approver's side of the decision.
const (
	AuditLoginPairApprove = "login.pair_approve"
	AuditLoginPairDeny    = "login.pair_deny"
)

// handleLoginRequestCreate is public.  It records the requester's IP + UA
// and returns a random id whose lifetime is loginRequestTTL.  The client
// encodes this id in a QR code so an already-authenticated user can scan
// it and approve the new device.
func (s *Server) handleLoginRequestCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	id := randomID(24)
	now := time.Now()
	expires := now.Add(loginRequestTTL)
	ip := clientIP(r)
	ua := truncate(r.UserAgent(), 512)
	if err := s.store.CreateLoginRequest(id, ip, ua, now, expires); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":          id,
		"expires_at":  expires.UTC().Format(time.RFC3339),
		"ttl_seconds": int(loginRequestTTL.Seconds()),
	})
}

// handleLoginRequestStatus is a public long-poll: the requesting device
// calls this repeatedly until the request is approved (in which case a
// session cookie is set and the row transitions to consumed), denied, or
// expired.  Only the row's owner-ip is not enforced here; the id itself
// is the bearer credential.
func (s *Server) handleLoginRequestStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
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
		if time.Now().After(req.ExpiresAt) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "expired"})
			return
		}
		switch req.Status {
		case store.LoginRequestApproved:
			// Atomically flip to consumed and mint a session for the
			// approver's user.  Any concurrent poll from the same id
			// hitting the same path returns "consumed" and cannot
			// hijack the session.
			approverID, err := s.store.ConsumeLoginRequest(id, time.Now())
			if err != nil {
				writeJSON(w, http.StatusOK, map[string]any{"status": "consumed"})
				return
			}
			u, err := s.store.GetUserByID(approverID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if u.Disabled {
				writeError(w, http.StatusForbidden, "account disabled")
				return
			}
			sess := s.sessions.Create(u)
			SetSessionCookie(w, sess.ID)
			s.audit(r, store.AuditInfo, AuditLoginSuccess, u.Username, "", "device-pair")
			go s.store.TouchUserActivity(u.ID)
			writeJSON(w, http.StatusOK, map[string]any{
				"status":  "approved",
				"session": sessionInfo(sess),
			})
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
		select {
		case <-r.Context().Done():
			return
		case <-time.After(loginRequestPollInterval):
		}
	}
}

// handleLoginRequestByID serves GET (approver dialog details) and
// POST /approve, POST /deny (decision).  Auth is required so only a
// logged-in user can view or decide; CSRF is enforced by requireAuth
// for the mutating verbs.
func (s *Server) handleLoginRequestByID(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	path := strings.TrimPrefix(r.URL.Path, "/api/login-request/")

	// /api/login-request/{id} — GET details for the approver dialog.
	// /api/login-request/{id}/approve — POST to approve.
	// /api/login-request/{id}/deny    — POST to deny.
	var id, action string
	if i := strings.Index(path, "/"); i >= 0 {
		id, action = path[:i], path[i+1:]
	} else {
		id = path
	}
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}

	req, err := s.store.GetLoginRequest(id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "request not found or expired")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if time.Now().After(req.ExpiresAt) {
		writeError(w, http.StatusGone, "request expired")
		return
	}

	switch {
	case action == "" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{
			"id":           req.ID,
			"status":       string(req.Status),
			"requester_ip": req.RequesterIP,
			"requester_ua": req.RequesterUA,
			"created_at":   req.CreatedAt.UTC().Format(time.RFC3339),
			"expires_at":   req.ExpiresAt.UTC().Format(time.RFC3339),
		})
	case (action == "approve" || action == "deny") && r.Method == http.MethodPost:
		approve := action == "approve"
		if err := s.store.DecideLoginRequest(id, approve, sess.UserID, time.Now()); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusConflict, "request already decided or expired")
				return
			}
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		actKind := AuditLoginPairDeny
		details := "denied device-pair from " + req.RequesterIP
		if approve {
			actKind = AuditLoginPairApprove
			details = "approved device-pair from " + req.RequesterIP
		}
		s.audit(r, store.AuditInfo, actKind, sess.Username, "", details)
		w.WriteHeader(http.StatusNoContent)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method or action not allowed")
	}
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
