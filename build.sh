#!/usr/bin/env bash
# Cross-compile Noctalum binaries inside a Docker (or Podman) container.
# No local Go toolchain is required.
#
# Defaults build the server for Linux, and the helper for Linux (as AppImage),
# macOS, and Windows (so each operator can grab the right binary for their PC).
#
# Usage:
#   ./build.sh                          # build everything (server, helper, wsjtx, GUI, C++)
#   ./build.sh --server-only            # only the noctalum server
#   ./build.sh --helper-only            # only the noctalum-helper
#   ./build.sh --wsjtx-only             # only the noctalum-wsjtx bridge
#   ./build.sh --gui-only               # only the noctalum-helper-gui (linux, windows)
#   ./build.sh --notifier-only          # only the Telegram-deploy notifier
#   ./build.sh --no-gui                 # skip the GUI helper
#   ./build.sh --no-helpers             # skip helper, WSJT-X bridge, and GUI (server + notifier only)
#   ./build.sh --cpp-only               # only the C++ helper packages (Linux+Windows+macOS)
#   ./build.sh --no-cpp                 # skip the C++ builds (default is to build)
#   ./build.sh --cpp-no-windows         # skip the C++ Windows cross-compile
#   ./build.sh --cpp-no-macos           # skip the C++ macOS cross-compile
#   ./build.sh --target linux/amd64     # restrict to one OS/arch
#   ./build.sh --image golang:1.26      # use a different builder image
#   ./build.sh --native                 # use the local toolchain instead of Docker
#                                       # (Go: cross-compiles all targets;
#                                       #  Go GUI: native platform only, CGO libs required;
#                                       #  C++: Linux only, needs qt6-base-dev + friends)
#
# The GUI helper (cmd/helper-gui) needs CGO + a platform-specific WebKit/WebView2
# toolchain.  This script builds Linux (amd64 + arm64) and Windows (amd64) in
# separate containers.  macOS GUI builds require Xcode and must be done natively
# with `wails build` on a Mac (see cmd/helper-gui/README.md).
#
# The C++ programs under cpp/ (helper, helper-gui, wsjtx, wsjtx-gui) build in
# three per-platform Docker images that are inline-defined below:
#   - noctalum-cpp-linux    Debian bookworm + Qt6 + linuxdeploy → AppImage
#   - noctalum-cpp-windows  Fedora + MinGW-w64 + Qt6           → .exe+DLL bundle in .zip
#                           (wsjtx-gui only; Fedora's mingw64-qt6 packaging
#                            doesn't include qtserialport / qtwebsockets,
#                            so helper-gui Windows still ships from the
#                            existing Go/Wails toolchain)
#   - noctalum-cpp-macos    Debian bookworm + osxcross + Qt6 static → .app in .zip (unsigned)
#
# The macOS image needs a macOS SDK tarball at cpp/third_party/osxcross-sdk/,
# which Apple's license forbids redistributing.  See cpp/third_party/osxcross-sdk/README
# for how to extract MacOSX*.sdk.tar.xz from a Mac you own.
#
# Failure modes: if a build was explicitly requested but the toolchain image
# can't be built or the cross-compile fails, build.sh exits non-zero.  There
# are no silent skips — deploy.sh runs under `set -e` and will abort in turn.
# Use --cpp-no-windows / --cpp-no-macos to opt out of specific platforms.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
GO_IMAGE="${GO_IMAGE:-golang:1.25-bookworm}"
OUT_DIR="$ROOT/dist"
CACHE_DIR="$ROOT/.build-cache"

DEFAULT_SERVER_TARGETS=("linux/amd64" "linux/arm64")
DEFAULT_HELPER_TARGETS=(
  "linux/amd64" "linux/arm64"
  "darwin/amd64" "darwin/arm64"
  "windows/amd64"
)
# Telegram-notifier binary runs on the operator's laptop (the machine that
# runs deploy.sh), so we only need the common dev-machine targets here.
DEFAULT_NOTIFIER_TARGETS=("linux/amd64" "darwin/arm64")

usage() {
  # Print the comment header at the top of this file (everything before the
  # first `set -e` line) as user-facing help text.
  awk 'NR>1 && /^set/{exit} NR>1 && /^#/' "$0"
}

build_server=true
build_helper=true
build_wsjtx=true
build_gui=true
build_notifier=true
build_cpp=true
build_cpp_windows=true
build_cpp_macos=true
single_target=""
native_build=false

while [ $# -gt 0 ]; do
  case "$1" in
    --server-only)   build_helper=false; build_wsjtx=false; build_gui=false; build_notifier=false; build_cpp=false; shift ;;
    --helper-only)   build_server=false; build_wsjtx=false; build_gui=false; build_notifier=false; build_cpp=false; shift ;;
    --wsjtx-only)    build_server=false; build_helper=false; build_gui=false; build_notifier=false; build_cpp=false; shift ;;
    --gui-only)      build_server=false; build_helper=false; build_wsjtx=false; build_gui=true; build_notifier=false; build_cpp=false; shift ;;
    --notifier-only) build_server=false; build_helper=false; build_wsjtx=false; build_gui=false; build_notifier=true; build_cpp=false; shift ;;
    --cpp-only)      build_server=false; build_helper=false; build_wsjtx=false; build_gui=false; build_notifier=false; build_cpp=true; shift ;;
    --no-gui)        build_gui=false; shift ;;
    --no-cpp)        build_cpp=false; shift ;;
    --cpp-no-windows) build_cpp_windows=false; shift ;;
    --cpp-no-macos)  build_cpp_macos=false; shift ;;
    --no-helpers)    build_helper=false; build_wsjtx=false; build_gui=false; build_cpp=false; shift ;;
    --target)      single_target="$2"; shift 2 ;;
    --image)       GO_IMAGE="$2"; shift 2 ;;
    --native)      native_build=true; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Pick a container runtime.  Needed for every non-native build target —
# Go targets, Go GUI, AND (new) all three C++ per-platform builds.
need_runtime=false
$build_server   && need_runtime=true
$build_helper   && need_runtime=true
$build_wsjtx    && need_runtime=true
$build_gui      && need_runtime=true
$build_notifier && need_runtime=true
$build_cpp      && need_runtime=true
RUNTIME=""
if $need_runtime && ! $native_build; then
  for c in docker podman; do
    if command -v "$c" >/dev/null 2>&1; then RUNTIME="$c"; break; fi
  done
  if [ -z "$RUNTIME" ]; then
    echo "error: neither docker nor podman is installed (use --native to build without Docker)" >&2
    exit 1
  fi
fi

# Enable BuildKit so RUN --mount=type=cache works in inline Dockerfiles.
# Docker 23+ already defaults to BuildKit; this is a no-op there.
[ "$RUNTIME" = "docker" ] && export DOCKER_BUILDKIT=1

server_targets=("${DEFAULT_SERVER_TARGETS[@]}")
helper_targets=("${DEFAULT_HELPER_TARGETS[@]}")
if [ -n "$single_target" ]; then
  server_targets=("$single_target")
  helper_targets=("$single_target")
fi

mkdir -p "$OUT_DIR" "$CACHE_DIR/go-build" "$CACHE_DIR/go-mod"

