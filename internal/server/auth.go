package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/noctalum/noctalum/internal/store"
	"golang.org/x/crypto/bcrypt"
)

const (
	sessionCookie        = "noctalum_session"
	sessionTTL           = 48 * time.Hour
	sessionTouchInterval = 5 * time.Minute
	maxFailedLogins      = 5
	lockoutDuration      = 5 * time.Minute
)

// Permission keys.  Add new ones here, then expose them in the UI.
const (
	PermQSOWrite              = "qso.write"
	PermQSOExport             = "qso.export"
	PermSettingsWrite         = "settings.write"
	PermUsersManage           = "users.manage"
	PermRigUse                = "rig.use"
	PermRigRelease            = "rig.release"
	PermContestsManage        = "contests.manage"
	PermContestsCreatePrivate = "contests.create_private"
	PermAuditLog              = "audit.log"
	PermFeatureRequestsRead   = "feature_requests.read"  // view/manage all requests
	PermFeatureRequestsWrite  = "feature_requests.write" // submit a request
)

// AllPermissions is the canonical list (used by UI + role validation).
var AllPermissions = []string{
	PermQSOWrite, PermQSOExport, PermSettingsWrite, PermUsersManage, PermRigUse, PermRigRelease, PermContestsManage, PermContestsCreatePrivate, PermAuditLog, PermFeatureRequestsRead, PermFeatureRequestsWrite,
}

// DefaultUserRolePermissions are the permissions assigned to the built-in
// "user" role on first startup.
var DefaultUserRolePermissions = []string{
	PermQSOWrite, PermQSOExport, PermRigUse, PermFeatureRequestsWrite,
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

// Session is a logged-in user.
type Session struct {
	ID          string
	UserID      int64
	Username    string
	Callsign    string
	Permissions []string
	CSRFToken   string
	CreatedAt   time.Time
	ExpiresAt   time.Time

	mu               sync.Mutex
	selectedRig      string
	contestID        int64
	contestStatus    string
	contestCall      string
	contestName      string
	contestQTH       string
	contestBands     string
	contestObjective string
	contestStationID string
	contestPrivate   bool
	contestOwnerID   int64
	contestFields    string // JSON array of CustomField
	contestQSOLayout string // JSON object describing the New QSO mask layout
	lastSeen         time.Time
	lastDBUpdate     time.Time // last time last_seen was flushed to DB
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

// ContestQTH returns the QTH locator of the selected contest.
func (s *Session) ContestQTH() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contestQTH
}

// ContestBands returns the comma-separated bands for the selected contest.
func (s *Session) ContestBands() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contestBands
}

// ContestObjective returns the markdown objective for the selected contest.
func (s *Session) ContestObjective() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contestObjective
}

// ContestStationID returns the contest station identifier (e.g. operator number).
func (s *Session) ContestStationID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contestStationID
}

// ContestPrivate reports whether the active contest is owner-private.
func (s *Session) ContestPrivate() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contestPrivate
}

// ContestOwnerID returns the user id of the contest owner (0 if not private).
func (s *Session) ContestOwnerID() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contestOwnerID
}

// ContestFields returns the JSON-encoded custom-field schema for the active contest.
func (s *Session) ContestFields() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contestFields
}

// ContestQSOLayout returns the JSON-encoded New QSO mask layout for the active contest.
func (s *Session) ContestQSOLayout() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.contestQSOLayout
}

// SetContest sets the active contest for this session (full version).
func (s *Session) SetContest(id int64, status, call, name, qth, bands, objective, stationID string, private bool, ownerID int64, fields, qsoLayout string) {
	s.mu.Lock()
	s.contestID = id
	s.contestStatus = status
	s.contestCall = call
	s.contestName = name
	s.contestQTH = qth
	s.contestBands = bands
	s.contestObjective = objective
	s.contestStationID = stationID
	s.contestPrivate = private
	s.contestOwnerID = ownerID
	s.contestFields = fields
	s.contestQSOLayout = qsoLayout
	s.mu.Unlock()
}

// ClearContest removes the active contest from this session.
func (s *Session) ClearContest() {
	s.mu.Lock()
	s.contestID = 0
	s.contestStatus = ""
	s.contestCall = ""
	s.contestName = ""
	s.contestQTH = ""
	s.contestBands = ""
	s.contestObjective = ""
	s.contestStationID = ""
	s.contestPrivate = false
	s.contestOwnerID = 0
	s.contestFields = ""
	s.contestQSOLayout = ""
	s.mu.Unlock()
}

// SessionStore is the in-memory session table backed by the database.
type SessionStore struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	db       *store.Store
}

// NewSessionStore returns a new session store backed by the given database.
func NewSessionStore(db *store.Store) *SessionStore {
	return &SessionStore{
		sessions: make(map[string]*Session),
		db:       db,
	}
}

