package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/contestlog/contestlog/internal/store"
	"github.com/gorilla/websocket"
)

const (
	programID      = "ContestLog"
	programVersion = "0.3.0"
	dupWindow      = 10 * time.Minute
)

//go:embed web/*
var webFS embed.FS

// Server bundles every collaborating component.
type Server struct {
	store          *store.Store
	sessions       *SessionStore
	hub            *Hub
	rigs           *RigRegistry
	settings       store.Settings
	upgrader       websocket.Upgrader
	helperUpgrader websocket.Upgrader
	nrMu           sync.Mutex
	nrNext         map[int64]int // per-contest next serial number to assign
	qrz            *QRZClient
}

// New constructs and configures a Server, ensuring built-in roles + helper token.
func New(st *store.Store) (*Server, error) {
	s := &Server{
		store:    st,
		sessions: NewSessionStore(st),
		rigs:     NewRigRegistry(),
		upgrader: websocket.Upgrader{
			CheckOrigin:     checkSameOrigin,
			ReadBufferSize:  1024,
			WriteBufferSize: 4096,
		},
		// Helpers authenticate via token before the upgrade, so origin
		// checking (a browser CSRF defence) is not needed here.
		helperUpgrader: websocket.Upgrader{
			CheckOrigin:     func(*http.Request) bool { return true },
			ReadBufferSize:  1024,
			WriteBufferSize: 4096,
		},
	}
	s.hub = NewHub(s.handleInbound, s.handleBrowserGone, s.handleHelperGone)

	if err := st.EnsureBuiltinRoles(DefaultUserRolePermissions); err != nil {
		return nil, err
	}
	set, err := st.LoadSettings()
	if err != nil {
		return nil, err
	}
	if set.HelperToken == "" {
		tok := newToken()
		if err := st.SetHelperToken(tok); err != nil {
			return nil, err
		}
		set.HelperToken = tok
		log.Printf("generated helper token: %s (visible to admins in Settings)", tok)
	}
	s.settings = set
	if set.QRZUsername != "" && set.QRZPassword != "" {
		s.qrz = NewQRZClient(set.QRZUsername, set.QRZPassword)
	}

	if err := s.sessions.LoadFromDB(); err != nil {
		log.Printf("warning: could not restore sessions from DB: %v", err)
	}
	go s.sessionCleanupLoop(context.Background())

	n, _ := st.CountUsers()
	if n == 0 {
		log.Printf("first-run setup required — open the web UI to create the initial admin account")
	}
	return s, nil
}

func (s *Server) sessionCleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sessions.CleanExpired()
		}
	}
}

// Routes returns the configured HTTP handler.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// Public endpoints
	mux.HandleFunc("/api/setup", s.handleSetup)
	mux.HandleFunc("/api/login", s.handleLogin)
	mux.HandleFunc("/api/logout", s.handleLogout)
	mux.HandleFunc("/api/me", s.handleMe)
	mux.HandleFunc("/api/passkey/login/begin", s.handlePasskeyLoginBegin)
	mux.HandleFunc("/api/passkey/login/finish", s.handlePasskeyLoginFinish)

	// Authenticated
	mux.HandleFunc("/api/me/password", s.requireAuth(s.handleChangeOwnPassword))
	mux.HandleFunc("/api/passkey/register/begin", s.requireAuth(s.handlePasskeyRegisterBegin))
	mux.HandleFunc("/api/passkey/register/finish", s.requireAuth(s.handlePasskeyRegisterFinish))
	mux.HandleFunc("/api/passkey/credentials", s.requireAuth(s.handlePasskeyCredentials))
	mux.HandleFunc("/api/passkey/credentials/", s.requireAuth(s.handlePasskeyCredentials))
	mux.HandleFunc("/api/qsos", s.requireAuth(s.handleQSOs))
	mux.HandleFunc("/api/qsos/reserve-nr", s.requireAuth(s.handleReserveNr))
	mux.HandleFunc("/api/qsos/", s.requireAuth(s.handleQSOByID))
	mux.HandleFunc("/api/operators", s.requireAuth(s.handleOperators))
	mux.HandleFunc("/api/rigs", s.requireAuth(s.handleRigs))
	mux.HandleFunc("/api/rigs/select", s.requireAuth(s.handleSelectRig))

	// Permission-gated
	mux.HandleFunc("/api/settings", s.requireAuth(s.handleSettings))
	mux.HandleFunc("/api/lookup/picture", s.requireAuth(s.handleLookupPicture))
	mux.HandleFunc("/api/lookup", s.requireAuth(s.handleLookup))
	mux.HandleFunc("/api/permissions", s.requireAuth(s.handlePermissions))
	mux.HandleFunc("/api/users", s.requirePerm(PermUsersManage, s.handleUsers))
	mux.HandleFunc("/api/users/", s.requirePerm(PermUsersManage, s.handleUserByID))
	mux.HandleFunc("/api/roles", s.requirePerm(PermUsersManage, s.handleRoles))
	mux.HandleFunc("/api/roles/", s.requirePerm(PermUsersManage, s.handleRoleByID))
	mux.HandleFunc("/api/contests", s.requireAuth(s.handleContests))
	mux.HandleFunc("/api/contests/", s.requireAuth(s.handleContestByID))
	mux.HandleFunc("/api/export/adif", s.requirePerm(PermQSOExport, s.handleExportADIF))
	mux.HandleFunc("/api/export/cabrillo", s.requirePerm(PermQSOExport, s.handleExportCabrillo))
	mux.HandleFunc("/api/export/csv", s.requirePerm(PermQSOExport, s.handleExportCSV))
	mux.HandleFunc("/api/audit", s.requirePerm(PermAuditLog, s.handleAuditLog))

	// WebSocket — auth-checked inside (browser uses cookie, helper uses token).
	mux.HandleFunc("/ws", s.handleWS)

	sub, _ := fs.Sub(webFS, "web")
	mux.Handle("/", http.FileServer(http.FS(sub)))

	return securityHeadersMiddleware(logMiddleware(mux))
}