# Project version — git describe if available, otherwise "dev".
VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)"
LDFLAGS="-s -w -X main.version=${VERSION}"

# Pull the builder image once (skipped in --native mode or when no Go targets).
if [ -n "$RUNTIME" ] && ! $native_build; then
  "$RUNTIME" image inspect "$GO_IMAGE" >/dev/null 2>&1 || "$RUNTIME" pull "$GO_IMAGE"
fi

run_build() {
  local pkg="$1" basename="$2" target="$3" tags="${4:-}"
  local os="${target%/*}" arch="${target#*/}"
  local out="${basename}-${os}-${arch}"
  [ "$os" = "windows" ] && out="${out}.exe"

  local tags_arg=""
  [ -n "$tags" ] && tags_arg="-tags $tags"

  echo "==> $out  (GOOS=$os GOARCH=$arch${tags:+  tags=$tags})"

  if $native_build; then
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
      go build -trimpath $tags_arg -ldflags="$LDFLAGS" \
        -o "$OUT_DIR/$out" "$pkg"
  else
    "$RUNTIME" run --rm \
      --user "$(id -u):$(id -g)" \
      -v "$ROOT":/src -w /src \
      -v "$CACHE_DIR/go-build":/.cache/go-build \
      -v "$CACHE_DIR/go-mod":/go/pkg/mod \
      -e HOME=/tmp \
      -e GOCACHE=/.cache/go-build \
      -e GOMODCACHE=/go/pkg/mod \
      -e CGO_ENABLED=0 \
      -e GOOS="$os" -e GOARCH="$arch" \
      "$GO_IMAGE" \
      go build -trimpath $tags_arg -ldflags="$LDFLAGS" \
        -o "/src/dist/$out" "$pkg"
  fi
}

# Returns "with_rigctld" when the platform's rigctld binary has been fetched
# into the given package's rigctld-bins/ directory.  Run ./fetch-rigctld.sh
# first to populate both cmd/helper/rigctld-bins/ and
# cmd/helper-gui/rigctld-bins/.
pkg_tags() {
  local pkg_dir="$1" os="$2" arch="$3"
  local dir="$ROOT/${pkg_dir}/rigctld-bins/${os}-${arch}"
  if [ -f "$dir/rigctld" ] || [ -f "$dir/rigctld.exe" ]; then
    echo "with_rigctld"
  fi
}

if $native_build; then
  echo "Build mode    : native  ($(go env GOOS)/$(go env GOARCH))"
else
  echo "Builder image : $GO_IMAGE"
  echo "Runtime       : $RUNTIME"
fi
echo "Version       : $VERSION"
echo "Output dir    : $OUT_DIR"
echo

if $build_server; then
  for t in "${server_targets[@]}"; do
    run_build "./" "noctalum" "$t"
  done
fi

# Wraps a Linux helper binary in an AppImage.
# $1  arch (amd64 | arm64)
build_helper_appimage() {
  local arch="$1"
  local appimage_arch
  case "$arch" in amd64) appimage_arch="x86_64" ;; arm64) appimage_arch="aarch64" ;; *) return ;; esac

  local binary="$OUT_DIR/noctalum-helper-linux-${arch}"
  if [ ! -f "$binary" ]; then
    echo "    skipping AppImage linux/${arch} — binary not built"
    return
  fi

  local out="noctalum-helper-linux-${arch}.AppImage"
  echo "==> $out"

  local tmpdir="$CACHE_DIR/appimage-${arch}"
  rm -rf "$tmpdir"
  mkdir -p "$tmpdir/AppDir/usr/bin"
  cp "$binary" "$tmpdir/AppDir/usr/bin/noctalum-helper"
  chmod +x "$tmpdir/AppDir/usr/bin/noctalum-helper"
  printf '#!/bin/sh\nexec "$APPDIR/usr/bin/noctalum-helper" "$@"\n' > "$tmpdir/AppDir/AppRun"
  chmod +x "$tmpdir/AppDir/AppRun"
  printf '[Desktop Entry]\nName=Noctalum Helper\nExec=noctalum-helper\nIcon=noctalum-helper\nType=Application\nCategories=HamRadio;\n' \
    > "$tmpdir/AppDir/noctalum-helper.desktop"
  cp "$ROOT/noctalum.png" "$tmpdir/AppDir/noctalum-helper.png"

  if $native_build; then
    if ! command -v appimagetool >/dev/null 2>&1; then
      echo "    skipping AppImage — appimagetool not on PATH"
      echo "    Install from https://github.com/AppImage/AppImageKit/releases"
      rm -rf "$tmpdir"
      return
    fi
    ARCH="$appimage_arch" APPIMAGE_EXTRACT_AND_RUN=1 \
      appimagetool "$tmpdir/AppDir" "$OUT_DIR/$out" \
      && rm -f "$binary"
    rm -rf "$tmpdir"
    return
  fi

  # Docker-based: a single x86_64 image handles both arches via ARCH env var.
  local image="noctalum-appimage-tool:latest"
  if ! "$RUNTIME" image inspect "$image" >/dev/null 2>&1; then
    echo "    building $image (one-time, ~1 min)"
    if ! "$RUNTIME" build -t "$image" - <<'DOCKERFILE'
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    wget ca-certificates file
RUN wget -q "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage" \
         -O /tmp/appimagetool.AppImage \
 && chmod +x /tmp/appimagetool.AppImage \
 && cd /tmp && APPIMAGE_EXTRACT_AND_RUN=1 /tmp/appimagetool.AppImage --appimage-extract \
 && mv /tmp/squashfs-root /opt/appimagetool \
 && rm /tmp/appimagetool.AppImage
ENTRYPOINT ["/opt/appimagetool/AppRun"]
DOCKERFILE
    then
      echo "    skipping AppImage linux/${arch} — toolchain image build failed"
      rm -rf "$tmpdir"
      return
    fi
  fi

  "$RUNTIME" run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$tmpdir":/work \
    -e ARCH="$appimage_arch" \
    "$image" \
    /work/AppDir "/work/$out" \
  && mv "$tmpdir/$out" "$OUT_DIR/$out" \
  && rm -f "$binary" \
  || echo "    skipping AppImage linux/${arch} — appimagetool run failed"

  rm -rf "$tmpdir"
}

if $build_helper; then
  for t in "${helper_targets[@]}"; do
    local_os="${t%/*}" local_arch="${t#*/}"
    run_build "./cmd/helper" "noctalum-helper" "$t" "$(pkg_tags "cmd/helper" "$local_os" "$local_arch")"
    [ "$local_os" = "linux" ] && build_helper_appimage "$local_arch"
  done
fi
if $build_wsjtx; then
  for t in "${helper_targets[@]}"; do
    run_build "./cmd/wsjtx" "noctalum-wsjtx" "$t"
  done
fi
if $build_notifier; then
  notifier_targets=("${DEFAULT_NOTIFIER_TARGETS[@]}")
  [ -n "$single_target" ] && notifier_targets=("$single_target")
  for t in "${notifier_targets[@]}"; do
    run_build "./cmd/notify-telegram" "noctalum-notify-telegram" "$t"
  done
fi

# ── GUI builds (CGO required; each platform needs its own toolchain image) ──

