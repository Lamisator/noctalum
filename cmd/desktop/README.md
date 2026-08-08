# noctalum-desktop

Native Wails-based desktop wrapper around the Noctalum web UI.  Same
HTML/CSS/JS the browser sees, running inside the OS-native webview
(WebView2 / WebKit / WebKitGTK), with a persistent cookie jar so
sessions survive restarts.

## What it does

1. First launch → prompts for a **server URL** and (optionally) a
   **username** to cache.
2. `POST /api/ping` sanity-checks the URL.  On success both values are
   written to `<user-config-dir>/noctalum-desktop/config.json`.
3. The main window navigates to `<server>/`.  Noctalum's own login page
   handles the password (auto-filled with the cached username if any).
4. `shim.js` is injected into every page and:
   - forwards `window.open()` calls (the panel pop-out mechanism) to
     Go, which currently opens them in the operator's default browser
     (see *Limitations* below);
   - watches for successful logins and refreshes the cached username
     via `GET /api/me`.
5. Subsequent launches jump straight to the server; if the session
   cookie is still valid the app loads without prompting for anything.

Passwords are never stored on disk.  Session cookies live inside the
OS-managed webview data folder (`%LocalAppData%\noctalum-desktop\` on
Windows, `~/Library/WebKit/…` on macOS, `~/.local/share/…` on Linux).

## Config file

Written to the OS-standard user-config directory:

| OS      | Path                                                             |
| ------- | ---------------------------------------------------------------- |
| Linux   | `~/.config/noctalum-desktop/config.json`                         |
| macOS   | `~/Library/Application Support/noctalum-desktop/config.json`     |
| Windows | `%AppData%\noctalum-desktop\config.json`                         |

Shape:

```json
{
  "server_url": "https://log.example.com",
  "username": "dm2lap"
}
```

## Building

`noctalum-desktop` is a Wails v2 app, so it needs CGo plus the target
OS's webview headers.  Cross-compilation is impractical; each OS is
built on its own machine (or CI runner).

### Prerequisites

- Go 1.25+
- Wails CLI: `go install github.com/wailsapp/wails/v2/cmd/wails@v2.9.2`
- **Linux**: `libwebkit2gtk-4.1-dev` (or `-4.0-dev` on older distros),
  `libgtk-3-dev`, `pkg-config`, `build-essential`
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows**: WebView2 Runtime (ships with recent Windows 10/11) and
  MSVC or MinGW-w64

### Build

```sh
cd cmd/desktop
wails build              # produces build/bin/noctalum-desktop[.exe]
```

Run in dev mode with hot-reloaded Go (frontend is static, no watcher
needed):

```sh
wails dev
```

## Limitations (MVP)

- **Password prompt is served by Noctalum**, not the wrapper.  The
  wrapper caches server URL + username natively but delegates password
  entry to the server's own login form.  A native password field would
  require a small `/api/desktop-handoff` endpoint on the server to hand
  the session cookie to the webview cleanly; that's a follow-up.
- **Pop-out panels open in the system browser**, not a second native
  window.  Wails v2.9 has no multi-window API (that's v3), and the
  current pop-out mechanism relies on cross-document DOM adoption
  (`doc.write` + `adoptNode`) which cannot cross a webview-process
  boundary.  A proper native-window pop-out will need both a Wails v3
  upgrade and a small frontend change to render a single panel by URL
  (e.g. `/?panel=ops`).
- **No auto-update.**  Ship a new binary per release.