// Shutdown is currently a no-op.
func (s *Server) Shutdown() {}

// ----- inbound websocket dispatch -----

type wsMsg struct {
	Type   string `json:"type"`
	FreqHz int64  `json:"freq_hz"`
	Mode   string `json:"mode"`
	Error  string `json:"error"`
	Name   string `json:"name"`
}

func (s *Server) handleInbound(c *client, raw []byte) {
	var m wsMsg
	if err := json.Unmarshal(raw, &m); err != nil {
		return
	}
	switch {
	case c.role == RoleHelper && m.Type == "rig_update":
		s.rigs.Update(c.rigName, m.FreqHz, m.Mode, m.Error)
		s.broadcastRigs()
	case c.role == RoleBrowser && m.Type == "select_rig":
		c.session.SetSelectedRig(m.Name)
		s.broadcastRigs()
	}
}

func (s *Server) handleBrowserGone(_, selectedRig string) {
	s.hub.Broadcast(Event{Type: "operators", Payload: s.hub.Operators()})
	if selectedRig != "" {
		s.broadcastRigs()
	}
}

func (s *Server) handleHelperGone(rigName string) {
	if s.rigs.HelperLeft(rigName) {
		// Other helpers still feeding this rig name; nothing to remove.
	}
	s.broadcastRigs()
}

func (s *Server) broadcastRigs() {
	rigs := s.rigs.All(s.hub.BrowsersSelectingRig)
	s.hub.Broadcast(Event{Type: "rigs", Payload: rigs})
}

// ----- middleware -----

func logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
	})
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

// checkSameOrigin rejects WebSocket upgrades that originate from a different host.
func checkSameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return u.Host == r.Host
}

func isMutatingMethod(method string) bool {
	return method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions
}

func (s *Server) requireAuth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := s.sessions.SessionFromRequest(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "not logged in")
			return
		}
		if isMutatingMethod(r.Method) && r.Header.Get("X-CSRF-Token") != sess.CSRFToken {
			writeError(w, http.StatusForbidden, "invalid CSRF token")
			return
		}
		h(w, r)
	}
}

func (s *Server) requirePerm(perm string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := s.sessions.SessionFromRequest(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "not logged in")
			return
		}
		if isMutatingMethod(r.Method) && r.Header.Get("X-CSRF-Token") != sess.CSRFToken {
			writeError(w, http.StatusForbidden, "invalid CSRF token")
			return
		}
		if !HasPermission(sess.Permissions, perm) {
			s.audit(r, store.AuditError, AuditAccessDenied, sess.Username, perm,
				r.Method+" "+r.URL.Path)
			writeError(w, http.StatusForbidden, "missing permission: "+perm)
			return
		}
		h(w, r)
	}
}

func sessionFor(s *Server, r *http.Request) *Session {
	sess, _ := s.sessions.SessionFromRequest(r)
	return sess
}

