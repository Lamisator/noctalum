#!/usr/bin/env bash
# Cross-compile Noctalum binaries inside a Docker (or Podman) container.
# No local Go toolchain is required.
#
# Defaults build the server for Linux, and the helper for Linux (as AppImage),
# macOS, and Windows (so each operator can grab the right binary for their PC).
#
# Usage:
#   ./build.sh                          # build everything (server, helper, wsjtx, GUI)
#   ./build.sh --server-only            # only the noctalum server
#   ./build.sh --helper-only            # only the noctalum-helper
#   ./build.sh --wsjtx-only             # only the noctalum-wsjtx bridge
#   ./build.sh --gui-only               # only the noctalum-helper-gui (linux, windows)
#   ./build.sh --no-gui                 # skip the GUI helper
#   ./build.sh --target linux/amd64     # restrict to one OS/arch
#   ./build.sh --image golang:1.23      # use a different builder image
#   ./build.sh --native                 # use the local Go toolchain instead of Docker
#                                       # (non-GUI: cross-compiles all targets;
#                                       #  GUI: native platform only, CGO libs required)
#
# The GUI helper (cmd/helper-gui) needs CGO + a platform-specific WebKit/WebView2
# toolchain.  This script builds Linux (amd64 + arm64) and Windows (amd64) in
# separate containers.  macOS GUI builds require Xcode and must be done natively
# with `wails build` on a Mac (see cmd/helper-gui/README.md).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
GO_IMAGE="${GO_IMAGE:-golang:1.22-bookworm}"
OUT_DIR="$ROOT/dist"
CACHE_DIR="$ROOT/.build-cache"

DEFAULT_SERVER_TARGETS=("linux/amd64" "linux/arm64")
DEFAULT_HELPER_TARGETS=(
  "linux/amd64" "linux/arm64"
  "darwin/amd64" "darwin/arm64"
  "windows/amd64"
)

usage() {
  sed -n '2,18p' "$0"
}

build_server=true
build_helper=true
build_wsjtx=true
build_gui=true
single_target=""
native_build=false

while [ $# -gt 0 ]; do
  case "$1" in
    --server-only) build_helper=false; build_wsjtx=false; build_gui=false; shift ;;
    --helper-only) build_server=false; build_wsjtx=false; build_gui=false; shift ;;
    --wsjtx-only)  build_server=false; build_helper=false; build_gui=false; shift ;;
    --gui-only)    build_server=false; build_helper=false; build_wsjtx=false; build_gui=true; shift ;;
    --no-gui)      build_gui=false; shift ;;
    --target)      single_target="$2"; shift 2 ;;
    --image)       GO_IMAGE="$2"; shift 2 ;;
    --native)      native_build=true; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Pick a container runtime (not needed for --native).
RUNTIME=""
if ! $native_build; then
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

# Pull the builder image once (skipped in --native mode).
if ! $native_build; then
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
FROM golang:1.22-bookworm
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
FROM golang:1.22-bookworm
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
FROM golang:1.22-bookworm
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

echo
echo "Done. Artifacts:"
ls -lh "$OUT_DIR" | awk 'NR>1 {printf "  %-40s %s\n", $9, $5}'
if $build_gui; then
  [ ${#gui_built[@]} -gt 0 ]   && echo "GUI built  : ${gui_built[*]}"
  [ ${#gui_skipped[@]} -gt 0 ] && echo "GUI skipped: ${gui_skipped[*]}  (see messages above)"
fi
