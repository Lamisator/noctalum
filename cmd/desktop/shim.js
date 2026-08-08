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
(function () {
  if (window.__NOCTALUM_DESKTOP_SHIM__) return;
  window.__NOCTALUM_DESKTOP_SHIM__ = true;

  const CACHED_USERNAME = window.__NOCTALUM_DESKTOP_USERNAME__ || '';

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
      // Fully-qualified URL: pass through untouched, but ask the Go
      // side to open it in a native window.
      const target = (url && url.length) ? url : window.location.href;
      const title  = (typeof name === 'string' && name) ? name : document.title;
      if (window.go && window.go.main && window.go.main.App && window.go.main.App.OpenPanelWindow) {
        window.go.main.App.OpenPanelWindow(target, title);
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
      if (j && j.username && window.go && window.go.main && window.go.main.App && window.go.main.App.RememberUsername) {
        window.go.main.App.RememberUsername(String(j.username));
      }
    } catch {}
  }
})();
