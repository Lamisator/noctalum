// shim.js — injected into every Noctalum page loaded in the desktop
// wrapper. Runs inside the target-origin document, so all fetches are
// same-origin and cookies behave normally.
//
// Responsibilities:
//   1. Override window.open() so panel pop-outs spawn a native Wails
//      window instead of a browser tab / popup.
//   2. If __NOCTALUM_DESKTOP_USERNAME__ is set, prefill the login form's
//      username field (saves the operator a keystroke on re-login).
//   3. After a successful login, notify the Go side of the current
//      username so the config file can be updated.
//
// The wrapper injects this script via runtime.WindowExecJs on every
// DOM-ready event.  It idempotently sets a sentinel so repeat injections
// on the same document are no-ops.
//
// Important:  when the webview navigates to the operator's Noctalum
// server, the pages served by that server are NOT served by Wails'
// asset server — so Wails' `window.go.main.App` bindings are absent.
// Fortunately the native IPC bridge (WebView2 postMessage on Windows,
// WebKit message handlers on macOS + Linux) is attached at the webview
// level, not per-origin, so it *is* available on external pages.  The
// shim calls it directly, encoding the Wails "Call" wire format itself.
(function () {
  if (window.__NOCTALUM_DESKTOP_SHIM__) return;
  window.__NOCTALUM_DESKTOP_SHIM__ = true;

  const CACHED_USERNAME = window.__NOCTALUM_DESKTOP_USERNAME__ || '';

  // ------------------------------------------------------------------
  // Native-bridge fallback for Go-bound methods
  // ------------------------------------------------------------------
  // Wails' runtime and bindings are injected by its asset server and
  // therefore only exist on pages the wrapper serves locally (the boot
  // prompt).  For calls made from within the Noctalum server's origin
  // we replicate the tiny slice of the runtime we actually need:  the
  // "C" (Call) message, posted through the raw platform IPC.  Callback
  // IDs are unique but unowned — Go's reply is silently dropped, which
  // is fine since none of our bound methods return anything the shim
  // cares about (OpenPanelWindow is fire-and-forget, RememberUsername
  // returns void).
  function rawPostMessage(msg) {
    if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
      window.chrome.webview.postMessage(msg);
      return true;
    }
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.external
        && typeof window.webkit.messageHandlers.external.postMessage === 'function') {
      window.webkit.messageHandlers.external.postMessage(msg);
      return true;
    }
    return false;
  }

  let __callSeq = 0;
  function invokeGoMethod(fullName, args) {
    // Preferred path: the bindings object exists (bootstrap page).
    const parts = fullName.split('.');
    let ref = window.go;
    for (const p of parts) {
      if (!ref) break;
      ref = ref[p];
    }
    if (typeof ref === 'function') {
      try { ref.apply(null, args); return true; } catch {}
    }
    // Fallback: encode the Wails "C" message and post it directly to
    // the native bridge.  The wrapper's Go side registers `main.App` as
    // a bind target, so this reaches the same handler as the runtime
    // wrapper would have.
    __callSeq += 1;
    const payload = {
      name: fullName,
      args: Array.isArray(args) ? args : [],
      callbackID: 'desktop-shim-' + __callSeq + '-' + Date.now(),
    };
    return rawPostMessage('C' + JSON.stringify(payload));
  }

  // ------------------------------------------------------------------
  // 1. window.open interception
  // ------------------------------------------------------------------
  // The Noctalum pop-out flow calls window.open('') with a synthesised
  // window name ("noctalum-<key>-<ts>"), then does doc.write + adoptNode
  // on the returned Window.  DOM adoption across native windows isn't
  // possible in Wails (each window is a separate webview process), so
  // we route the intent through the Go side which opens a fresh native
  // window loading the same server URL.  The panel-solo rendering piece
  // is a follow-up on the frontend — see README.md for the caveat.
  const origOpen = window.open.bind(window);
  window.open = function (url, name, features) {
    try {
      const target = (url && url.length) ? url : window.location.href;
      const title  = (typeof name === 'string' && name) ? name : document.title;
      if (invokeGoMethod('main.App.OpenPanelWindow', [target, title])) {
        // Return a minimal Window-shaped stub so callers that immediately
        // do `if (!win) alert(...)` don't complain, and follow-up
        // doc.write / addEventListener calls no-op gracefully.
        return makeWindowStub();
      }
    } catch (e) {
      console.warn('desktop shim: OpenPanelWindow bridge failed', e);
    }
    return origOpen(url, name, features);
  };

  function makeWindowStub() {
    const noop = function () {};
    const doc = {
      open: noop, close: noop, write: noop, writeln: noop,
      title: '', body: null, head: null,
      addEventListener: noop, removeEventListener: noop,
      importNode: function (n) { return n; },
      querySelectorAll: function () { return []; },
    };
    return {
      closed: false,
      document: doc,
      addEventListener: noop,
      removeEventListener: noop,
      focus: noop,
      close: function () { this.closed = true; },
    };
  }

  // ------------------------------------------------------------------
  // 2. Username prefill
  // ------------------------------------------------------------------
  if (CACHED_USERNAME) {
    const prefill = () => {
      const el = document.querySelector('input[name="username"], input#username, input[autocomplete="username"]');
      if (el && !el.value) {
        el.value = CACHED_USERNAME;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // Move focus to the password field if it exists, so the operator
        // can just start typing.
        const pw = document.querySelector('input[type="password"]');
        if (pw) pw.focus();
      }
    };
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      prefill();
    } else {
      document.addEventListener('DOMContentLoaded', prefill, { once: true });
    }
  }

  // ------------------------------------------------------------------
  // 3. Post-login username capture
  // ------------------------------------------------------------------
  // Wrap fetch so a successful POST /api/login triggers a config update
  // via the Go side.  Same for the passkey finish endpoint.  Failures
  // are ignored — cached username is a convenience, not a requirement.
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const resp = await origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const isLogin =
        (url.indexOf('/api/login') === 0 && (!init || (init.method || 'GET').toUpperCase() === 'POST')) ||
        url.indexOf('/api/passkey/login/finish') === 0;
      if (isLogin && resp.ok) {
        // Delay slightly so the /api/me endpoint sees the freshly-minted
        // session cookie.
        setTimeout(captureUsername, 50);
      }
    } catch {}
    return resp;
  };

  async function captureUsername() {
    try {
      const r = await origFetch('/api/me', { credentials: 'same-origin' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.username) {
        invokeGoMethod('main.App.RememberUsername', [String(j.username)]);
      }
    } catch {}
  }
})();
