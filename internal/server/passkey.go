package server

import (
	"encoding/binary"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/contestlog/contestlog/internal/store"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

const (
	passkeySessionCookie = "wn_session"
	passkeySessionTTL    = 5 * time.Minute
)

// waForRequest creates a per-request WebAuthn instance with RPID derived from
// the Host header. This handles non-standard ports and reverse proxies.
func waForRequest(r *http.Request) (*webauthn.WebAuthn, error) {
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return webauthn.New(&webauthn.Config{
		RPDisplayName: "ContestLog",
		RPID:          host,
		RPOrigins: []string{
			"http://" + r.Host,
			"https://" + r.Host,
		},
	})
}

// wauthnUser wraps a store.User to satisfy the webauthn.User interface.
type wauthnUser struct {
	id    int64
	uname string
	cs    string // callsign used as display name
	creds []webauthn.Credential
}

func (u *wauthnUser) WebAuthnID() []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, uint64(u.id))
	return b
}
func (u *wauthnUser) WebAuthnName() string             { return u.uname }
func (u *wauthnUser) WebAuthnDisplayName() string       { return u.cs }
func (u *wauthnUser) WebAuthnIcon() string              { return "" }
func (u *wauthnUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

func wauthnUserFrom(u store.User, creds []webauthn.Credential) *wauthnUser {
	return &wauthnUser{id: u.ID, uname: u.Username, cs: u.Callsign, creds: creds}
}

// ----- registration -----

func (s *Server) handlePasskeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sess := sessionFor(s, r)

	wn, err := waForRequest(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "webauthn init: "+err.Error())
		return
	}

	creds, err := s.store.GetPasskeyCredentials(sess.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	wu := wauthnUserFrom(store.User{
		ID: sess.UserID, Username: sess.Username, Callsign: sess.Callsign,
	}, creds)

	opts, sessionData, err := wn.BeginRegistration(wu,
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "begin registration: "+err.Error())
		return
	}

	sessID := randomID(24)
	if err := s.store.SavePasskeySession(sessID, sessionData, time.Now().Add(passkeySessionTTL)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     passkeySessionCookie,
		Value:    sessID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(passkeySessionTTL.Seconds()),
	})

	writeJSON(w, http.StatusOK, opts)
}

func (s *Server) handlePasskeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	sess := sessionFor(s, r)

	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = "Passkey"
	}

	wnSessCookie, err := r.Cookie(passkeySessionCookie)
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing webauthn session")
		return
	}
	sessionData, err := s.store.GetPasskeySession(wnSessCookie.Value)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusBadRequest, "webauthn session expired or not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	wn, err := waForRequest(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "webauthn init: "+err.Error())
		return
	}

	creds, err := s.store.GetPasskeyCredentials(sess.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	wu := wauthnUserFrom(store.User{
		ID: sess.UserID, Username: sess.Username, Callsign: sess.Callsign,
	}, creds)

	cred, err := wn.FinishRegistration(wu, *sessionData, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "finish registration: "+err.Error())
		return
	}

	if err := s.store.SavePasskeyCredential(sess.UserID, name, cred); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	clearPasskeySessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "name": name})
}

// ----- login -----

func (s *Server) handlePasskeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}

	wn, err := waForRequest(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "webauthn init: "+err.Error())
		return
	}

	opts, sessionData, err := wn.BeginDiscoverableLogin()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "begin discoverable login: "+err.Error())
		return
	}

	sessID := randomID(24)
	if err := s.store.SavePasskeySession(sessID, sessionData, time.Now().Add(passkeySessionTTL)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     passkeySessionCookie,
		Value:    sessID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(passkeySessionTTL.Seconds()),
	})

	writeJSON(w, http.StatusOK, opts)
}

func (s *Server) handlePasskeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}

	wnSessCookie, err := r.Cookie(passkeySessionCookie)
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing webauthn session")
		return
	}
	sessionData, err := s.store.GetPasskeySession(wnSessCookie.Value)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusBadRequest, "webauthn session expired or not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	wn, err := waForRequest(r)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "webauthn init: "+err.Error())
		return
	}

	var resolvedUser *wauthnUser
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		if len(userHandle) != 8 {
			return nil, errors.New("invalid user handle length")
		}
		userID := int64(binary.BigEndian.Uint64(userHandle))
		u, err := s.store.GetUserByID(userID)
		if err != nil {
			return nil, errors.New("user not found")
		}
		if u.Disabled {
			return nil, errors.New("account disabled")
		}
		creds, err := s.store.GetPasskeyCredentials(userID)
		if err != nil {
			return nil, err
		}
		wu := wauthnUserFrom(u, creds)
		resolvedUser = wu
		return wu, nil
	}

	cred, err := wn.FinishDiscoverableLogin(handler, *sessionData, r)
	if err != nil {
		s.audit(r, store.AuditWarn, AuditLoginFailure, "", "", "passkey: "+err.Error())
		writeError(w, http.StatusUnauthorized, "passkey login failed: "+err.Error())
		return
	}

	if resolvedUser == nil {
		writeError(w, http.StatusInternalServerError, "user not resolved")
		return
	}

	// Update sign count.
	if err := s.store.UpdatePasskeyCredential(cred); err != nil {
		// Log but don't fail login over this.
		_ = err
	}

	u, err := s.store.GetUserByID(resolvedUser.id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.audit(r, store.AuditInfo, AuditLoginSuccess, u.Username, "", "passkey")
	appSess := s.sessions.Create(u)
	SetSessionCookie(w, appSess.ID)
	clearPasskeySessionCookie(w)
	writeJSON(w, http.StatusOK, sessionInfo(appSess))
}

// ----- credential management -----

func (s *Server) handlePasskeyCredentials(w http.ResponseWriter, r *http.Request) {
	sess := sessionFor(s, r)

	switch r.Method {
	case http.MethodGet:
		list, err := s.store.ListPasskeyCredentials(sess.UserID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, list)

	case http.MethodDelete:
		credID := strings.TrimPrefix(r.URL.Path, "/api/passkey/credentials/")
		if credID == "" {
			writeError(w, http.StatusBadRequest, "missing credential id")
			return
		}
		if err := s.store.DeletePasskeyCredential(credID, sess.UserID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func clearPasskeySessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:   passkeySessionCookie,
		Value:  "",
		Path:   "/",
		MaxAge: -1,
	})
}