// LoadFromDB populates the in-memory map from the database at startup.
// User data (permissions) is refreshed from the current DB state.
func (s *SessionStore) LoadFromDB() error {
	rows, err := s.db.LoadSessions()
	if err != nil {
		return err
	}
	now := time.Now()
	loaded := 0
	for _, row := range rows {
		if now.After(row.ExpiresAt) {
			continue
		}
		u, err := s.db.GetUserByID(row.UserID)
		if err != nil || u.Disabled {
			continue // skip sessions for deleted/disabled users
		}
		sess := &Session{
			ID:           row.ID,
			UserID:       row.UserID,
			Username:     u.Username,
			Callsign:     u.Callsign,
			Permissions:  append([]string{}, u.Permissions...),
			CSRFToken:    row.CSRFToken,
			CreatedAt:    row.CreatedAt,
			ExpiresAt:    row.ExpiresAt,
			lastSeen:     row.LastSeen,
			lastDBUpdate: now,
		}
		s.mu.Lock()
		s.sessions[row.ID] = sess
		s.mu.Unlock()
		loaded++
	}
	if loaded > 0 {
		log.Printf("restored %d session(s) from database", loaded)
	}
	return nil
}

// Create issues a new session for an authenticated user and persists it.
func (s *SessionStore) Create(u store.User) *Session {
	id := randomID(24)
	now := time.Now()
	sess := &Session{
		ID:           id,
		UserID:       u.ID,
		Username:     u.Username,
		Callsign:     u.Callsign,
		Permissions:  append([]string{}, u.Permissions...),
		CSRFToken:    randomID(24),
		CreatedAt:    now,
		ExpiresAt:    now.Add(sessionTTL),
		lastSeen:     now,
		lastDBUpdate: now,
	}
	s.mu.Lock()
	s.sessions[id] = sess
	s.mu.Unlock()

	row := store.SessionRow{
		ID:        id,
		UserID:    u.ID,
		CSRFToken: sess.CSRFToken,
		CreatedAt: sess.CreatedAt,
		LastSeen:  sess.lastSeen,
		ExpiresAt: sess.ExpiresAt,
	}
	if err := s.db.SaveSession(row); err != nil {
		log.Printf("persist session: %v", err)
	}
	return sess
}

// Get returns a session by ID, extending its TTL and refreshing the DB
// write at most every sessionTouchInterval.
func (s *SessionStore) Get(id string) (*Session, bool) {
	s.mu.Lock()
	sess, ok := s.sessions[id]
	if !ok {
		s.mu.Unlock()
		return nil, false
	}
	now := time.Now()
	if now.After(sess.ExpiresAt) {
		delete(s.sessions, id)
		s.mu.Unlock()
		_ = s.db.DeleteSession(id)
		return nil, false
	}
	sess.lastSeen = now
	newExpiry := now.Add(sessionTTL)
	sess.ExpiresAt = newExpiry
	needsDBFlush := now.Sub(sess.lastDBUpdate) >= sessionTouchInterval
	if needsDBFlush {
		sess.lastDBUpdate = now
	}
	s.mu.Unlock()

	if needsDBFlush {
		_ = s.db.TouchSession(id, now, newExpiry)
	}
	return sess, true
}

// Delete removes a session from memory and the database.
func (s *SessionStore) Delete(id string) {
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
	_ = s.db.DeleteSession(id)
}

// DeleteAllForUser removes every session for the given user from both memory
// and the database (called after password change or passkey revocation).
func (s *SessionStore) DeleteAllForUser(userID int64) {
	s.mu.Lock()
	for id, sess := range s.sessions {
		if sess.UserID == userID {
			delete(s.sessions, id)
		}
	}
	s.mu.Unlock()
	_ = s.db.DeleteSessionsForUser(userID)
}

// CleanExpired removes expired sessions from the in-memory map and the DB.
func (s *SessionStore) CleanExpired() {
	now := time.Now()
	s.mu.Lock()
	for id, sess := range s.sessions {
		if now.After(sess.ExpiresAt) {
			delete(s.sessions, id)
		}
	}
	s.mu.Unlock()
	_ = s.db.DeleteExpiredSessions()
}

// AllForUser returns every active session for a user.
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
func (s *SessionStore) UpdateContestOnSessions(contestID int64, status, call, name, qth, bands, objective, stationID string, private bool, ownerID int64, fields, qsoLayout string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, sess := range s.sessions {
		id, _, _, _ := sess.ContestInfo()
		if id == contestID {
			sess.SetContest(contestID, status, call, name, qth, bands, objective, stationID, private, ownerID, fields, qsoLayout)
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
		MaxAge:   int(sessionTTL.Seconds()),
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
