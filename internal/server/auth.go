package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/contestlog/contestlog/internal/store"
	"golang.org/x/crypto/bcrypt"
)

const (
	sessionCookie    = "contestlog_session"
	maxFailedLogins  = 5
	lockoutDuration  = 5 * time.Minute
)

// Permission keys.  Add new ones here, then expose them in the UI.
const (
	PermQSOWrite       = "qso.write"
	PermQSOExport      = "qso.export"
	PermSettingsWrite  = "settings.write"
	PermUsersManage    = "users.manage"
	PermRigUse         = "rig.use"
	PermContestsManage = "contests.manage"
	PermAuditLog       = "audit.log"
)

// AllPermissions is the canonical list (used by UI + role validation).
var AllPermissions = []string{
	PermQSOWrite, PermQSOExport, PermSettingsWrite, PermUsersManage, PermRigUse, PermContestsManage, PermAuditLog,
}

// DefaultUserRolePermissions are the permissions assigned to the built-in
// "user" role on first startup.
var DefaultUserRolePermissions = []string{
	PermQSOWrite, PermQSOExport, PermRigUse,
}

// HasPermission returns true if perms grants key (or wildcard).
func HasPermission(perms []string, key string) bool {
	for _, p := range perms {
		if p == "*" || p == key {
			return true
		}
	}
	return false
}

// Session is a logged-in user.  Sessions are kept in memory; restart forces
// re-login (acceptable trade-off for simpler revocation).
type Session struct {
	ID          string
	UserID      int64
	Username    string
	Callsign    string
	Permissions []string
	CSRFToken   string

	mu            sync.Mutex
	selectedRig   string
	contestID     int64
	contestStatus string
	contestCall   string
	contestName   string

	CreatedAt time.Time
	LastSeen  time.Time
}

// SelectedRig returns the rig name this session has bound to (or "" for none).
func (s *Session) SelectedRig() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.selectedRig
}

// SetSelectedRig changes the bound rig.
func (s *Session) SetSelectedRig(name string) {
	s.mu.Lock()
	s.selectedRig = name
	s.mu.Unlock()
}

// ContestInfo returns the contest fields atomically.
func (s *Session) ContestInfo() (id int64, status, call, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contestID, s.contestStatus, s.contestCall, s.contestName
}

// SetContest sets the active contest for this session.
func (s *Session) SetContest(id int64, status, call, name string) {
	s.mu.Lock()
	s.contestID = id
	s.contestStatus = status
	s.contestCall = call
	s.contestName = name
	s.mu.Unlock()
}

// ClearContest removes the active contest from this session.
func (s *Session) ClearContest() {
	s.mu.Lock()
	s.contestID = 0
	s.contestStatus = ""
	s.contestCall = ""
	s.contestName = ""
	s.mu.Unlock()
}

// SessionStore is an in-memory session table indexed by session ID.
type SessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

// NewSessionStore returns an empty store.
func NewSessionStore() *SessionStore {
	return &SessionStore{sessions: make(map[string]*Session)}
}

// Create issues a new session for an authenticated user.
func (s *SessionStore) Create(u store.User) *Session {
	id := randomID(24)
	sess := &Session{
		ID:          id,
		UserID:      u.ID,
		Username:    u.Username,
		Callsign:    u.Callsign,
		Permissions: append([]string{}, u.Permissions...),
		CSRFToken:   randomID(24),
		CreatedAt:   time.Now(),
		LastSeen:    time.Now(),
	}
	s.mu.Lock()
	s.sessions[id] = sess
	s.mu.Unlock()
	return sess
}

// Get returns a session by ID, refreshing its LastSeen.
func (s *SessionStore) Get(id string) (*Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if ok {
		sess.LastSeen = time.Now()
	}
	return sess, ok
}

// Delete removes a session.
func (s *SessionStore) Delete(id string) {
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
}

// AllForUser returns every active session for a user (used to forcefully
// log them out when their account is disabled or deleted).
func (s *SessionStore) AllForUser(userID int64) []*Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Session
	for _, sess := range s.sessions {
		if sess.UserID == userID {
			out = append(out, sess)
		}
	}
	return out
}

// RefreshUser updates the cached username/callsign/permissions on every
// active session belonging to userID after a user edit.
func (s *SessionStore) RefreshUser(u store.User) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sess := range s.sessions {
		if sess.UserID == u.ID {
			sess.Username = u.Username
			sess.Callsign = u.Callsign
			sess.Permissions = append([]string{}, u.Permissions...)
		}
	}
}

// UpdateContestOnSessions refreshes contest fields on every session that has
// the given contest selected (called after an admin edits a contest).
func (s *SessionStore) UpdateContestOnSessions(contestID int64, status, call, name string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, sess := range s.sessions {
		id, _, _, _ := sess.ContestInfo()
		if id == contestID {
			sess.SetContest(contestID, status, call, name)
		}
	}
}

// SessionFromRequest pulls the session cookie from r and looks it up.
func (s *SessionStore) SessionFromRequest(r *http.Request) (*Session, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil, false
	}
	return s.Get(c.Value)
}

// SetSessionCookie writes the session cookie on w.
func SetSessionCookie(w http.ResponseWriter, id string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   60 * 60 * 24,
	})
}

// ClearSessionCookie removes the session cookie.
func ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})
}

func randomID(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return time.Now().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(b)
}

// ----- login flow -----

// LoginErr classifies authentication failures so the handler can map them
// to HTTP responses without leaking detail to the client.
type LoginErr int

const (
	LoginOK LoginErr = iota
	LoginBadCredentials
	LoginLocked
	LoginDisabled
)

// AuthenticateUser checks username/password against the store, applying the
// lockout policy.  On success it returns the user.  On failure it returns one
// of the LoginErr codes (and, for LoginLocked, the time until unlock).
func AuthenticateUser(st *store.Store, username, password string) (store.User, LoginErr, time.Duration, error) {
	u, err := st.GetUserByUsername(username)
	if errors.Is(err, store.ErrNotFound) {
		// Run a bcrypt compare against a dummy hash so attackers cannot
		// distinguish unknown-username from wrong-password by timing.
		_ = bcrypt.CompareHashAndPassword(
			[]byte("$2a$12$CwTycUXWue0Thq9StjUM0uJ8.O.h3KqVA6n/3vpZf06o3Onh3I3HC"),
			[]byte(password))
		return store.User{}, LoginBadCredentials, 0, nil
	}
	if err != nil {
		return store.User{}, LoginBadCredentials, 0, err
	}
	if u.Disabled {
		return store.User{}, LoginDisabled, 0, nil
	}
	if u.LockedUntil != nil && u.LockedUntil.After(time.Now()) {
		return store.User{}, LoginLocked, time.Until(*u.LockedUntil), nil
	}
	if err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)); err != nil {
		failed, lockedAt, ferr := st.RecordLoginFailure(u.ID, maxFailedLogins, lockoutDuration)
		if ferr != nil {
			return store.User{}, LoginBadCredentials, 0, ferr
		}
		if lockedAt != nil {
			return store.User{}, LoginLocked, time.Until(*lockedAt), nil
		}
		_ = failed
		return store.User{}, LoginBadCredentials, 0, nil
	}
	if err := st.ClearLoginFailures(u.ID); err != nil {
		return store.User{}, LoginBadCredentials, 0, err
	}
	return u, LoginOK, 0, nil
}

// VerifyPassword checks a plain-text password against a stored hash.
// Used for self-service "change password" so users prove they know the old one.
func VerifyPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}