# Shared helper: run one GUI build inside a pre-built toolchain image (or
# natively when --native is set; in that case $2 (image) is ignored).
#   $1  output filename (e.g. noctalum-helper-gui-linux-amd64)
#   $2  toolchain image name  (unused in --native mode)
#   $3  GOOS
#   $4  GOARCH
#   $5  extra -tags (beyond "desktop,production")
#   $6  extra -ldflags prefix (e.g. "-H windowsgui")
#   $7  optional --platform flag for Docker (e.g. linux/arm64)
run_gui_build() {
  local out="$1" image="$2" target_os="$3" target_arch="$4"
  local extra_tags="${5:-}" extra_ldflags="${6:-}" platform_flag="${7:-}"

  local all_tags="desktop,production"
  [ -n "$extra_tags" ] && all_tags="${all_tags},${extra_tags}"

  # Append with_rigctld if the bins are ready.
  local rtag
  rtag="$(pkg_tags "cmd/helper-gui" "$target_os" "$target_arch")"
  [ -n "$rtag" ] && all_tags="${all_tags},${rtag}"

  echo "==> $out  (CGO=1, ${target_os}/${target_arch}  tags=${all_tags})"

  if $native_build; then
    (
      cd "$ROOT/cmd/helper-gui"
      CGO_ENABLED=1 GOOS="$target_os" GOARCH="$target_arch" \
        go build -trimpath -mod=mod -tags "$all_tags" \
          -ldflags="${extra_ldflags:+${extra_ldflags} }$LDFLAGS" \
          -o "$OUT_DIR/$out" .
    )
  else
    # Use a bash array so spaces in the CC/CXX values are handled correctly.
    local cc_env=()
    [ "$target_os" = "windows" ] && cc_env=(-e CC=x86_64-w64-mingw32-gcc -e CXX=x86_64-w64-mingw32-g++)

    "$RUNTIME" run --rm \
      ${platform_flag:+--platform "$platform_flag"} \
      --user "$(id -u):$(id -g)" \
      -v "$ROOT":/src -w /src/cmd/helper-gui \
      -v "$CACHE_DIR/go-build":/.cache/go-build \
      -v "$CACHE_DIR/go-mod":/go/pkg/mod \
      -e HOME=/tmp \
      -e GOCACHE=/.cache/go-build \
      -e GOMODCACHE=/go/pkg/mod \
      -e CGO_ENABLED=1 \
      -e GOOS="$target_os" -e GOARCH="$target_arch" \
      "${cc_env[@]}" \
      "$image" \
      go build -trimpath -mod=mod -tags "$all_tags" \
        -ldflags="${extra_ldflags:+${extra_ldflags} }$LDFLAGS" \
        -o "/src/dist/$out" .
  fi
}

# gui_built / gui_skipped are populated by each build_gui_* function and
# reported in the final summary.
gui_built=()
gui_skipped=()

build_gui_linux_amd64() {
  if $native_build; then
    if run_gui_build "noctalum-helper-gui-linux-amd64" "" linux amd64 "webkit2_41"; then
      gui_built+=("linux/amd64")
    else
      echo "    skipping linux/amd64 GUI build — go build failed (libwebkit2gtk-4.1-dev installed?)"
      gui_skipped+=("linux/amd64")
    fi
    return
  fi
  local out="noctalum-helper-gui-linux-amd64.AppImage"
  echo "==> $out  (CGO=1, webkit2gtk-4.1, AppImage)"
  local gui_image="noctalum-gui-linux-amd64:appimage"
  if ! "$RUNTIME" image inspect "$gui_image" >/dev/null 2>&1; then
    echo "    building $gui_image (one-time, ~3-4 min)"
    if ! "$RUNTIME" build -t "$gui_image" - <<'DOCKERFILE'
FROM golang:1.25-bookworm
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    pkg-config build-essential \
    libgtk-3-dev libwebkit2gtk-4.1-dev \
    wget file squashfs-tools
RUN wget -q -O /usr/local/bin/appimagetool \
    https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage \
 && chmod +x /usr/local/bin/appimagetool
DOCKERFILE
    then
      echo "    skipping linux/amd64 GUI build — toolchain image build failed"
      gui_skipped+=("linux/amd64")
      return 0
    fi
  fi

  # Write the in-container packaging script to a temp file to avoid heredoc nesting issues.
  local tmpscript
  tmpscript=$(mktemp /tmp/build-gui-XXXXXX.sh)
  cat > "$tmpscript" <<'INNERSCRIPT'
#!/bin/bash
set -euo pipefail
cd /src/cmd/helper-gui

go build -trimpath -tags "desktop,production,webkit2_41" \
  -ldflags="${LDFLAGS}" \
  -o /tmp/noctalum-helper-gui .

APPDIR=/tmp/AppDir
rm -rf "${APPDIR}"
mkdir -p "${APPDIR}/usr/bin"
cp /tmp/noctalum-helper-gui "${APPDIR}/usr/bin/noctalum-helper-gui"
ln -sf usr/bin/noctalum-helper-gui "${APPDIR}/AppRun"

cat > "${APPDIR}/noctalum-helper-gui.desktop" <<'DESKTOPEOF'
[Desktop Entry]
Name=ContestLog Helper GUI
Exec=noctalum-helper-gui
Icon=noctalum-helper-gui
Type=Application
Categories=HamRadio;
DESKTOPEOF

cp /src/noctalum.png "${APPDIR}/noctalum-helper-gui.png"

APPIMAGE_EXTRACT_AND_RUN=1 appimagetool "${APPDIR}" "/src/dist/${OUTPUT}"
INNERSCRIPT
  chmod +x "$tmpscript"

  if "$RUNTIME" run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$ROOT":/src \
    -v "$tmpscript":/build-gui.sh:ro \
    -v "$CACHE_DIR/go-build":/.cache/go-build \
    -v "$CACHE_DIR/go-mod":/go/pkg/mod \
    -e HOME=/tmp \
    -e GOCACHE=/.cache/go-build \
    -e GOMODCACHE=/go/pkg/mod \
    -e CGO_ENABLED=1 \
    -e LDFLAGS="$LDFLAGS" \
    -e OUTPUT="$out" \
    "$gui_image" \
    bash /build-gui.sh; then
    gui_built+=("linux/amd64")
  else
    echo "    skipping linux/amd64 GUI build — build/package failed"
    gui_skipped+=("linux/amd64")
  fi
  rm -f "$tmpscript"
}