// ----- helpers -----

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func newToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ----- setup / login / me -----

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	n, err := s.store.CountUsers()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if n != 0 {
		writeError(w, http.StatusConflict, "setup already completed")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Callsign string `json:"callsign"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	body.Callsign = strings.ToUpper(strings.TrimSpace(body.Callsign))
	if !ValidCallsign(body.Callsign) {
		writeError(w, http.StatusBadRequest, "invalid callsign")
		return
	}
	if len(body.Password) < 8 {
		writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	u, err := s.store.CreateUser(body.Username, body.Callsign, body.Password, []string{"admin"})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.audit(r, store.AuditInfo, AuditUserCreate, "system", u.Username,
		"callsign: "+u.Callsign+", roles: admin (first-run setup)")
	sess := s.sessions.Create(u)
	SetSessionCookie(w, sess.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"username": u.Username, "callsign": u.Callsign,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	u, code, lockFor, err := AuthenticateUser(s.store, body.Username, body.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	switch code {
	case LoginOK:
		s.audit(r, store.AuditInfo, AuditLoginSuccess, u.Username, "", "password")
		sess := s.sessions.Create(u)
		SetSessionCookie(w, sess.ID)
		writeJSON(w, http.StatusOK, sessionInfo(sess))
	case LoginLocked:
		s.audit(r, store.AuditWarn, AuditLoginLocked, body.Username, "",
			fmt.Sprintf("locked for %ds", int(lockFor.Round(time.Second).Seconds())))
		writeJSON(w, http.StatusLocked, map[string]any{
			"error":          "account locked",
			"locked_seconds": int(lockFor.Round(time.Second).Seconds()),
		})
	case LoginDisabled:
		s.audit(r, store.AuditWarn, AuditLoginDisabled, body.Username, "", "")
		writeError(w, http.StatusForbidden, "account disabled")
	default:
		s.audit(r, store.AuditWarn, AuditLoginFailure, body.Username, "", "bad credentials")
		writeError(w, http.StatusUnauthorized, "invalid username or password")
	}
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		ClearSessionCookie(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	sess, ok := s.sessions.Get(c.Value)
	if !ok {
		ClearSessionCookie(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Header.Get("X-CSRF-Token") != sess.CSRFToken {
		writeError(w, http.StatusForbidden, "invalid CSRF token")
		return
	}
	s.audit(r, store.AuditInfo, AuditLogout, sess.Username, "", "")
	s.sessions.Delete(c.Value)
	ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.sessions.SessionFromRequest(r)
	if !ok {
		// If the database has no users, advertise setup mode so the UI can react.
		n, _ := s.store.CountUsers()
		if n == 0 {
			writeJSON(w, http.StatusOK, map[string]any{"setup_required": true})
			return
		}
		writeError(w, http.StatusUnauthorized, "not logged in")
		return
	}
	writeJSON(w, http.StatusOK, sessionInfo(sess))
}

func sessionInfo(sess *Session) map[string]any {
	contestID, contestStatus, contestCall, contestName := sess.ContestInfo()
	return map[string]any{
		"username":       sess.Username,
		"callsign":       sess.Callsign,
		"permissions":    sess.Permissions,
		"selected_rig":   sess.SelectedRig(),
		"csrf_token":     sess.CSRFToken,
		"contest_id":     contestID,
		"contest_status": contestStatus,
		"contest_call":   contestCall,
		"contest_name":   contestName,
	}
}

func (s *Server) handleChangeOwnPassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sess := sessionFor(s, r)
	var body struct{ Old, New string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	u, err := s.store.GetUserByID(sess.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !VerifyPassword(u.PasswordHash, body.Old) {
		writeError(w, http.StatusUnauthorized, "current password is wrong")
		return
	}
	if len(body.New) < 8 {
		writeError(w, http.StatusBadRequest, "new password too short")
		return
	}
	if err := s.store.SetPassword(sess.UserID, body.New); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.audit(r, store.AuditInfo, AuditUserPasswordChange, sess.Username, sess.Username, "own password changed")
	s.sessions.DeleteAllForUser(sess.UserID)
	ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

// ----- /api/me settings/qsos/operators -----

func (s *Server) handleOperators(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.hub.Operators())
}

func (s *Server) handlePermissions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, AllPermissions)
}

// ----- QSOs -----

func (s *Server) handleQSOs(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	contestID, _, _, _ := sess.ContestInfo()
	if contestID == 0 {
		writeError(w, http.StatusBadRequest, "no contest selected")
		return
	}
	switch r.Method {
	case http.MethodGet:
		limit := 1000
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				limit = n
			}
		}
		qsos, err := s.store.ListQSOs(contestID, limit)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, qsos)
	case http.MethodPost:
		s.handleCreateQSO(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleReserveNr(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	sess := sessionFor(s, r)
	if !HasPermission(sess.Permissions, PermQSOWrite) {
		writeError(w, http.StatusForbidden, "missing permission: "+PermQSOWrite)
		return
	}
	contestID, contestStatus, _, _ := sess.ContestInfo()
	if contestID == 0 {
		writeError(w, http.StatusBadRequest, "no contest selected")
		return
	}
	if contestStatus == "finished" {
		writeError(w, http.StatusForbidden, "contest is finished")
		return
	}

	s.nrMu.Lock()
	if s.nrNext == nil {
		s.nrNext = make(map[int64]int)
	}
	if _, ok := s.nrNext[contestID]; !ok {
		maxNr, err := s.store.MaxNrSent(contestID)
		if err != nil {
			s.nrMu.Unlock()
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.nrNext[contestID] = maxNr + 1
	}
	nr := s.nrNext[contestID]
	s.nrNext[contestID]++
	s.nrMu.Unlock()

	writeJSON(w, http.StatusOK, map[string]int{"nr": nr})
}

func (s *Server) handleCreateQSO(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	if !HasPermission(sess.Permissions, PermQSOWrite) {
		writeError(w, http.StatusForbidden, "missing permission: "+PermQSOWrite)
		return
	}
	contestID, contestStatus, contestCall, contestName := sess.ContestInfo()
	if contestID == 0 {
		writeError(w, http.StatusBadRequest, "no contest selected")
		return
	}
	if contestStatus == "finished" {
		writeError(w, http.StatusForbidden, "contest is finished (read-only)")
		return
	}
	var in store.QSO
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	in.Callsign = strings.ToUpper(strings.TrimSpace(in.Callsign))
	in.Operator = sess.Callsign
	in.ContestID = contestID
	in.StationCall = contestCall
	in.ContestName = contestName

	if !ValidCallsign(in.Callsign) {
		writeError(w, http.StatusBadRequest, "invalid contacted callsign")
		return
	}
	if in.Mode == "" {
		writeError(w, http.StatusBadRequest, "mode required")
		return
	}
	if in.RSTSent == "" {
		in.RSTSent = DefaultRST(in.Mode)
	}
	if in.RSTReceived == "" {
		in.RSTReceived = DefaultRST(in.Mode)
	}
	if !ValidReport(in.RSTSent, in.Mode) {
		writeError(w, http.StatusBadRequest, "RST sent invalid for mode "+in.Mode)
		return
	}
	if !ValidReport(in.RSTReceived, in.Mode) {
		writeError(w, http.StatusBadRequest, "RST received invalid for mode "+in.Mode)
		return
	}
	if !ValidLocator(in.Locator) {
		writeError(w, http.StatusBadRequest, "invalid Maidenhead locator")
		return
	}
	if !ValidZone(in.ITUZone) {
		writeError(w, http.StatusBadRequest, "invalid ITU zone")
		return
	}
	if !ValidZone(in.CQZone) {
		writeError(w, http.StatusBadRequest, "invalid CQ zone")
		return
	}
	if in.FreqHz < 0 {
		writeError(w, http.StatusBadRequest, "invalid frequency")
		return
	}
	if in.Band == "" && in.FreqHz > 0 {
		in.Band = BandFromHz(in.FreqHz)
	}
	if in.Band == "" {
		writeError(w, http.StatusBadRequest, "band could not be determined")
		return
	}
	if in.Time.IsZero() {
		in.Time = time.Now().UTC()
	}

	dup, err := s.store.FindDuplicate(contestID, in.Callsign, in.Band, in.Mode, dupWindow)
	if err == nil && dup && r.URL.Query().Get("force") != "1" {
		writeError(w, http.StatusConflict, "possible duplicate within "+dupWindow.String())
		return
	}
	id, err := s.store.InsertQSO(&in)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	in.ID = id
	s.hub.BroadcastToContest(contestID, Event{Type: "qso", Payload: in})
	writeJSON(w, http.StatusCreated, in)
}

func (s *Server) handleQSOByID(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	if !HasPermission(sess.Permissions, PermQSOWrite) {
		writeError(w, http.StatusForbidden, "missing permission: "+PermQSOWrite)
		return
	}
	contestID, contestStatus, _, _ := sess.ContestInfo()
	if contestStatus == "finished" {
		writeError(w, http.StatusForbidden, "contest is finished (read-only)")
		return
	}
	idStr := strings.TrimPrefix(r.URL.Path, "/api/qsos/")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "DELETE only")
		return
	}
	if err := s.store.DeleteQSO(id); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.BroadcastToContest(contestID, Event{Type: "qso_deleted", Payload: map[string]int64{"id": id}})
	w.WriteHeader(http.StatusNoContent)
}

// ----- settings -----

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	switch r.Method {
	case http.MethodGet:
		out := map[string]any{
			"default_mode": s.settings.DefaultMode,
			"default_band": s.settings.DefaultBand,
		}
		if HasPermission(sess.Permissions, PermSettingsWrite) {
			out["helper_token"] = s.settings.HelperToken
			out["qrz_username"] = s.settings.QRZUsername
			out["qrz_configured"] = s.settings.QRZPassword != ""
		}
		writeJSON(w, http.StatusOK, out)
	case http.MethodPut:
		if !HasPermission(sess.Permissions, PermSettingsWrite) {
			writeError(w, http.StatusForbidden, "missing permission: "+PermSettingsWrite)
			return
		}
		var in struct {
			DefaultMode      string `json:"default_mode"`
			DefaultBand      string `json:"default_band"`
			RegenHelperToken bool   `json:"regen_helper_token"`
			QRZUsername      string `json:"qrz_username"`
			QRZPassword      string `json:"qrz_password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		ns := store.Settings{
			DefaultMode: in.DefaultMode,
			DefaultBand: in.DefaultBand,
			HelperToken: s.settings.HelperToken,
			QRZUsername: in.QRZUsername,
			QRZPassword: s.settings.QRZPassword, // keep existing if not provided
		}
		if in.RegenHelperToken {
			ns.HelperToken = newToken()
		}
		if in.QRZPassword != "" {
			ns.QRZPassword = in.QRZPassword
		}
		if err := s.store.SaveSettings(ns); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.settings = ns
		if ns.QRZUsername != "" && ns.QRZPassword != "" {
			s.qrz = NewQRZClient(ns.QRZUsername, ns.QRZPassword)
		} else {
			s.qrz = nil
		}
		details := "mode: " + ns.DefaultMode + ", band: " + ns.DefaultBand
		if in.RegenHelperToken {
			details += ", helper_token: regenerated"
		}
		if in.QRZUsername != "" {
			details += ", qrz_username: " + in.QRZUsername
		}
		s.audit(r, store.AuditInfo, AuditSettingsChange, sess.Username, "", details)
		out := map[string]any{"status": "ok"}
		if in.RegenHelperToken {
			out["helper_token"] = ns.HelperToken
		}
		writeJSON(w, http.StatusOK, out)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// ----- qrz lookup -----

