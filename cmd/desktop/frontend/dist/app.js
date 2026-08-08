// Bootstrap UI for the Noctalum desktop wrapper. Prompts for a server URL
// (and optional username to cache) and then hands off to the Go side which
// navigates the webview to the target server.

(function () {
  const form   = document.getElementById('prompt-form');
  const server = document.getElementById('server');
  const user   = document.getElementById('username');
  const errBox = document.getElementById('error');
  const btn    = document.getElementById('btn-connect');

  const showError = (msg) => {
    errBox.textContent = msg;
    errBox.hidden = false;
  };
  const clearError = () => { errBox.hidden = true; errBox.textContent = ''; };

  const bindings = () => (window.go && window.go.main && window.go.main.App) || null;

  // Prefill from stored config once the Wails runtime is available.
  // If a server URL is already cached, don't wait for the operator to
  // click Connect — reuse it and hand off immediately.  The webview's
  // persistent cookie jar means most launches skip the form entirely
  // and go straight into the logged-in app.
  const boot = async () => {
    const api = bindings();
    if (!api) { setTimeout(boot, 30); return; }
    let cfg;
    try {
      cfg = await api.LoadConfig();
    } catch (e) {
      console.error('LoadConfig failed', e);
      return;
    }
    if (cfg && cfg.server_url) {
      server.value = cfg.server_url;
      if (cfg.username) user.value = cfg.username;
      try {
        await api.ConnectServer(cfg.server_url, cfg.username || '');
      } catch (e) {
        // Cached server unreachable — leave the form visible so the
        // operator can edit or retry.
        showError(String(e && e.message ? e.message : e));
      }
    }
  };
  boot();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearError();

    let raw = server.value.trim();
    if (!raw) { showError('Please enter a server URL.'); return; }
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    // Normalise trailing slash.
    raw = raw.replace(/\/+$/, '');

    btn.disabled = true;
    btn.textContent = 'Connecting…';

    try {
      const api = bindings();
      if (!api) throw new Error('Wails runtime not ready');
      await api.ConnectServer(raw, user.value.trim());
      // On success the Go side navigates the window; nothing more to do here.
    } catch (e) {
      showError(String(e && e.message ? e.message : e));
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  });
})();
