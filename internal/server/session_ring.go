package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/noctalum/noctalum/internal/store"
)

// ----- multi-user session ring -----
//
// A browser may hold several logged-in Noctalum accounts at once so a shared
// station PC can flip between operators without anybody re-typing a password.
//
// The mechanism is a second cookie next to the active-session cookie:
//
//	noctalum_session   -> the session id that is *currently* active
//	noctalum_sessions  -> every session id this browser has logged in, oldest last
//
// Both cookies are HttpOnly + SameSite=Strict, so the session ids never reach
// JavaScript and never ride along on a cross-site request.  The ring is only
// ever a *cache of credentials this browser already earned*: nothing in it
// grants access on its own, because every id in it is a normal server-side
// session that expires on the normal schedule.  Listing the ring deliberately
// uses SessionStore.Peek (no TTL extension), so a parked account still hits the
// idle auto-logout at the usual time and simply drops out of the switcher.
//
// The frontend addresses ring members by user id, never by session id — see
// handleSessionSwitch.  That keeps the raw bearer tokens of the *other*
// accounts out of reach of any script running on the page.

const (
	sessionRingCookie = "noctalum_sessions"
	// maxRingSessions caps how many accounts a single browser can keep
	// warm.  Chiefly a cookie-size guard (each id is 48 hex chars); a
	// contest station realistically parks a handful of operators.
	maxRingSessions = 8
)

// readSessionRing returns the session ids cached in the browser, in ring
// order, with duplicates and empty entries removed.  It performs no
// validation — see (*Server).sessionRing for the resolved variant.
func readSessionRing(r *http.Request) []string {
	c, err := r.Cookie(sessionRingCookie)
	if err != nil || c.Value == "" {
		return nil
	}
	seen := make(map[string]bool)
	var out []string
	for _, id := range strings.Split(c.Value, ",") {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
		if len(out) >= maxRingSessions {
			break
		}
	}
	return out
}

// writeSessionRing persists the ring cookie (or deletes it when empty).
func writeSessionRing(w http.ResponseWriter, ids []string) {
	if len(ids) == 0 {
		http.SetCookie(w, &http.Cookie{
			Name:     sessionRingCookie,
			Value:    "",
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
			MaxAge:   -1,
		})
		return
	}
	if len(ids) > maxRingSessions {
		ids = ids[:maxRingSessions]
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionRingCookie,
		Value:    strings.Join(ids, ","),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

// sessionRing resolves the ring cookie into live sessions, dropping ids that
// no longer resolve (expired, logged out elsewhere, user deleted or disabled)
// and collapsing duplicate accounts down to the newest session per user.
// The returned ids slice is the pruned ring in the same order as sessions and
// is always safe to hand straight to writeSessionRing.
func (s *Server) sessionRing(r *http.Request) (sessions []*Session, ids []string) {
	seenUser := make(map[int64]bool)
	for _, id := range readSessionRing(r) {
		sess, ok := s.sessions.Peek(id)
		if !ok || seenUser[sess.UserID] {
			continue
		}
		seenUser[sess.UserID] = true
		sessions = append(sessions, sess)
		ids = append(ids, id)
	}
	return sessions, ids
}

// activateSession makes sess the browser's active login and records it in the
// ring.  Every login path (password, passkey, SSO, device pairing, first-run
// setup) funnels through here instead of calling SetSessionCookie directly, so
// each of them contributes to the account switcher.
//
// A second login as an account that is already cached supersedes the older
// session: it is dropped from the ring *and* deleted, since it belongs to this
// same browser and would otherwise linger unreachable until it expired.
func (s *Server) activateSession(w http.ResponseWriter, r *http.Request, sess *Session) {
	_, ids := s.sessionRing(r)
	next := []string{sess.ID}
	for _, id := range ids {
		if id == sess.ID {
			continue
		}
		other, ok := s.sessions.Peek(id)
		if !ok {
			continue
		}
		if other.UserID == sess.UserID {
			s.sessions.Delete(id)
			continue
		}
		next = append(next, id)
	}
	SetSessionCookie(w, sess.ID)
	writeSessionRing(w, next)
}

// ringWithout returns the ring minus one id, without touching the cookie, so
// the caller can decide what to keep before writing it exactly once.
func (s *Server) ringWithout(r *http.Request, drop string) []string {
	_, ids := s.sessionRing(r)
	var next []string
	for _, id := range ids {
		if id != drop {
			next = append(next, id)
		}
	}
	return next
}

// handleSessionList reports the accounts this browser currently has logged in.
//
// It is deliberately public: the login screen calls it while *no* session is
// active in order to offer the cached accounts instead of a bare password
// form.  Possession of the (HttpOnly, SameSite=Strict) ring cookie is the
// authorisation — the response carries no session ids and no CSRF tokens, only
// the display identity of logins this browser already holds.
func (s *Server) handleSessionList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET required")
		return
	}
	active, _ := s.sessions.SessionFromRequest(r)
	ring, ids := s.sessionRing(r)
	// Rewrite the cookie whenever pruning changed the ring so expired
	// accounts stop being offered on the next visit too.
	if len(ids) != len(readSessionRing(r)) {
		writeSessionRing(w, ids)
	}
	out := make([]map[string]any, 0, len(ring))
	for _, sess := range ring {
		out = append(out, map[string]any{
			"user_id":    sess.UserID,
			"username":   sess.Username,
			"callsign":   sess.Callsign,
			"active":     active != nil && sess.ID == active.ID,
			"expires_at": sess.ExpiresAt.UTC().Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

// handleSessionSwitch flips the active login to another account already cached
// in this browser's ring.  The target is named by user id, never by session id,
// so the switcher never has to expose one account's bearer token to the page
// that another account is looking at.
//
// CSRF: when a session is active its token is required, exactly as for any
// other mutating call.  When none is active (the login screen offering cached
// accounts) there is no token to present; the SameSite=Strict ring cookie is
// what stops a cross-site caller, and the worst a same-site forgery could
// achieve is activating a login the browser already owns.
func (s *Server) handleSessionSwitch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	if active, ok := s.sessions.SessionFromRequest(r); ok {
		if r.Header.Get("X-CSRF-Token") != active.CSRFToken {
			writeError(w, http.StatusForbidden, "invalid CSRF token")
			return
		}
	}
	var body struct {
		UserID int64 `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	ring, _ := s.sessionRing(r)
	var target *Session
	for _, sess := range ring {
		if sess.UserID == body.UserID {
			target = sess
			break
		}
	}
	if target == nil {
		writeError(w, http.StatusNotFound, "no cached login for that user")
		return
	}
	// Route through Get so the session we are about to use gets its TTL
	// extended and its last_seen refreshed, the same as any other request.
	// Peek deliberately does not, and a switch is real activity.
	sess, ok := s.sessions.Get(target.ID)
	if !ok {
		writeError(w, http.StatusNotFound, "cached login expired")
		return
	}
	s.activateSession(w, r, sess)
	s.audit(r, store.AuditInfo, AuditSessionSwitch, sess.Username, "", "account switcher")
	go s.store.TouchUserActivity(sess.UserID)
	writeJSON(w, http.StatusOK, sessionInfo(sess))
}