func (s *Server) handleLookup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	callsign := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("callsign")))
	if callsign == "" {
		writeError(w, http.StatusBadRequest, "callsign required")
		return
	}
	if s.qrz == nil {
		writeJSON(w, http.StatusOK, map[string]any{"name": "", "locator": "", "has_picture": false, "configured": false})
		return
	}
	result, err := s.qrz.Lookup(callsign)
	if err != nil {
		log.Printf("qrz lookup %s: %v", callsign, err)
		writeJSON(w, http.StatusOK, map[string]any{"name": "", "locator": "", "has_picture": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"name":        result.Name,
		"locator":     result.Locator,
		"has_picture": result.HasPic,
	})
}

func (s *Server) handleLookupPicture(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	callsign := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("callsign")))
	if callsign == "" || s.qrz == nil {
		http.NotFound(w, r)
		return
	}
	picURL := s.qrz.PictureURL(callsign)
	if picURL == "" {
		http.NotFound(w, r)
		return
	}
	resp, err := http.Get(picURL) //nolint:noctx
	if err != nil || resp.StatusCode != http.StatusOK {
		http.NotFound(w, r)
		return
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	io.Copy(w, resp.Body) //nolint:errcheck
}

// ----- rigs -----

func (s *Server) handleRigs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.rigs.All(s.hub.BrowsersSelectingRig))
}

