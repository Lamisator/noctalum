package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/noctalum/noctalum/internal/store"
	"golang.org/x/oauth2"
)

// OIDC audit actions — reuse AuditUserCreate for the "provisioned via SSO"
// side effect so admins see all account creations in one filter.
const (
	AuditOIDCLoginSuccess = "oidc.login_success"
	AuditOIDCLoginFailure = "oidc.login_failure"
	AuditOIDCLink         = "oidc.link"
)

// oidcCookieState is the transient cookie shared between /login and
// /callback. It carries the CSRF-defence "state" and the PKCE verifier;
// both are HttpOnly + SameSite=Lax so the callback redirect can bring
// them back with the auth code from the IdP.
const (
	oidcStateCookie    = "noctalum_oidc"
	oidcStateCookieTTL = 10 * time.Minute
)

// oidcProvider caches a discovered IdP + Verifier keyed by (issuer,
// clientID). The go-oidc discovery call hits the IdP's .well-known
// endpoint, so we memoise the result rather than re-discovering on every
// login click. LoadSettings on startup and any admin-driven settings
// change bump the config key and force a re-discovery on next use.
type oidcProvider struct {
	key      string // "issuer|clientID|scopes"
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
	config   oauth2.Config
}

var (
	oidcMu    sync.Mutex
	oidcCache *oidcProvider
)

// getOIDCProvider returns a ready-to-use provider for the current
// settings, discovering it on the first call and re-discovering when
// the admin changes the issuer / client ID / scopes.
func (s *Server) getOIDCProvider(r *http.Request) (*oidcProvider, error) {
	set := s.settings
	if !set.OIDCEnabled || set.OIDCIssuerURL == "" || set.OIDCClientID == "" {
		return nil, errors.New("OIDC is not configured")
	}
	scopes := oidcScopes(set.OIDCScopes)
	key := set.OIDCIssuerURL + "|" + set.OIDCClientID + "|" + strings.Join(scopes, " ")

	oidcMu.Lock()
	defer oidcMu.Unlock()
	if oidcCache != nil && oidcCache.key == key {
		return oidcCache, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	p, err := oidc.NewProvider(ctx, set.OIDCIssuerURL)
	if err != nil {
		return nil, fmt.Errorf("discover OIDC provider: %w", err)
	}
	prov := &oidcProvider{
		key:      key,
		provider: p,
		verifier: p.Verifier(&oidc.Config{ClientID: set.OIDCClientID}),
		config: oauth2.Config{
			ClientID:     set.OIDCClientID,
			ClientSecret: set.OIDCClientSecret,
			Endpoint:     p.Endpoint(),
			RedirectURL:  oidcRedirectURL(r),
			Scopes:       scopes,
		},
	}
	oidcCache = prov
	return prov, nil
}

// invalidateOIDCCache is called whenever OIDC settings change so the
// next /login redirect rediscovers with the fresh config.
func invalidateOIDCCache() {
	oidcMu.Lock()
	oidcCache = nil
	oidcMu.Unlock()
}

func oidcScopes(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{oidc.ScopeOpenID, "profile", "email"}
	}
	fields := strings.Fields(raw)
	// Always require openid so ID-token verification works.
	has := false
	for _, f := range fields {
		if f == oidc.ScopeOpenID {
			has = true
			break
		}
	}
	if !has {
		fields = append([]string{oidc.ScopeOpenID}, fields...)
	}
	return fields
}

// oidcRedirectURL returns the absolute callback URL Noctalum registers
// with the IdP. Derived per-request so the same server binary works on
// dev (http://localhost) and prod (https://log.dm2lap.com) without any
// static config.
func oidcRedirectURL(r *http.Request) string {
	scheme := "http"
	// Respect standard reverse-proxy hints (Traefik sets both).
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	} else if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	return scheme + "://" + host + "/api/oidc/callback"
}

