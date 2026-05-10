#!/usr/bin/env bash
# Cross-compile ContestLog binaries inside a Docker (or Podman) container.
# No local Go toolchain is required.
#
# Defaults build the server for Linux, and the helper for Linux, macOS, and
# Windows (so each operator can grab the right binary for their PC).
#
# Usage:
#   ./build.sh                          # build all defaults (no GUI)
#   ./build.sh --server-only            # only the contestlog server
#   ./build.sh --helper-only            # only the contestlog-helper
#   ./build.sh --wsjtx-only             # only the contestlog-wsjtx bridge
#   ./build.sh --gui-only               # only the contestlog-helper-gui (linux/amd64)
#   ./build.sh --with-gui               # defaults plus the GUI helper
#   ./build.sh --target linux/amd64     # restrict to one OS/arch
#   ./build.sh --image golang:1.23      # use a different builder image
#
# The GUI helper (cmd/helper-gui) needs CGO + webkit2gtk-4.1; it is built in
# a separate container only for linux/amd64. For Windows / macOS GUI builds,
# run `wails build` natively on the target host (see cmd/helper-gui/README.md).

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
build_gui=false
single_target=""

while [ $# -gt 0 ]; do
  case "$1" in
    --server-only) build_helper=false; build_wsjtx=false; build_gui=false; shift ;;
    --helper-only) build_server=false; build_wsjtx=false; build_gui=false; shift ;;
    --wsjtx-only)  build_server=false; build_helper=false; build_gui=false; shift ;;
    --gui-only)    build_server=false; build_helper=false; build_wsjtx=false; build_gui=true; shift ;;
    --with-gui)    build_gui=true; shift ;;
    --target)      single_target="$2"; shift 2 ;;
    --image)       GO_IMAGE="$2"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Pick a container runtime: prefer docker, fall back to podman.
RUNTIME=""
for c in docker podman; do
  if command -v "$c" >/dev/null 2>&1; then RUNTIME="$c"; break; fi
done
if [ -z "$RUNTIME" ]; then
  echo "error: neither docker nor podman is installed" >&2
  exit 1
fi

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

# Pull the image once, quietly, so the per-build runs don't each emit the pull log.
"$RUNTIME" image inspect "$GO_IMAGE" >/dev/null 2>&1 || "$RUNTIME" pull "$GO_IMAGE"

run_build() {
  local pkg="$1" basename="$2" target="$3"
  local os="${target%/*}" arch="${target#*/}"
  local out="${basename}-${os}-${arch}"
  [ "$os" = "windows" ] && out="${out}.exe"

  echo "==> $out  (GOOS=$os GOARCH=$arch)"
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
    go build -trimpath -ldflags="$LDFLAGS" \
      -o "/src/dist/$out" "$pkg"
}

echo "Builder image : $GO_IMAGE"
echo "Runtime       : $RUNTIME"
echo "Version       : $VERSION"
echo "Output dir    : $OUT_DIR"
echo

if $build_server; then
  for t in "${server_targets[@]}"; do
    run_build "./" "contestlog" "$t"
  done
fi
if $build_helper; then
  for t in "${helper_targets[@]}"; do
    run_build "./cmd/helper" "contestlog-helper" "$t"
  done
fi
if $build_wsjtx; then
  for t in "${helper_targets[@]}"; do
    run_build "./cmd/wsjtx" "contestlog-wsjtx" "$t"
  done
fi

# The GUI helper is built separately because it needs CGO + a webkit toolchain.
# We only build linux/amd64 here; macOS and Windows GUI builds need native
# `wails build` runs on those platforms (see cmd/helper-gui/README).
build_gui_linux_amd64() {
  local out="contestlog-helper-gui-linux-amd64"
  echo "==> $out  (CGO=1, webkit2gtk-4.1)"
  local gui_image="contestlog-helper-gui-builder:latest"
  if ! "$RUNTIME" image inspect "$gui_image" >/dev/null 2>&1; then
    echo "    building $gui_image (one-time, ~2-3 min)"
    "$RUNTIME" build -t "$gui_image" - <<'DOCKERFILE'
FROM golang:1.22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config build-essential \
    libgtk-3-dev libwebkit2gtk-4.1-dev \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
  fi
  "$RUNTIME" run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$ROOT":/src -w /src/cmd/helper-gui \
    -v "$CACHE_DIR/go-build":/.cache/go-build \
    -v "$CACHE_DIR/go-mod":/go/pkg/mod \
    -e HOME=/tmp \
    -e GOCACHE=/.cache/go-build \
    -e GOMODCACHE=/go/pkg/mod \
    -e CGO_ENABLED=1 \
    "$gui_image" \
    go build -trimpath -tags webkit2_41 -ldflags="$LDFLAGS" \
      -o "/src/dist/$out" .
}

if $build_gui; then
  build_gui_linux_amd64
fi

echo
echo "Done. Artifacts:"
ls -lh "$OUT_DIR" | awk 'NR>1 {printf "  %-40s %s\n", $9, $5}'
