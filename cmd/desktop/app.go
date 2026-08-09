package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
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

	// overrideURL is set (via the -url CLI flag) when this process was
	// spawned as a secondary window from OpenPanelWindow.  When present
	// the wrapper skips the bootstrap prompt and navigates straight to
	// this URL.
	overrideURL string

	mu             sync.Mutex
	serverURL      string // active server, without trailing slash
	firstDomReady  bool
}

func newApp(cfg *configStore, overrideURL string) *App {
	return &App{cfg: cfg, overrideURL: overrideURL}
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
// use it to re-inject shim.js on every page — the shim is idempotent,
// so re-injection on the bootstrap page or the empty prompt is harmless
// — and to trigger the immediate navigation for secondary windows that
// were spawned with a -url override.
func (a *App) onDomReady(ctx context.Context) {
	a.injectShim(ctx)

	a.mu.Lock()
	first := !a.firstDomReady
	a.firstDomReady = true
	override := a.overrideURL
	a.mu.Unlock()

	if first && override != "" {
		// Secondary window: replace the bootstrap prompt with the
		// target URL immediately.  navigateToServer stores serverURL
		// as the origin, which is what shim.js reads for its
		// window.open fallback.
		a.navigateToServer(override)
	}
}

// LoadConfig — bound.  Returns the persisted server URL and username so
// the bootstrap prompt can prefill them.
func (a *App) LoadConfig() Config {
	return a.cfg.get()
}

// IsOverride — bound.  Reports whether this process was spawned as a
// secondary window with a -url override.  The bootstrap page uses it
// to skip auto-connect, so its ConnectServer call can't race with the
// override navigation Go issues from onDomReady.
func (a *App) IsOverride() bool {
	return a.overrideURL != ""
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
// calls window.open() (e.g. undocking the ops panel).  Wails v2.9 has
// no in-process multi-window API, so we spawn a fresh copy of the
// wrapper as a subprocess with `-url <target>`; each copy is its own
// native window.  On Linux + macOS the WebKit cookie jar is shared
// per-user, so the new window opens already logged in.  On Windows
// WebView2 locks the user-data folder to a single process, so we fall
// back to opening the URL in the operator's default browser there.
//
// If the subprocess spawn fails for any reason (missing exe path,
// permission error), we degrade to BrowserOpenURL rather than dropping
// the click silently — the operator will still see the panel content
// in a real window, just not a native one.
//
// Note: the frontend's current pop-out flow expects to hand a live DOM
// node to the opened Window; that trick doesn't survive a process
// boundary.  The spawned window therefore loads the full app at the
// pop-out URL, not just the isolated panel — see cmd/desktop/README.md.
func (a *App) OpenPanelWindow(rawURL, title string) {
	_ = title
	target := strings.TrimSpace(rawURL)
	a.mu.Lock()
	server := a.serverURL
	a.mu.Unlock()
	if target == "" || target == "about:blank" {
		target = server
	}
	if target == "" {
		wruntime.LogWarningf(a.ctx, "OpenPanelWindow: no target URL and no active server, ignoring")
		return
	}

	if !supportsMultiInstance() {
		// Windows: WebView2 refuses to open a second process against
		// the same user-data folder.  Give the operator the panel in
		// their default browser rather than nothing at all.
		wruntime.BrowserOpenURL(a.ctx, target)
		return
	}

	exe, err := os.Executable()
	if err != nil || exe == "" {
		wruntime.LogWarningf(a.ctx, "OpenPanelWindow: os.Executable failed (%v) — falling back to system browser", err)
		wruntime.BrowserOpenURL(a.ctx, target)
		return
	}
	cmd := exec.Command(exe, "-url", target)
	// Detach so the child outlives us and vice versa; the child's stdio
	// is left disconnected — we don't want its logs bleeding into the
	// parent's console.
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		wruntime.LogWarningf(a.ctx, "OpenPanelWindow: subprocess start failed (%v) — falling back to system browser", err)
		wruntime.BrowserOpenURL(a.ctx, target)
		return
	}
	// Release the process handle so Go doesn't try to reap it; the OS
	// takes over parenting once we drop the reference.
	_ = cmd.Process.Release()
}

// supportsMultiInstance reports whether the current OS's webview allows
// two wrapper processes to share the same webview data folder.  WebKit
// (macOS + Linux) does; WebView2 on Windows locks its user-data folder
// to a single process at a time and will refuse the second launch.
func supportsMultiInstance() bool {
	return runtime.GOOS != "windows"
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