// handleOIDCConfig is unauthenticated: the login screen calls it to
// decide whether to render the SSO button and what label to use.
// Nothing sensitive is exposed — issuer URL is public metadata anyway.
func (s *Server) handleOIDCConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "GET only")
		return
	}
	set := s.settings
	enabled := set.OIDCEnabled && set.OIDCIssuerURL != "" && set.OIDCClientID != ""
	label := set.OIDCButtonLabel
	if label == "" {
		label = "Sign in with SSO"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": enabled,
		"label":   label,
	})
}

// handleOIDCLogin starts the auth-code + PKCE flow. It generates a
// per-request state token and PKCE verifier, stashes both in a
// short-lived HttpOnly cookie, and 302-redirects the browser to the IdP.
func (s *Server) handleOIDCLogin(w http.ResponseWriter, r *http.Request) {
	prov, err := s.getOIDCProvider(r)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	state := randomID(24)
	verifier := randomID(48) // 96 hex chars => plenty for a PKCE verifier (43-128 chars)
	// PKCE challenge = base64url(sha256(verifier)).
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	// Cookie value carries both fields; verifier isn't secret in itself
	// but must not be predictable — hex(rand) achieves that already.
	http.SetCookie(w, &http.Cookie{
		Name:     oidcStateCookie,
		Value:    state + "." + verifier,
		Path:     "/api/oidc",
		HttpOnly: true,
		Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(oidcStateCookieTTL.Seconds()),
	})

	authURL := prov.config.AuthCodeURL(state,
		oauth2.SetAuthURLParam("code_challenge", challenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
	)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// handleOIDCCallback finalises the flow: verify state, exchange code +
// PKCE verifier for tokens, verify the ID token, resolve/provision the
// local user, and issue a Noctalum session cookie. On success the
// browser is redirected to "/" so the SPA boots normally; on failure
// we redirect to "/?oidc_error=…" so the login screen can surface it.
func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	fail := func(status int, msg string) {
		s.audit(r, store.AuditWarn, AuditOIDCLoginFailure, "", "", msg)
		// Clear the transient cookie regardless of outcome.
		http.SetCookie(w, &http.Cookie{
			Name:     oidcStateCookie,
			Value:    "",
			Path:     "/api/oidc",
			HttpOnly: true,
			MaxAge:   -1,
		})
		// If the browser accepts HTML, land on the login screen with a
		// hash-anchored error so app.js can render it. Otherwise return
		// a plain error response for API-style callers.
		accept := r.Header.Get("Accept")
		if strings.Contains(accept, "text/html") || accept == "" {
			http.Redirect(w, r, "/#oidc_error="+urlQueryEscape(msg), http.StatusFound)
			return
		}
		writeError(w, status, msg)
	}

	if r.Method != http.MethodGet {
		fail(http.StatusMethodNotAllowed, "GET required")
		return
	}
	if errParam := r.URL.Query().Get("error"); errParam != "" {
		desc := r.URL.Query().Get("error_description")
		if desc != "" {
			fail(http.StatusUnauthorized, errParam+": "+desc)
		} else {
			fail(http.StatusUnauthorized, errParam)
		}
		return
	}
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		fail(http.StatusBadRequest, "missing code or state")
		return
	}
	c, err := r.Cookie(oidcStateCookie)
	if err != nil {
		fail(http.StatusBadRequest, "missing OIDC state cookie")
		return
	}
	parts := strings.SplitN(c.Value, ".", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		fail(http.StatusBadRequest, "malformed OIDC state cookie")
		return
	}
	// Constant-time state comparison to avoid a plausible-but-tiny
	// timing signal in the mismatch path.
	if !constEq(parts[0], state) {
		fail(http.StatusBadRequest, "state mismatch")
		return
	}
	verifier := parts[1]

	prov, err := s.getOIDCProvider(r)
	if err != nil {
		fail(http.StatusServiceUnavailable, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	tok, err := prov.config.Exchange(ctx, code,
		oauth2.SetAuthURLParam("code_verifier", verifier),
	)
	if err != nil {
		fail(http.StatusBadGateway, "token exchange: "+err.Error())
		return
	}
	rawID, ok := tok.Extra("id_token").(string)
	if !ok || rawID == "" {
		fail(http.StatusBadGateway, "no id_token in response")
		return
	}
	idTok, err := prov.verifier.Verify(ctx, rawID)
	if err != nil {
		fail(http.StatusUnauthorized, "id_token verify: "+err.Error())
		return
	}
	var claims struct {
		Sub               string `json:"sub"`
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
		Name              string `json:"name"`
		Nickname          string `json:"nickname"`
		// Free-form catch-all for a custom claim name (e.g. "callsign").
		// Populated below via a second Claims() call so we can respect
		// the admin-configured OIDCCallsignClaim value.
	}
	if err := idTok.Claims(&claims); err != nil {
		fail(http.StatusBadGateway, "parse claims: "+err.Error())
		return
	}
	if claims.Sub == "" {
		fail(http.StatusUnauthorized, "id_token missing sub")
		return
	}
	issuer := idTok.Issuer

	set := s.settings
	callsignClaim := strings.TrimSpace(set.OIDCCallsignClaim)
	if callsignClaim == "" {
		callsignClaim = "preferred_username"
	}
	// Second decode into a generic map so we can pull an arbitrary
	// admin-selected claim name for the callsign.
	var raw map[string]any
	_ = idTok.Claims(&raw)

	// Enrich with the userinfo endpoint. Zitadel (and quite a few other
	// IdPs) only ship the minimum required claims — sub, aud, iss,
	// exp, iat, auth_time — in the ID token itself and put
	// preferred_username / email / nickname / name at /oauth/v2/userinfo.
	// Without this step, the auto-provisioning path sees empty
	// preferred_username and falls back to the "sso-<hash>" username +
	// N0CALL callsign. Userinfo values only fill gaps, never overwrite —
	// the ID token remains the source of truth for anything it did
	// contain.
	if uinfo, err := prov.provider.UserInfo(ctx, oauth2.StaticTokenSource(tok)); err == nil {
		var ui map[string]any
		if err := uinfo.Claims(&ui); err == nil {
			for k, v := range ui {
				if _, present := raw[k]; !present {
					raw[k] = v
				}
			}
			if claims.PreferredUsername == "" {
				if v, ok := ui["preferred_username"].(string); ok {
					claims.PreferredUsername = v
				}
			}
			if claims.Email == "" {
				if v, ok := ui["email"].(string); ok {
					claims.Email = v
				}
			}
			if claims.Nickname == "" {
				if v, ok := ui["nickname"].(string); ok {
					claims.Nickname = v
				}
			}
			if claims.Name == "" {
				if v, ok := ui["name"].(string); ok {
					claims.Name = v
				}
			}
		}
	}

	callsignRaw := ""
	if v, ok := raw[callsignClaim].(string); ok {
		callsignRaw = v
	}
	callsign := strings.ToUpper(strings.TrimSpace(callsignRaw))
	if !ValidCallsign(callsign) {
		// Fall back to preferred_username / nickname / local part of
		// email. If none of those parse as a callsign, provisioning
		// fails — the operator has to edit their IdP profile so the
		// selected claim carries a valid callsign.
		for _, cand := range []string{claims.PreferredUsername, claims.Nickname, emailLocalPart(claims.Email)} {
			cand = strings.ToUpper(strings.TrimSpace(cand))
			if ValidCallsign(cand) {
				callsign = cand
				break
			}
		}
	}

	// Existing SSO-linked account? Just log them in.
	u, err := s.store.GetUserByOIDC(issuer, claims.Sub)
	if err == nil {
		if u.Disabled {
			fail(http.StatusForbidden, "account disabled")
			return
		}
		s.finishOIDCLogin(w, r, u, "existing")
		return
	}
	if !errors.Is(err, store.ErrNotFound) {
		fail(http.StatusInternalServerError, "user lookup: "+err.Error())
		return
	}

	// No link yet. Try to link an existing local account by matching
	// username (preferred_username or email local part). This lets an
	// admin pre-create a Noctalum account with the same username as
	// the operator's Zitadel login and have the two link automatically
	// on first SSO click.
	linkName := strings.ToLower(strings.TrimSpace(claims.PreferredUsername))
	if linkName == "" {
		linkName = strings.ToLower(emailLocalPart(claims.Email))
	}
	if linkName != "" {
		if existing, err := s.store.GetUserByUsername(linkName); err == nil {
			if existing.Disabled {
				fail(http.StatusForbidden, "account disabled")
				return
			}
			if err := s.store.LinkOIDCToUser(existing.ID, issuer, claims.Sub); err != nil {
				fail(http.StatusInternalServerError, "link OIDC: "+err.Error())
				return
			}
			s.audit(r, store.AuditInfo, AuditOIDCLink, existing.Username, issuer, claims.Sub)
			s.finishOIDCLogin(w, r, existing, "linked")
			return
		}
	}

	// No matching local user and auto-create is disabled → refuse.
	if !set.OIDCAutoCreate {
		fail(http.StatusForbidden, "no local account for this SSO identity; auto-provisioning is disabled")
		return
	}

	// Provision a new local user. Pick a fallback callsign if none of
	// the claim candidates parsed — the operator can rename it later
	// via the callsign-change-request flow.
	if !ValidCallsign(callsign) {
		callsign = "N0CALL"
	}
	username := linkName
	if username == "" {
		// Absolute fallback: deterministic name from the sub so a
		// re-login still finds the same row on the next iteration.
		username = "sso-" + shortSubHash(claims.Sub)
	}
	// Ensure uniqueness — append a short hash if the base name is taken.
	base := username
	for i := 0; i < 5; i++ {
		if _, err := s.store.GetUserByUsername(username); errors.Is(err, store.ErrNotFound) {
			break
		}
		username = base + "-" + shortSubHash(claims.Sub+fmt.Sprintf("%d", i))
	}
	newU, err := s.store.CreateOIDCUser(username, callsign, issuer, claims.Sub, []string{"user"})
	if err != nil {
		fail(http.StatusInternalServerError, "create user: "+err.Error())
		return
	}
	s.audit(r, store.AuditInfo, AuditUserCreate, "oidc:"+issuer, newU.Username,
		"callsign: "+newU.Callsign+", roles: user (SSO auto-provisioned)")
	s.finishOIDCLogin(w, r, newU, "auto-created")
}

// finishOIDCLogin issues the Noctalum session cookie and redirects
// the browser to the SPA root — from there the normal /api/me
// bootstrap kicks in.
func (s *Server) finishOIDCLogin(w http.ResponseWriter, r *http.Request, u store.User, provStage string) {
	s.audit(r, store.AuditInfo, AuditLoginSuccess, u.Username, "", "oidc:"+provStage)
	go s.store.TouchUserActivity(u.ID)
	sess := s.sessions.Create(u)
	SetSessionCookie(w, sess.ID)
	// Clear the transient state cookie now that we're done with it.
	http.SetCookie(w, &http.Cookie{
		Name:     oidcStateCookie,
		Value:    "",
		Path:     "/api/oidc",
		HttpOnly: true,
		MaxAge:   -1,
	})
	http.Redirect(w, r, "/", http.StatusFound)
}

// ----- small helpers -----

func emailLocalPart(email string) string {
	i := strings.IndexByte(email, '@')
	if i <= 0 {
		return ""
	}
	return email[:i]
}

func shortSubHash(sub string) string {
	sum := sha256.Sum256([]byte(sub))
	return hex.EncodeToString(sum[:4])
}

func constEq(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var d byte
	for i := 0; i < len(a); i++ {
		d |= a[i] ^ b[i]
	}
	return d == 0
}

func urlQueryEscape(s string) string { return url.QueryEscape(s) }
