# contestlog-helper-gui

Desktop GUI version of the ContestLog rig helper.  Wraps the same
rigctld → ContestLog WebSocket bridge as `cmd/helper`, but presents a
Wails-based UI that:

- detects the serial port automatically (per-OS),
- probes a curated list of transceivers to find the right Hamlib model,
- searches for the highest baud rate the rig answers at,
- displays the rigctld parameters it ends up using,
- lets the operator save and switch between named TRX profiles.

## Building

The GUI helper needs CGO and a platform-specific webview toolchain, so it
is **not** built by the default `./build.sh` run.

### Linux (amd64) via Docker / Podman

```
./build.sh --gui-only
```

The first run builds a small one-off image that adds
`libgtk-3-dev` and `libwebkit2gtk-4.1-dev` on top of `golang:1.22-bookworm`.
Subsequent runs reuse it.

### Windows / macOS — natively

Install the [Wails CLI](https://wails.io/docs/gettingstarted/installation):

```
go install github.com/wailsapp/wails/v2/cmd/wails@latest
```

Then from this directory:

```
wails build
```

Output ends up in `build/bin/`.

## Runtime requirements

- A Hamlib `rigctld` binary on `$PATH` (or pointed at by the
  *rigctld binary* field).  The default Hamlib install is fine.
- A USB / serial cable to the rig.
- A ContestLog server URL and a helper token from the server's *Settings*
  panel.