build_gui_linux_arm64() {
  if $native_build; then
    if run_gui_build "noctalum-helper-gui-linux-arm64" "" linux arm64 "webkit2_41"; then
      gui_built+=("linux/arm64")
    else
      echo "    skipping linux/arm64 GUI build — go build failed (cross-CGO not supported natively; run on arm64 hardware)"
      gui_skipped+=("linux/arm64")
    fi
    return
  fi
  local image="noctalum-gui-linux-arm64:latest"

  # If the image exists but is the wrong architecture (e.g. built without QEMU)
  # remove it so we try again rather than running the wrong binary silently.
  local existing_arch
  existing_arch="$("$RUNTIME" image inspect "$image" --format '{{.Architecture}}' 2>/dev/null || true)"
  if [ -n "$existing_arch" ] && [ "$existing_arch" != "arm64" ]; then
    echo "    removing stale ${existing_arch} image, rebuilding as arm64"
    "$RUNTIME" rmi "$image" >/dev/null 2>&1 || true
    existing_arch=""
  fi

  if [ -z "$existing_arch" ]; then
    echo "    building $image (one-time, ~5-10 min, needs QEMU arm64)"
    echo "    If this fails, enable QEMU first:"
    echo "      docker run --rm --privileged multiarch/qemu-user-static --reset -p yes"
    if ! "$RUNTIME" build --platform linux/arm64 -t "$image" - <<'DOCKERFILE'
FROM golang:1.25-bookworm
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    pkg-config build-essential \
    libgtk-3-dev libwebkit2gtk-4.1-dev
DOCKERFILE
    then
      echo "    skipping linux/arm64 GUI build — arm64 Docker image build failed (no QEMU?)"
      gui_skipped+=("linux/arm64")
      return 0
    fi
  fi

  if ! run_gui_build "noctalum-helper-gui-linux-arm64" "$image" linux arm64 "webkit2_41" "" "linux/arm64"; then
    echo "    skipping linux/arm64 GUI build — run failed (no QEMU arm64 emulation?)"
    echo "    Enable with: docker run --rm --privileged multiarch/qemu-user-static --reset -p yes"
    gui_skipped+=("linux/arm64")
    return 0
  fi
  gui_built+=("linux/arm64")
}

build_gui_windows_amd64() {
  if $native_build; then
    # -H windowsgui suppresses the console window on Windows.
    if run_gui_build "noctalum-helper-gui-windows-amd64.exe" "" windows amd64 "" "-H windowsgui"; then
      gui_built+=("windows/amd64")
    else
      echo "    skipping windows/amd64 GUI build — go build failed (mingw-w64 + WebView2 SDK required natively)"
      gui_skipped+=("windows/amd64")
    fi
    return
  fi
  local image="noctalum-gui-windows-amd64:latest"
  if ! "$RUNTIME" image inspect "$image" >/dev/null 2>&1; then
    echo "    building $image (one-time, ~3-5 min)"
    if ! "$RUNTIME" build -t "$image" - <<'DOCKERFILE'
FROM golang:1.25-bookworm
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    gcc-mingw-w64-x86-64
DOCKERFILE
    then
      echo "    skipping windows/amd64 GUI build — toolchain image build failed"
      gui_skipped+=("windows/amd64")
      return 0
    fi
  fi
  # -H windowsgui suppresses the console window on Windows.
  if run_gui_build "noctalum-helper-gui-windows-amd64.exe" "$image" windows amd64 "" "-H windowsgui"; then
    gui_built+=("windows/amd64")
  else
    echo "    skipping windows/amd64 GUI build — go build failed"
    gui_skipped+=("windows/amd64")
  fi
}

# macOS GUI builds require Xcode / the macOS SDK and cannot be cross-compiled
# from Linux.  Run `wails build` natively on a Mac and copy the resulting
# binary into the downloads directory (see cmd/helper-gui/README.md).