func (s *Server) handleSelectRig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sess := sessionFor(s, r)
	if !HasPermission(sess.Permissions, PermRigUse) {
		writeError(w, http.StatusForbidden, "missing permission: "+PermRigUse)
		return
	}
	var body struct{ Name string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	sess.SetSelectedRig(strings.TrimSpace(body.Name))
	s.broadcastRigs()
	writeJSON(w, http.StatusOK, map[string]string{"selected_rig": sess.SelectedRig()})
}

// ----- users -----

func (s *Server) handleUsers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		users, err := s.store.ListUsers()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, users)
	case http.MethodPost:
		var in struct {
			Username string   `json:"username"`
			Password string   `json:"password"`
			Callsign string   `json:"callsign"`
			Roles    []string `json:"roles"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if !ValidCallsign(in.Callsign) {
			writeError(w, http.StatusBadRequest, "invalid callsign")
			return
		}
		if len(in.Password) < 8 {
			writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}
		if len(in.Roles) == 0 {
			in.Roles = []string{"user"}
		}
		u, err := s.store.CreateUser(in.Username, in.Callsign, in.Password, in.Roles)
		if err != nil {
			if errors.Is(err, store.ErrUsernameTaken) {
				writeError(w, http.StatusConflict, err.Error())
				return
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		actor := sessionFor(s, r)
		s.audit(r, store.AuditInfo, AuditUserCreate, actor.Username, u.Username,
			"callsign: "+u.Callsign+", roles: "+strings.Join(in.Roles, ","))
		writeJSON(w, http.StatusCreated, u)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleUserByID(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	rest := strings.TrimPrefix(r.URL.Path, "/api/users/")
	parts := strings.SplitN(rest, "/", 2)
	idStr := parts[0]
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	target, err := s.store.GetUserByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	sub := ""
	if len(parts) == 2 {
		sub = parts[1]
	}

	switch {
	case r.Method == http.MethodPut && sub == "":
		// update roles, callsign, disabled
		var in struct {
			Roles    []string `json:"roles"`
			Callsign string   `json:"callsign"`
			Disabled *bool    `json:"disabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if in.Callsign != "" {
			if !ValidCallsign(in.Callsign) {
				writeError(w, http.StatusBadRequest, "invalid callsign")
				return
			}
			if err := s.store.SetCallsign(id, in.Callsign); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		if in.Roles != nil {
			// Prevent removing the last admin.
			if id == sess.UserID && !contains(in.Roles, "admin") && contains(target.Roles, "admin") {
				if n, _ := s.store.CountAdmins(); n <= 1 {
					writeError(w, http.StatusBadRequest, "cannot remove the only admin")
					return
				}
			}
			if err := s.store.SetUserRoles(id, in.Roles); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		if in.Disabled != nil {
			if id == sess.UserID && *in.Disabled {
				writeError(w, http.StatusBadRequest, "you cannot disable yourself")
				return
			}
			if err := s.store.SetDisabled(id, *in.Disabled); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if *in.Disabled {
				s.sessions.DeleteAllForUser(id)
				s.audit(r, store.AuditWarn, AuditUserDisable, sess.Username, target.Username, "")
			} else {
				s.audit(r, store.AuditInfo, AuditUserEnable, sess.Username, target.Username, "")
			}
		}
		if in.Roles != nil {
			s.audit(r, store.AuditInfo, AuditUserRolesChange, sess.Username, target.Username,
				"roles: "+strings.Join(in.Roles, ","))
		}
		// Refresh cached session permissions for any affected sessions.
		if u, err := s.store.GetUserByID(id); err == nil {
			s.sessions.RefreshUser(u)
		}
		w.WriteHeader(http.StatusNoContent)

	case r.Method == http.MethodPost && sub == "password":
		var in struct{ Password string }
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if len(in.Password) < 8 {
			writeError(w, http.StatusBadRequest, "password too short")
			return
		}
		if err := s.store.SetPassword(id, in.Password); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.audit(r, store.AuditWarn, AuditUserPasswordReset, sess.Username, target.Username, "admin reset")
		s.sessions.DeleteAllForUser(id)
		w.WriteHeader(http.StatusNoContent)

	case r.Method == http.MethodPost && sub == "unlock":
		if err := s.store.UnlockUser(id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.audit(r, store.AuditInfo, AuditUserUnlock, sess.Username, target.Username, "")
		w.WriteHeader(http.StatusNoContent)

	case r.Method == http.MethodDelete && sub == "":
		if id == sess.UserID {
			writeError(w, http.StatusBadRequest, "you cannot delete yourself")
			return
		}
		if contains(target.Roles, "admin") {
			if n, _ := s.store.CountAdmins(); n <= 1 {
				writeError(w, http.StatusBadRequest, "cannot delete the only admin")
				return
			}
		}
		if err := s.store.DeleteUser(id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.sessions.DeleteAllForUser(id)
		s.audit(r, store.AuditWarn, AuditUserDelete, sess.Username, target.Username,
			"callsign: "+target.Callsign)
		w.WriteHeader(http.StatusNoContent)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func contains(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}

// ----- roles -----

func (s *Server) handleRoles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		roles, err := s.store.ListRoles()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, roles)
	case http.MethodPost:
		var in struct {
			Name        string   `json:"name"`
			Permissions []string `json:"permissions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		// Validate permissions against the known set.
		for _, p := range in.Permissions {
			if !contains(AllPermissions, p) {
				writeError(w, http.StatusBadRequest, "unknown permission: "+p)
				return
			}
		}
		role, err := s.store.CreateRole(in.Name, in.Permissions)
		if err != nil {
			if errors.Is(err, store.ErrRoleNameTaken) {
				writeError(w, http.StatusConflict, err.Error())
				return
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		actor := sessionFor(s, r)
		s.audit(r, store.AuditInfo, AuditRoleCreate, actor.Username, role.Name,
			"permissions: "+strings.Join(in.Permissions, ","))
		writeJSON(w, http.StatusCreated, role)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleRoleByID(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/api/roles/")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid role id")
		return
	}
	switch r.Method {
	case http.MethodPut:
		var in struct {
			Permissions []string `json:"permissions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		for _, p := range in.Permissions {
			if !contains(AllPermissions, p) {
				writeError(w, http.StatusBadRequest, "unknown permission: "+p)
				return
			}
		}
		roleBeforeEdit, _ := s.store.GetRoleByID(id) // best-effort for details
		if err := s.store.UpdateRolePermissions(id, in.Permissions); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		// Re-cache permissions on every session of every user of this role.
		users, _ := s.store.ListUsers()
		for _, u := range users {
			s.sessions.RefreshUser(u)
		}
		actor := sessionFor(s, r)
		s.audit(r, store.AuditWarn, AuditRolePermsChange, actor.Username, roleBeforeEdit.Name,
			"permissions: "+strings.Join(in.Permissions, ","))
		w.WriteHeader(http.StatusNoContent)
	case http.MethodDelete:
		roleName := idStr
		if role, err := s.store.GetRoleByID(id); err == nil {
			roleName = role.Name
		}
		if err := s.store.DeleteRole(id); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		actor := sessionFor(s, r)
		s.audit(r, store.AuditWarn, AuditRoleDelete, actor.Username, roleName, "")
		w.WriteHeader(http.StatusNoContent)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// ----- contests -----

func (s *Server) handleContests(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		contests, err := s.store.ListContests()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if contests == nil {
			contests = []store.Contest{}
		}
		writeJSON(w, http.StatusOK, contests)
	case http.MethodPost:
		sess := sessionFor(s, r)
		if !HasPermission(sess.Permissions, PermContestsManage) {
			writeError(w, http.StatusForbidden, "missing permission: "+PermContestsManage)
			return
		}
		var in struct {
			Name        string `json:"name"`
			StationCall string `json:"station_call"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if strings.TrimSpace(in.Name) == "" {
			writeError(w, http.StatusBadRequest, "contest name required")
			return
		}
		if !ValidCallsign(in.StationCall) {
			writeError(w, http.StatusBadRequest, "invalid station callsign")
			return
		}
		c, err := s.store.CreateContest(in.Name, in.StationCall)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		contestSess := sessionFor(s, r)
		s.audit(r, store.AuditInfo, AuditContestCreate, contestSess.Username, in.Name,
			"call: "+in.StationCall)
		writeJSON(w, http.StatusCreated, c)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) handleContestByID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/contests/")
	parts := strings.SplitN(rest, "/", 2)
	idStr := parts[0]
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid contest id")
		return
	}
	sub := ""
	if len(parts) == 2 {
		sub = parts[1]
	}

	if sub == "select" {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "POST required")
			return
		}
		c, err := s.store.GetContest(id)
		if errors.Is(err, store.ErrContestNotFound) {
			writeError(w, http.StatusNotFound, "contest not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		sess := sessionFor(s, r)
		sess.SetContest(c.ID, c.Status, c.StationCall, c.Name)
		s.hub.Broadcast(Event{Type: "operators", Payload: s.hub.Operators()})
		writeJSON(w, http.StatusOK, map[string]any{
			"contest_id":     c.ID,
			"contest_status": c.Status,
			"contest_call":   c.StationCall,
			"contest_name":   c.Name,
		})
		return
	}

	// PUT — update contest (contests.manage required)
	if r.Method == http.MethodPut {
		sess := sessionFor(s, r)
		if !HasPermission(sess.Permissions, PermContestsManage) {
			writeError(w, http.StatusForbidden, "missing permission: "+PermContestsManage)
			return
		}
		var in struct {
			Name        string `json:"name"`
			StationCall string `json:"station_call"`
			Status      string `json:"status"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if strings.TrimSpace(in.Name) == "" {
			writeError(w, http.StatusBadRequest, "contest name required")
			return
		}
		if !ValidCallsign(in.StationCall) {
			writeError(w, http.StatusBadRequest, "invalid station callsign")
			return
		}
		if in.Status != "open" && in.Status != "finished" {
			writeError(w, http.StatusBadRequest, "status must be 'open' or 'finished'")
			return
		}
		if err := s.store.UpdateContest(id, in.Name, in.StationCall, in.Status); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		contestUpdSess := sessionFor(s, r)
		s.audit(r, store.AuditInfo, AuditContestUpdate, contestUpdSess.Username, in.Name,
			"status: "+in.Status+", call: "+strings.ToUpper(in.StationCall))
		// Propagate to any sessions that have this contest selected.
		s.sessions.UpdateContestOnSessions(id, in.Status, strings.ToUpper(in.StationCall), in.Name)
		s.hub.Broadcast(Event{Type: "contest_updated", Payload: map[string]any{
			"id":           id,
			"name":         in.Name,
			"station_call": strings.ToUpper(in.StationCall),
			"status":       in.Status,
		}})
		w.WriteHeader(http.StatusNoContent)
		return
	}

	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
}

// ----- exports -----

func (s *Server) handleExportADIF(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	contestID, _, _, contestName := sess.ContestInfo()
	if contestID == 0 {
		writeError(w, http.StatusBadRequest, "no contest selected")
		return
	}
	qsos, err := s.store.AllQSOs(contestID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.audit(r, store.AuditInfo, AuditExport, sess.Username, contestName, "format: ADIF")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="contestlog.adi"`)
	if err := ExportADIF(w, qsos, programID, programVersion); err != nil {
		log.Printf("ADIF export error: %v", err)
	}
}

func (s *Server) handleExportCabrillo(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	contestID, _, contestCall, contestName := sess.ContestInfo()
	if contestID == 0 {
		writeError(w, http.StatusBadRequest, "no contest selected")
		return
	}
	qsos, err := s.store.AllQSOs(contestID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.audit(r, store.AuditInfo, AuditExport, sess.Username, contestName, "format: Cabrillo")
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="contestlog.cbr"`)
	if err := ExportCabrillo(w, qsos, contestName, contestCall); err != nil {
		log.Printf("Cabrillo export error: %v", err)
	}
}

func (s *Server) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)
	contestID, _, _, contestName := sess.ContestInfo()
	if contestID == 0 {
		writeError(w, http.StatusBadRequest, "no contest selected")
		return
	}
	qsos, err := s.store.AllQSOs(contestID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.audit(r, store.AuditInfo, AuditExport, sess.Username, contestName, "format: CSV")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="contestlog.csv"`)
	if err := ExportCSV(w, qsos); err != nil {
		log.Printf("CSV export error: %v", err)
	}
}

// handleWS upgrades the connection.  Browsers authenticate with a session
// cookie; helpers identify themselves via ?role=helper&name=<rigName>&token=<helperToken>.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("role") == "helper" {
		s.handleWSHelper(w, r, q)
		return
	}
	s.handleWSBrowser(w, r)
}

func (s *Server) handleWSHelper(w http.ResponseWriter, r *http.Request, q map[string][]string) {
	name := strings.TrimSpace(getQ(q, "name"))
	token := getQ(q, "token")
	if name == "" {
		http.Error(w, "rig name required", http.StatusBadRequest)
		return
	}
	if s.settings.HelperToken == "" || subtle.ConstantTimeCompare([]byte(token), []byte(s.settings.HelperToken)) != 1 {
		http.Error(w, "invalid helper token", http.StatusUnauthorized)
		return
	}
	conn, err := s.helperUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade (helper): %v", err)
		return
	}
	c := &client{
		hub:     s.hub,
		conn:    conn,
		role:    RoleHelper,
		rigName: name,
		send:    make(chan []byte, 32),
	}
	s.rigs.HelperJoined(name)
	s.hub.add(c)
	s.broadcastRigs()
	go c.writePump()
	go c.readPump()
}

func (s *Server) handleWSBrowser(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.sessions.SessionFromRequest(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade (browser): %v", err)
		return
	}
	c := &client{
		hub:     s.hub,
		conn:    conn,
		role:    RoleBrowser,
		session: sess,
		send:    make(chan []byte, 64),
	}
	s.hub.add(c)
	// Initial state push: operators list, full rig list.
	if data, err := json.Marshal(Event{Type: "operators", Payload: s.hub.Operators()}); err == nil {
		select {
		case c.send <- data:
		default:
		}
	}
	if data, err := json.Marshal(Event{Type: "rigs", Payload: s.rigs.All(s.hub.BrowsersSelectingRig)}); err == nil {
		select {
		case c.send <- data:
		default:
		}
	}
	// Re-broadcast operators because a new browser is connecting.
	s.hub.Broadcast(Event{Type: "operators", Payload: s.hub.Operators()})
	go c.writePump()
	go c.readPump()
	_ = fmt.Sprintf
}

func getQ(q map[string][]string, key string) string {
	if v, ok := q[key]; ok && len(v) > 0 {
		return v[0]
	}
	return ""
}
