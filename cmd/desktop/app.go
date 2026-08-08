package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/options"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// shimSource is the JS payload injected into every Noctalum page loaded
// in the webview.  See shim.js for what it does.
//
//go:embed shim.js
var shimSource string

// App is the object bound to the Wails frontend.  Exported methods are
// callable from JavaScript as window.go.main.App.<Method>.
type App struct {
	ctx context.Context
	cfg *configStore

	mu        sync.Mutex
	serverURL string // active server, without trailing slash
}

func newApp(cfg *configStore) *App {
	return &App{cfg: cfg}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	wruntime.LogInfof(ctx, "Noctalum desktop v%s starting", desktopVersion)
	// Note: auto-navigation for a cached server URL is triggered from the
	// bootstrap page's JS after LoadConfig() returns, not here, so that we
	// don't race with the webview's initial-page load.
}

func (a *App) shutdown(_ context.Context) {
	// Wails tears the webview down on its own; nothing to release here
	// yet, but the hook is wired so we have a place for future
	// finalizers (e.g. flushing config once we start writing more).
}

// onDomReady runs after every DOM-ready in the main window (both the
// bootstrap prompt and every subsequent navigation to the server).  We
// use it to re-inject shim.js — the shim is idempotent, so re-injection
// on the bootstrap page or the empty prompt is harmless.
func (a *App) onDomReady(ctx context.Context) {
	a.injectShim(ctx)
}

// LoadConfig — bound.  Returns the persisted server URL and username so
// the bootstrap prompt can prefill them.
func (a *App) LoadConfig() Config {
	return a.cfg.get()
}

// ConnectServer — bound.  Called from the bootstrap prompt.  Verifies
// the server is reachable, persists the URL (and any pre-typed
// username), then navigates the main webview to it.
func (a *App) ConnectServer(rawURL, username string) error {
	normalised, err := normaliseServerURL(rawURL)
	if err != nil {
		return err
	}
	if err := pingServer(a.ctx, normalised); err != nil {
		return fmt.Errorf("could not reach %s: %w", normalised, err)
	}
	if err := a.cfg.update(func(c *Config) {
		c.ServerURL = normalised
		if trimmed := strings.TrimSpace(username); trimmed != "" {
			c.Username = trimmed
		}
	}); err != nil {
		return fmt.Errorf("save config: %w", err)
	}
	a.navigateToServer(normalised)
	return nil
}

// RememberUsername — bound.  Invoked by shim.js after a successful
// /api/login (or passkey finish) once /api/me has confirmed the
// resulting session.  Idempotent; no-op if the value hasn't changed.
func (a *App) RememberUsername(name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	if cur := a.cfg.get(); cur.Username == name {
		return
	}
	if err := a.cfg.update(func(c *Config) { c.Username = name }); err != nil {
		wruntime.LogWarningf(a.ctx, "RememberUsername: save failed: %v", err)
	}
}

// OpenPanelWindow — bound.  Invoked by shim.js when the loaded page
// calls window.open() (e.g. undocking the ops panel).  Spawns a fresh
// native window pointed at the same server URL.  The new window shares
// cookies with the main window through the persistent webview data
// folder, so the second window is logged in from the start.
//
// Note: the frontend's current pop-out flow expects to hand a live DOM
// node to the opened Window; that trick doesn't survive a process
// boundary.  The MVP therefore opens a full-app window; a follow-up on
// the frontend to render a solo-panel-by-URL will make pop-out
// perfectly faithful (see cmd/desktop/README.md).
func (a *App) OpenPanelWindow(rawURL, title string) {
	target := strings.TrimSpace(rawURL)
	a.mu.Lock()
	server := a.serverURL
	a.mu.Unlock()
	if target == "" || target == "about:blank" {
		target = server
	}
	// runtime.WindowCreate isn't available in Wails v2.9 — multi-window
	// support is v3.  Until we upgrade, open the URL in the operator's
	// default browser so at least the "second view" workflow works.  The
	// shim treats the returned stub as if the window opened, so the
	// caller's UI state stays consistent.
	_ = title
	wruntime.BrowserOpenURL(a.ctx, target)
}

// -- internals --------------------------------------------------------

// navigateToServer points the current webview at the given server URL
// and records it as the "active" one.  Safe to call from any goroutine.
func (a *App) navigateToServer(serverURL string) {
	a.mu.Lock()
	a.serverURL = serverURL
	a.mu.Unlock()
	// WindowExecJs is the simplest cross-platform way to navigate the
	// webview.  Wails v2 does not expose a direct WindowSetURL for the
	// main window.
	js := fmt.Sprintf("window.location.replace(%s);", jsString(serverURL+"/"))
	wruntime.WindowExecJS(a.ctx, js)
}

// injectShim pushes shim.js into whatever page is currently loaded in
// the main window, along with a small preamble that exposes the cached
// username to the shim.  The shim itself is idempotent.
func (a *App) injectShim(ctx context.Context) {
	cfg := a.cfg.get()
	preamble := fmt.Sprintf("window.__NOCTALUM_DESKTOP_USERNAME__ = %s;\n", jsString(cfg.Username))
	wruntime.WindowExecJS(ctx, preamble+shimSource)
}

// jsString JSON-encodes s so it can be safely interpolated inside a
// JavaScript string literal.  Falls back to an empty string on the
// vanishingly unlikely marshal error.
func jsString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}

// normaliseServerURL strips whitespace, applies https:// if the scheme
// is missing, and drops trailing slashes.  Returns an error for URLs
// that don't parse or lack a host.
func normaliseServerURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errors.New("server URL is empty")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("unsupported scheme %q — use http or https", u.Scheme)
	}
	if u.Host == "" {
		return "", errors.New("URL is missing a host")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

// pingServer confirms the target speaks Noctalum's HTTP API by hitting
// /api/ping, which is public and returns 200 with a JSON body.  A 4xx
// or non-JSON reply is treated as "not a Noctalum server here".
func pingServer(ctx context.Context, base string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	client := &http.Client{Timeout: 8 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/ping", nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	var body struct {
		OK bool `json:"ok"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return fmt.Errorf("not a Noctalum server (bad response body)")
	}
	if !body.OK {
		return errors.New("server /api/ping returned ok=false")
	}
	return nil
}

// desktopWindowOptions is a small helper so main.go can stay focused on
// wiring instead of restating window geometry.
func (a *App) desktopWindowOptions() (int, int, options.RGBA) {
	return 1280, 900, options.RGBA{R: 18, G: 20, B: 23, A: 255}
}