if $build_gui; then
  if $native_build && [ -z "$single_target" ]; then
    # In native mode without an explicit --target, only build for this machine.
    # CGO cross-compilation requires the target's sysroot; that's the whole
    # point of the Docker toolchain images.
    native_os="$(go env GOOS)"
    native_arch="$(go env GOARCH)"
    case "${native_os}/${native_arch}" in
      linux/amd64)   build_gui_linux_amd64 ;;
      linux/arm64)   build_gui_linux_arm64 ;;
      windows/amd64) build_gui_windows_amd64 ;;
      darwin/*)
        echo "  macOS GUI: run 'wails build' natively on a Mac (see cmd/helper-gui/README.md)"
        gui_skipped+=("${native_os}/${native_arch}") ;;
      *)
        echo "  GUI: no native build defined for ${native_os}/${native_arch}"
        gui_skipped+=("${native_os}/${native_arch}") ;;
    esac
  else
    build_gui_linux_amd64
    build_gui_linux_arm64
    build_gui_windows_amd64
  fi
fi

# ── C++ AppImage builds (Linux-only, native cmake, opt-in via default) ──

cpp_built=()
cpp_skipped=()

# check_cmd COMMAND ...  — returns 0 if every argument is on $PATH.
check_cmd() {
  local ok=true
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || { echo "    missing: $c" >&2; ok=false; }
  done
  $ok
}

# Ensure appimagetool is available under $CACHE_DIR/bin/appimagetool; downloads
# once from the AppImageKit continuous release.  Prints its path on stdout.
ensure_appimagetool() {
  local bin="$CACHE_DIR/bin/appimagetool"
  if [ ! -x "$bin" ]; then
    mkdir -p "$CACHE_DIR/bin"
    local url="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-$(uname -m).AppImage"
    echo "    fetching appimagetool from $url" >&2
    if ! wget -q -O "$bin" "$url"; then rm -f "$bin"; return 1; fi
    chmod +x "$bin"
  fi
  echo "$bin"
}

# Ensure linuxdeploy + linuxdeploy-plugin-qt are available for the Qt GUI.
# Both are downloaded to $CACHE_DIR/bin/ if missing.  Returns 0 on success.
ensure_linuxdeploy_qt() {
  mkdir -p "$CACHE_DIR/bin"
  local ld="$CACHE_DIR/bin/linuxdeploy"
  local qt="$CACHE_DIR/bin/linuxdeploy-plugin-qt"
  local arch; arch="$(uname -m)"
  if [ ! -x "$ld" ]; then
    echo "    fetching linuxdeploy" >&2
    wget -q -O "$ld" "https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-${arch}.AppImage" || return 1
    chmod +x "$ld"
  fi
  if [ ! -x "$qt" ]; then
    echo "    fetching linuxdeploy-plugin-qt" >&2
    wget -q -O "$qt" "https://github.com/linuxdeploy/linuxdeploy-plugin-qt/releases/download/continuous/linuxdeploy-plugin-qt-${arch}.AppImage" || return 1
    chmod +x "$qt"
  fi
  return 0
}

# Configure + build one cpp/ project with cmake+ninja.  On success prints the
# absolute path to the compiled binary on stdout.
cmake_build() {
  local project="$1" binary="$2"
  local src="$ROOT/cpp/$project"
  local build="$CACHE_DIR/cpp-build/$project"
  rm -rf "$build" && mkdir -p "$build"
  ( cd "$build" && cmake -G Ninja -DCMAKE_BUILD_TYPE=Release "$src" >/dev/null && ninja ) >&2 || return 1
  echo "$build/$binary"
}

# Package a single CLI-only binary into an AppImage.  $1 project dir, $2 binary
# name, $3 output AppImage filename.
package_cli_appimage() {
  local project="$1" binary="$2" out="$3"
  local bin_path
  bin_path="$(cmake_build "$project" "$binary")" || return 1

  local tool; tool="$(ensure_appimagetool)" || return 1
  local appdir="$CACHE_DIR/cpp-appdir/$project"
  rm -rf "$appdir"
  mkdir -p "$appdir/usr/bin"
  cp "$bin_path" "$appdir/usr/bin/$binary"
  chmod +x "$appdir/usr/bin/$binary"
  printf '#!/bin/sh\nexec "$APPDIR/usr/bin/%s" "$@"\n' "$binary" > "$appdir/AppRun"
  chmod +x "$appdir/AppRun"
  cat > "$appdir/$binary.desktop" <<EOF
[Desktop Entry]
Name=$binary
Exec=$binary
Icon=$binary
Type=Application
Categories=HamRadio;
EOF
  cp "$ROOT/noctalum.png" "$appdir/$binary.png"

  ARCH="$(uname -m)" APPIMAGE_EXTRACT_AND_RUN=1 "$tool" "$appdir" "$OUT_DIR/$out" >/dev/null || return 1
}

# Package a Qt6 GUI project as an AppImage: linuxdeploy + qt plugin bundles
# Qt6 libs so the AppImage runs on hosts without matching Qt6 packages.
#   $1 project subdir under cpp/           (e.g. "helper-gui")
#   $2 built binary name                   (e.g. "noctalum-helper-gui")
#   $3 human-readable name for .desktop    (e.g. "Noctalum Helper (C++)")
#   $4 output AppImage filename            (e.g. "noctalum-helper-gui-cpp-linux-amd64.AppImage")
package_gui_appimage() {
  local project="$1" binary="$2" desktop_name="$3" out="$4"
  local bin_path
  bin_path="$(cmake_build "$project" "$binary")" || return 1

  ensure_linuxdeploy_qt || return 1
  local ld="$CACHE_DIR/bin/linuxdeploy"
  local appdir="$CACHE_DIR/cpp-appdir/$project"
  rm -rf "$appdir"
  mkdir -p "$appdir/usr/bin" "$appdir/usr/share/applications" "$appdir/usr/share/icons/hicolor/256x256/apps"
  cp "$bin_path" "$appdir/usr/bin/$binary"
  chmod +x "$appdir/usr/bin/$binary"
  cat > "$appdir/usr/share/applications/$binary.desktop" <<EOF
[Desktop Entry]
Name=$desktop_name
Exec=$binary
Icon=$binary
Type=Application
Categories=HamRadio;
EOF
  cp "$ROOT/noctalum.png" "$appdir/usr/share/icons/hicolor/256x256/apps/$binary.png"

  # linuxdeploy-plugin-qt needs its runner discoverable on PATH.  Route its
  # (chatty) output through a scratch file so we can print it only on failure.
  local logf; logf="$(mktemp)"
  if ! PATH="$CACHE_DIR/bin:$PATH" APPIMAGE_EXTRACT_AND_RUN=1 \
       "$ld" --appdir "$appdir" --plugin qt --output appimage \
       --desktop-file "$appdir/usr/share/applications/$binary.desktop" \
       >"$logf" 2>&1; then
    echo "    linuxdeploy failed — see $logf" >&2
    tail -15 "$logf" >&2
    return 1
  fi
  rm -f "$logf"

  # linuxdeploy writes the AppImage into $PWD; move to dist/ under our name.
  local produced
  produced=$(ls -1 Noctalum*.AppImage noctalum*.AppImage 2>/dev/null | head -1)
  if [ -z "$produced" ]; then
    echo "    linuxdeploy produced no *.AppImage in $(pwd)" >&2
    return 1
  fi
  mv "$produced" "$OUT_DIR/$out"
}

# ── C++ builds ─────────────────────────────────────────────────────────
#
# Three per-platform Docker images (built once, cached in the local Docker
# storage), one native fallback via `--native` for the Linux side.  Each
# helper wraps a `cmake --build && package` sequence that runs inside the
# container; the container mounts $ROOT and writes the final artefact into
# $OUT_DIR.  If any requested build fails, the enclosing script exits
# non-zero (set -e), which cascades into deploy.sh aborting.

cpp_built=()
cpp_skipped=()   # only populated by explicit --cpp-no-* opt-outs

# Detect the current CPU arch used for AppImage packaging + image tags.
cpp_host_arch() {
  case "$(uname -m)" in
    x86_64)  echo "amd64" ;;
    aarch64) echo "arm64" ;;
    *) return 1 ;;
  esac
}

# ── Native fallback (Linux only, for --native mode) ─────────────────────

build_cpp_linux_native() {
  echo "==> C++ AppImages (Linux, native)"
  if [ "$(uname -s)" != "Linux" ]; then
    echo "error: --native + --cpp only supports Linux (host is $(uname -s))" >&2
    return 1
  fi
  if ! check_cmd cmake ninja g++ pkg-config wget; then
    echo "error: native C++ build needs cmake/ninja-build/g++/pkg-config/wget" >&2
    return 1
  fi
  local arch; arch="$(cpp_host_arch)" || {
    echo "error: unsupported CPU arch $(uname -m)" >&2; return 1;
  }

  local out
  out="noctalum-wsjtx-cpp-linux-${arch}.AppImage"
  echo "==> $out"
  if ! pkg-config --exists libcurl nlohmann_json; then
    echo "error: missing libcurl4-openssl-dev or nlohmann-json3-dev" >&2; return 1
  fi
  package_cli_appimage "wsjtx" "noctalum-wsjtx" "$out" || return 1
  cpp_built+=("wsjtx-cpp/linux/${arch}")

  out="noctalum-helper-cpp-linux-${arch}.AppImage"
  echo "==> $out"
  if ! pkg-config --exists libwebsockets nlohmann_json; then
    echo "error: missing libwebsockets-dev/nlohmann-json3-dev/libncurses-dev" >&2; return 1
  fi
  package_cli_appimage "helper" "noctalum-helper" "$out" || return 1
  cpp_built+=("helper-cpp/linux/${arch}")

  out="noctalum-helper-gui-cpp-linux-${arch}.AppImage"
  echo "==> $out"
  if ! pkg-config --exists Qt6Core Qt6Widgets Qt6WebSockets Qt6SerialPort; then
    echo "error: missing qt6-base-dev/libqt6websockets6-dev/libqt6serialport6-dev" >&2; return 1
  fi
  package_gui_appimage "helper-gui" "noctalum-helper-gui" \
                       "Noctalum Helper (C++)" "$out" || return 1
  cpp_built+=("helper-gui-cpp/linux/${arch}")

  out="noctalum-wsjtx-gui-linux-${arch}.AppImage"
  echo "==> $out"
  if ! pkg-config --exists Qt6Core Qt6Widgets Qt6Network; then
    echo "error: missing qt6-base-dev" >&2; return 1
  fi
  package_gui_appimage "wsjtx-gui" "noctalum-wsjtx-gui" \
                       "Noctalum WSJT-X Bridge" "$out" || return 1
  cpp_built+=("wsjtx-gui/linux/${arch}")
}

# ── Docker path: one image per target OS ────────────────────────────────

# Build the Ubuntu-based C++ Linux image (Qt6 + libcurl + libwebsockets +
# ncurses + nlohmann-json + linuxdeploy + appimagetool bundled in).
ensure_cpp_linux_image() {
  local image="noctalum-cpp-linux:latest"
  if "$RUNTIME" image inspect "$image" >/dev/null 2>&1; then return 0; fi
  echo "    building $image (one-time, ~4-6 min)"
  # Debian bookworm packages all three Qt6 modules we need (base, websockets,
  # serialport) — Ubuntu 22.04 is missing the last two, and 24.04 gets us
  # glibc 2.39 which makes the AppImage too new for older desktops.  Bookworm
  # sits at glibc 2.36 and covers every distro from Debian 12 / Ubuntu 22.04
  # onward.
  "$RUNTIME" build -t "$image" - <<'DOCKERFILE' >&2
FROM debian:bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      cmake ninja-build g++ pkg-config \
      wget file ca-certificates xz-utils patchelf \
      qt6-base-dev libqt6websockets6-dev libqt6serialport6-dev \
      libcurl4-openssl-dev nlohmann-json3-dev \
      libwebsockets-dev libncurses-dev libssl-dev \
      libgl-dev libxkbcommon-dev libfontconfig1-dev \
 && rm -rf /var/lib/apt/lists/*
# Bake linuxdeploy + qt plugin + appimagetool into the image so nothing is
# fetched at build time (build hosts might be air-gapped between runs).
RUN wget -q -O /usr/local/bin/linuxdeploy \
      https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage \
 && wget -q -O /usr/local/bin/linuxdeploy-plugin-qt \
      https://github.com/linuxdeploy/linuxdeploy-plugin-qt/releases/download/continuous/linuxdeploy-plugin-qt-x86_64.AppImage \
 && wget -q -O /usr/local/bin/appimagetool \
      https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage \
 && chmod +x /usr/local/bin/linuxdeploy /usr/local/bin/linuxdeploy-plugin-qt /usr/local/bin/appimagetool
ENV APPIMAGE_EXTRACT_AND_RUN=1
DOCKERFILE
}

build_cpp_linux_docker() {
  local arch; arch="$(cpp_host_arch)" || {
    echo "error: unsupported host arch $(uname -m) — cannot cross-arch C++ builds" >&2
    return 1
  }
  ensure_cpp_linux_image || {
    echo "error: noctalum-cpp-linux image build failed" >&2; return 1
  }

  # In-container build script: does all four cmake+package steps.  Writes
  # AppImages to /out (== $OUT_DIR).  Any failure exits non-zero and the
  # outer `set -e` catches it.
  local script; script="$(mktemp)"
  cat > "$script" <<INNERSCRIPT
#!/bin/bash
set -euo pipefail
ROOT=/src
OUT=/out
ARCH="${arch}"
BUILD=/tmp/build
mkdir -p "\$BUILD"

# Reusable cmake configure+build.  Puts the binary at \$BUILD/<project>/<binary>.
# Both cmake and ninja are piped to stderr so their progress output doesn't
# contaminate the stdout capture in pack_cli/pack_gui (\`bin=\$(cmake_one ...)\`).
cmake_one() {
  local project="\$1" binary="\$2"
  rm -rf "\$BUILD/\$project" && mkdir -p "\$BUILD/\$project"
  ( cd "\$BUILD/\$project" \
    && cmake -G Ninja -DCMAKE_BUILD_TYPE=Release "\$ROOT/cpp/\$project" \
    && ninja ) >&2
  echo "\$BUILD/\$project/\$binary"
}

# CLI AppImage: appimagetool wraps the binary as-is (no shared libs bundled).
pack_cli() {
  local project="\$1" binary="\$2" out="\$3"
  local bin; bin="\$(cmake_one "\$project" "\$binary")"
  local ad="\$BUILD/appdir-\$project"
  rm -rf "\$ad" && mkdir -p "\$ad/usr/bin"
  cp "\$bin" "\$ad/usr/bin/\$binary"; chmod +x "\$ad/usr/bin/\$binary"
  printf '#!/bin/sh\nexec "\$APPDIR/usr/bin/%s" "\$@"\n' "\$binary" > "\$ad/AppRun"
  chmod +x "\$ad/AppRun"
  cat > "\$ad/\$binary.desktop" <<DESKTOP
[Desktop Entry]
Name=\$binary
Exec=\$binary
Icon=\$binary
Type=Application
Categories=HamRadio;
DESKTOP
  cp "\$ROOT/noctalum.png" "\$ad/\$binary.png"
  ARCH=x86_64 appimagetool "\$ad" "\$OUT/\$out" >/dev/null
}

# GUI AppImage: linuxdeploy + qt plugin bundles all Qt6 shared libs.  Runs
# in a scratch cwd so linuxdeploy's PWD-drop AppImage naming is contained.
pack_gui() {
  local project="\$1" binary="\$2" desktop_name="\$3" out="\$4"
  local bin; bin="\$(cmake_one "\$project" "\$binary")"
  local ad="\$BUILD/appdir-\$project"
  rm -rf "\$ad"
  mkdir -p "\$ad/usr/bin" \
           "\$ad/usr/share/applications" \
           "\$ad/usr/share/icons/hicolor/256x256/apps"
  cp "\$bin" "\$ad/usr/bin/\$binary"; chmod +x "\$ad/usr/bin/\$binary"
  cat > "\$ad/usr/share/applications/\$binary.desktop" <<DESKTOP
[Desktop Entry]
Name=\$desktop_name
Exec=\$binary
Icon=\$binary
Type=Application
Categories=HamRadio;
DESKTOP
  cp "\$ROOT/noctalum.png" "\$ad/usr/share/icons/hicolor/256x256/apps/\$binary.png"

  local wd="\$BUILD/appdir-out-\$project"
  rm -rf "\$wd" && mkdir -p "\$wd"
  ( cd "\$wd" && linuxdeploy --appdir "\$ad" --plugin qt --output appimage \
        --desktop-file "\$ad/usr/share/applications/\$binary.desktop" ) >/dev/null
  local produced; produced=\$(ls -1 "\$wd"/*.AppImage 2>/dev/null | head -1)
  if [ -z "\$produced" ]; then
    echo "error: linuxdeploy produced no AppImage in \$wd" >&2
    return 1
  fi
  mv "\$produced" "\$OUT/\$out"
}

pack_cli "wsjtx"      "noctalum-wsjtx"      "noctalum-wsjtx-cpp-linux-\${ARCH}.AppImage"
pack_cli "helper"     "noctalum-helper"     "noctalum-helper-cpp-linux-\${ARCH}.AppImage"
pack_gui "helper-gui" "noctalum-helper-gui" "Noctalum Helper (C++)"   "noctalum-helper-gui-cpp-linux-\${ARCH}.AppImage"
pack_gui "wsjtx-gui"  "noctalum-wsjtx-gui"  "Noctalum WSJT-X Bridge"  "noctalum-wsjtx-gui-linux-\${ARCH}.AppImage"
INNERSCRIPT
  chmod +x "$script"

  "$RUNTIME" run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$ROOT":/src:ro \
    -v "$OUT_DIR":/out \
    -v "$script":/build.sh:ro \
    noctalum-cpp-linux:latest \
    bash /build.sh
  local rc=$?
  rm -f "$script"
  if [ $rc -ne 0 ]; then
    echo "error: C++ Linux build failed (exit $rc)" >&2
    return 1
  fi
  cpp_built+=("wsjtx-cpp/linux/${arch}" "helper-cpp/linux/${arch}"
              "helper-gui-cpp/linux/${arch}" "wsjtx-gui/linux/${arch}")
}

# ── Windows cross-compile (MXE on Debian bullseye) ──────────────────────

ensure_cpp_windows_image() {
  local image="noctalum-cpp-windows:latest"
  if "$RUNTIME" image inspect "$image" >/dev/null 2>&1; then return 0; fi
  echo "    building $image (one-time, ~4-6 min)"
  # Fedora ships dynamic mingw64-qt6-qtbase (Widgets+Network+Core+Gui) via
  # its MinGW SIG.  The -static variants I originally reached for don't
  # actually exist in Fedora's repos, and neither do qtserialport /
  # qtwebsockets for mingw64 at the time of writing.  That constrains
  # what we can cross-compile from Linux:
  #
  #   wsjtx-gui   needs Widgets + Network → cross-compiles fine
  #   helper-gui  needs Widgets + Network + WebSockets + SerialPort →
  #               can't be built here.  The Go/Wails helper-gui at
  #               cmd/helper-gui already covers Windows via a separate
  #               toolchain (see build_gui_windows_amd64 above), so
  #               operators aren't left without a Windows helper.
  #
  # We ship the resulting wsjtx-gui.exe as a zipped bundle containing
  # the exe plus the required Qt6 DLLs and the qwindows platform plugin
  # (Qt's cross-platform-plugin plumbing needs it next to the exe under
  # platforms/qwindows.dll).
  "$RUNTIME" build -t "$image" - <<'DOCKERFILE' >&2
FROM fedora:41
RUN dnf install -y --setopt=install_weak_deps=False \
      cmake ninja-build file zip which findutils \
      mingw64-gcc mingw64-gcc-c++ mingw64-winpthreads \
      mingw64-qt6-qtbase \
 && dnf clean all
DOCKERFILE
}

build_cpp_windows_docker() {
  ensure_cpp_windows_image || {
    echo "error: noctalum-cpp-windows image build failed (Fedora mingw64-qt6-qtbase still available?)" >&2
    return 1
  }

  local script; script="$(mktemp)"
  cat > "$script" <<'INNERSCRIPT'
#!/bin/bash
set -euo pipefail
ROOT=/src
OUT=/out
BUILD=/tmp/build
QT_SYSROOT=/usr/x86_64-w64-mingw32/sys-root/mingw
QT_BIN="$QT_SYSROOT/bin"
QT_PLUGINS="$QT_SYSROOT/lib/qt6/plugins"
mkdir -p "$BUILD"

# Iterative DLL walker: given a PE binary, follow its import table via
# objdump and copy every referenced DLL that lives in the mingw sysroot
# into $dst.  Skips system DLLs (kernel32, user32, …) that already exist
# on every Windows install.
copy_deps() {
  local exe="$1" dst="$2"
  local queue=("$exe") seen=""
  while [ ${#queue[@]} -gt 0 ]; do
    local file="${queue[0]}"
    queue=("${queue[@]:1}")
    for dll in $(x86_64-w64-mingw32-objdump -p "$file" 2>/dev/null \
                 | awk '/DLL Name:/ {print $3}'); do
      case " $seen " in *" $dll "*) continue ;; esac
      seen="$seen $dll"
      if [ -f "$QT_BIN/$dll" ] && [ ! -f "$dst/$dll" ]; then
        cp "$QT_BIN/$dll" "$dst/"
        queue+=("$dst/$dll")
      fi
    done
  done
}

pack_win_gui() {
  local project="$1" binary="$2" out_zip="$3"
  local bd="$BUILD/$project"
  rm -rf "$bd" && mkdir -p "$bd"
  # mingw64-cmake is a Fedora wrapper that runs cmake with the mingw64
  # toolchain preloaded — only valid for configure.  Once the build tree
  # is generated we drive Ninja directly for the compile step.
  ( cd "$bd" \
    && mingw64-cmake -G Ninja -DCMAKE_BUILD_TYPE=Release "$ROOT/cpp/$project" \
    && ninja ) >&2
  local exe="$bd/${binary}.exe"
  [ -f "$exe" ] || { echo "no $exe produced" >&2; return 1; }

  # Assemble a bundle dir with the exe + its DLLs + the qwindows platform
  # plugin.  Qt loads the platform plugin from ./platforms/ next to the
  # exe on Windows; without it the app dies with "no Qt platform plugin".
  local bundle="$bd/bundle"
  rm -rf "$bundle" && mkdir -p "$bundle/platforms"
  cp "$exe" "$bundle/"
  cp "$QT_PLUGINS/platforms/qwindows.dll" "$bundle/platforms/"
  copy_deps "$exe" "$bundle"
  # Platform plugin has its own DLL deps — scan it too.
  copy_deps "$bundle/platforms/qwindows.dll" "$bundle"

  ( cd "$bundle" && zip -qr "$OUT/$out_zip" . )
}

# wsjtx-gui: only project whose Qt6 dependency set (Widgets + Network)
# is fully covered by the modules Fedora ships in mingw64-qt6-qtbase.
pack_win_gui "wsjtx-gui" "noctalum-wsjtx-gui" "noctalum-wsjtx-gui-windows-amd64.zip"
INNERSCRIPT
  chmod +x "$script"

  "$RUNTIME" run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$ROOT":/src:ro \
    -v "$OUT_DIR":/out \
    -v "$script":/build.sh:ro \
    noctalum-cpp-windows:latest \
    bash /build.sh
  local rc=$?
  rm -f "$script"
  if [ $rc -ne 0 ]; then
    echo "error: C++ Windows build failed (exit $rc)" >&2
    return 1
  fi
  cpp_built+=("wsjtx-gui/windows/amd64")
}

# ── macOS cross-compile (osxcross with user-supplied SDK) ───────────────

# The SDK tarball has to come from a Mac the user owns — Apple's SDK
# license forbids redistribution.  See cpp/third_party/osxcross-sdk/README.
CPP_OSXCROSS_SDK_DIR="$ROOT/cpp/third_party/osxcross-sdk"

ensure_cpp_macos_image() {
  local image="noctalum-cpp-macos:latest"
  if "$RUNTIME" image inspect "$image" >/dev/null 2>&1; then return 0; fi

  local sdk
  sdk="$(ls "$CPP_OSXCROSS_SDK_DIR"/MacOSX*.sdk.tar.xz 2>/dev/null | sort | tail -1 || true)"
  if [ -z "$sdk" ]; then
    cat >&2 <<EOF
error: no macOS SDK found at $CPP_OSXCROSS_SDK_DIR/MacOSX*.sdk.tar.xz
       See $CPP_OSXCROSS_SDK_DIR/README for how to package it from a Mac.
       Or pass --cpp-no-macos to skip the macOS cross-compile.
EOF
    return 1
  fi
  echo "    building $image (one-time, ~15-25 min — compiles osxcross + Qt6 static from source)"

  # Build context: the SDK tarball + our Dockerfile.  We hand-craft the
  # context tar so the multi-GB SDK stays out of the daemon's parent-dir
  # scan.
  local ctx; ctx="$(mktemp -d)"
  cp "$sdk" "$ctx/sdk.tar.xz"
  cat > "$ctx/Dockerfile" <<'DOCKERFILE'
FROM debian:bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      clang cmake ninja-build make patch git python3 \
      libssl-dev liblzma-dev libxml2-dev libbz2-dev zlib1g-dev \
      libtool automake autoconf pkg-config \
      ca-certificates wget file xz-utils zip \
      gcc g++ libc6-dev \
 && rm -rf /var/lib/apt/lists/*

# osxcross toolchain from source, pinned to a known-good commit.
WORKDIR /opt
RUN git clone --depth 1 https://github.com/tpoechtrager/osxcross
COPY sdk.tar.xz /opt/osxcross/tarballs/
RUN cd /opt/osxcross && UNATTENDED=1 ./build.sh \
 && rm -rf tarballs build
ENV PATH="/opt/osxcross/target/bin:$PATH"
ENV OSXCROSS_HOST=x86_64-apple-darwin
ENV OSXCROSS_TARGET_DIR=/opt/osxcross/target
ENV MACOSX_DEPLOYMENT_TARGET=11.0

# Qt6 built from source with only the modules we need, static, universal-
# free (x86_64 only — arm64 needs a matching SDK).  A single static Qt
# saves us from bundling per-plugin dylibs into every .app.
RUN mkdir -p /opt/qt6-src /opt/qt6-build /opt/qt6-mac \
 && cd /opt/qt6-src \
 && wget -q https://download.qt.io/archive/qt/6.7/6.7.3/single/qt-everywhere-src-6.7.3.tar.xz \
 && tar xf qt-everywhere-src-6.7.3.tar.xz --strip-components=1 \
 && rm qt-everywhere-src-6.7.3.tar.xz \
 && cd /opt/qt6-build \
 && /opt/qt6-src/configure -release -static -prefix /opt/qt6-mac \
      -platform linux-clang -xplatform macx-clang \
      -device-option QMAKE_APPLE_DEVICE_ARCHS=x86_64 \
      -device-option CROSS_COMPILE=/opt/osxcross/target/bin/x86_64-apple-darwin- \
      -skip qtdeclarative -skip qtquick3d -skip qt3d -skip qtmultimedia \
      -skip qtwebengine -skip qtdoc -skip qttools -skip qtsvg -skip qtlocation \
      -no-feature-testlib -no-feature-sql -no-feature-cups -no-feature-printer \
      -submodules qtbase,qtserialport,qtwebsockets \
      -opensource -confirm-license \
 && cmake --build . --parallel \
 && cmake --install . \
 && rm -rf /opt/qt6-src /opt/qt6-build

ENV Qt6_DIR=/opt/qt6-mac/lib/cmake/Qt6
DOCKERFILE
  "$RUNTIME" build -t "$image" "$ctx" >&2
  local rc=$?
  rm -rf "$ctx"
  return $rc
}

build_cpp_macos_docker() {
  ensure_cpp_macos_image || {
    echo "error: noctalum-cpp-macos image build failed" >&2
    return 1
  }

  local script; script="$(mktemp)"
  cat > "$script" <<'INNERSCRIPT'
#!/bin/bash
set -euo pipefail
ROOT=/src
OUT=/out
BUILD=/tmp/build
mkdir -p "$BUILD"

pack_mac() {
  local project="$1" binary="$2" bundle="$3" arch="$4" out="$5"
  local bd="$BUILD/$project-$arch"
  rm -rf "$bd" && mkdir -p "$bd"
  cd "$bd"
  cmake -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_TOOLCHAIN_FILE=/opt/osxcross/target/toolchain.cmake \
        -DCMAKE_OSX_ARCHITECTURES="$arch" \
        -DQt6_DIR="$Qt6_DIR" \
        "$ROOT/cpp/$project" >/dev/null
  ninja
  # cmake's MACOSX_BUNDLE property should have produced $binary.app; if
  # not (e.g. the project's CMakeLists didn't set BUNDLE), fall through.
  local app
  if [ -d "$binary.app" ]; then
    app="$binary.app"
  else
    app="${binary}.app"
    rm -rf "$app"
    mkdir -p "$app/Contents/MacOS"
    cp "$binary" "$app/Contents/MacOS/$binary"
    cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$bundle</string>
  <key>CFBundleExecutable</key><string>$binary</string>
  <key>CFBundleIdentifier</key><string>org.noctalum.$binary</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
</dict></plist>
PLIST
  fi
  # Zip the bundle since macOS Gatekeeper strips the executable bit from
  # loose .app trees delivered over HTTP.  Users unzip → right-click → Open.
  ( cd "$bd" && zip -qr "$OUT/$out" "$binary.app" )
}

# Only x86_64 for now — arm64 needs a matching arm64 SDK tarball; when
# both are provided we can lipo two bundles into one universal binary.
pack_mac "wsjtx-gui"  "noctalum-wsjtx-gui"  "Noctalum WSJT-X Bridge" x86_64 \
         "noctalum-wsjtx-gui-darwin-amd64.zip"
pack_mac "helper-gui" "noctalum-helper-gui" "Noctalum Helper"        x86_64 \
         "noctalum-helper-gui-cpp-darwin-amd64.zip"
INNERSCRIPT
  chmod +x "$script"

  "$RUNTIME" run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$ROOT":/src:ro \
    -v "$OUT_DIR":/out \
    -v "$script":/build.sh:ro \
    noctalum-cpp-macos:latest \
    bash /build.sh
  local rc=$?
  rm -f "$script"
  if [ $rc -ne 0 ]; then
    echo "error: C++ macOS build failed (exit $rc)" >&2
    return 1
  fi
  cpp_built+=("wsjtx-gui/darwin/amd64" "helper-gui-cpp/darwin/amd64")
}

# ── Dispatch ────────────────────────────────────────────────────────────

if $build_cpp; then
  if $native_build; then
    build_cpp_linux_native
    if $build_cpp_windows; then
      echo "error: --native + Windows cross-compile is not supported" >&2
      echo "       drop --native (Docker path) or pass --cpp-no-windows" >&2
      exit 1
    fi
    if $build_cpp_macos; then
      echo "error: --native + macOS cross-compile is not supported" >&2
      echo "       drop --native (Docker path) or pass --cpp-no-macos" >&2
      exit 1
    fi
  else
    echo "==> C++ Linux (Docker)"
    build_cpp_linux_docker
    if $build_cpp_windows; then
      echo "==> C++ Windows (Docker + MXE)"
      build_cpp_windows_docker
    else
      cpp_skipped+=("windows/amd64  (--cpp-no-windows)")
    fi
    if $build_cpp_macos; then
      echo "==> C++ macOS (Docker + osxcross)"
      build_cpp_macos_docker
    else
      cpp_skipped+=("darwin/amd64  (--cpp-no-macos)")
    fi
  fi
fi

echo
echo "Done. Artifacts:"
ls -lh "$OUT_DIR" | awk 'NR>1 {printf "  %-40s %s\n", $9, $5}'
if $build_gui; then
  [ ${#gui_built[@]} -gt 0 ]   && echo "GUI built  : ${gui_built[*]}"
  [ ${#gui_skipped[@]} -gt 0 ] && echo "GUI skipped: ${gui_skipped[*]}  (see messages above)"
fi
if $build_cpp; then
  [ ${#cpp_built[@]} -gt 0 ]   && echo "C++ built  : ${cpp_built[*]}"
  [ ${#cpp_skipped[@]} -gt 0 ] && echo "C++ skipped: ${cpp_skipped[*]}  (see messages above)"
fi
