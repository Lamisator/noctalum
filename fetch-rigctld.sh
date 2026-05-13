#!/usr/bin/env bash
# Download / build rigctld binaries for embedding into noctalum-helper.
# Run once before build.sh; build.sh detects the populated dirs and enables
# the -tags with_rigctld build flag automatically.
#
# Requires: docker (or podman), curl, unzip
# Produces: cmd/helper/rigctld-bins/{linux-amd64,linux-arm64,windows-amd64}/
#
# macOS binaries are NOT fetched here (no official pre-built releases);
# the macOS helper falls back to rigctld found via PATH or Homebrew.
#
# Usage:
#   ./fetch-rigctld.sh                   # fetch all supported platforms
#   ./fetch-rigctld.sh --linux-only      # skip Windows fetch
#   ./fetch-rigctld.sh --windows-only    # skip Linux Docker builds
#   HAMLIB_VERSION=4.5.5 ./fetch-rigctld.sh

set -euo pipefail

HAMLIB_VERSION="${HAMLIB_VERSION:-4.5.5}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
BINS_DIR="$ROOT/cmd/helper/rigctld-bins"

do_linux=true
do_windows=true

while [ $# -gt 0 ]; do
  case "$1" in
    --linux-only)   do_windows=false; shift ;;
    --windows-only) do_linux=false;   shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── helpers ──────────────────────────────────────────────────────────────────

RUNTIME=""
for c in docker podman; do
  if command -v "$c" >/dev/null 2>&1; then RUNTIME="$c"; break; fi
done
if [ -z "$RUNTIME" ]; then
  echo "error: neither docker nor podman found" >&2
  exit 1
fi

# ── Linux amd64 ──────────────────────────────────────────────────────────────

fetch_linux() {
  local arch="$1"      # amd64 or arm64
  local platform="$2"  # linux/amd64 or linux/arm64
  local out="$BINS_DIR/linux-${arch}"

  if [ -f "$out/rigctld" ] && [ -f "$out/rigctl" ]; then
    echo "==> linux/${arch}: already present, skipping"
    return 0
  fi

  echo "==> linux/${arch}: fetching rigctld+rigctl via Docker (ubuntu:22.04)"
  mkdir -p "$out"
  if ! "$RUNTIME" run --rm \
    --platform "$platform" \
    --user root \
    -v "$out":/out \
    ubuntu:22.04 \
    bash -c 'apt-get update -q && apt-get install -y -q --no-install-recommends hamlib-utils \
             && cp /usr/bin/rigctld /out/rigctld \
             && cp /usr/bin/rigctl  /out/rigctl \
             && chmod 755 /out/rigctld /out/rigctl'; then
    echo "warning: linux/${arch} build failed (QEMU / --platform support may be needed for arm64)" >&2
    rm -rf "$out"
    return 1
  fi
  echo "    wrote $out/rigctld ($(du -sh "$out/rigctld" | cut -f1)), rigctl ($(du -sh "$out/rigctl" | cut -f1))"
}

# ── Windows amd64 ────────────────────────────────────────────────────────────

fetch_windows_amd64() {
  local out="$BINS_DIR/windows-amd64"

  if [ -f "$out/rigctld.exe" ] && [ -f "$out/rigctl.exe" ]; then
    echo "==> windows/amd64: already present, skipping"
    return 0
  fi

  echo "==> windows/amd64: downloading Hamlib ${HAMLIB_VERSION} Windows release"
  mkdir -p "$out"

  local zip_url="https://github.com/Hamlib/Hamlib/releases/download/${HAMLIB_VERSION}/hamlib-w64-${HAMLIB_VERSION}.zip"
  local tmpzip
  tmpzip="$(mktemp --suffix=.zip)"
  trap 'rm -f "$tmpzip"' EXIT

  if ! curl -fsSL -o "$tmpzip" "$zip_url"; then
    echo "error: download failed: $zip_url" >&2
    rm -rf "$out"
    return 1
  fi

  echo "    extracting bin/rigctld.exe, bin/rigctl.exe and DLLs"
  # Extract only the bin/ directory contents (exe + DLLs) from the zip.
  # Hamlib w64 zip structure: hamlib-w64-X.Y.Z/bin/rigctld.exe
  #                                               bin/rigctl.exe
  #                                               bin/*.dll
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir" "$tmpzip"' EXIT

  unzip -q "$tmpzip" "*/bin/rigctld.exe" "*/bin/rigctl.exe" "*/bin/*.dll" -d "$tmpdir"

  # Locate the extracted bin/ directory (zip prefix varies by version).
  local bindir
  bindir="$(find "$tmpdir" -name "rigctld.exe" -exec dirname {} \;)"
  if [ -z "$bindir" ]; then
    echo "error: rigctld.exe not found in zip" >&2
    rm -rf "$out" "$tmpdir"
    return 1
  fi

  cp "$bindir"/rigctld.exe "$out/"
  cp "$bindir"/rigctl.exe  "$out/"
  # Copy all DLLs alongside the exes so Windows can find them at runtime.
  find "$bindir" -maxdepth 1 -name "*.dll" -exec cp {} "$out/" \;

  rm -rf "$tmpdir"
  echo "    wrote $(ls "$out" | wc -l | tr -d ' ') files to $out"
}

# ── main ─────────────────────────────────────────────────────────────────────

mkdir -p "$BINS_DIR"

ok=0
fail=0

if $do_linux; then
  fetch_linux amd64 linux/amd64 && ok=$((ok+1)) || fail=$((fail+1))
  fetch_linux arm64 linux/arm64 && ok=$((ok+1)) || fail=$((fail+1))
fi

if $do_windows; then
  fetch_windows_amd64 && ok=$((ok+1)) || fail=$((fail+1))
fi

# Mirror all successfully fetched bins into cmd/helper-gui/rigctld-bins/ so the
# GUI binary can embed them too.  Both packages need local copies because
# go:embed does not follow symlinks and cannot reference paths outside the
# package directory.
GUI_BINS_DIR="$ROOT/cmd/helper-gui/rigctld-bins"
mkdir -p "$GUI_BINS_DIR"
for platform_dir in "$BINS_DIR"/*/; do
  [ -d "$platform_dir" ] || continue
  platform="$(basename "$platform_dir")"
  gui_target="$GUI_BINS_DIR/$platform"
  mkdir -p "$gui_target"
  cp -f "$platform_dir"/* "$gui_target/" 2>/dev/null || true
done
echo "Mirrored rigctld-bins to cmd/helper-gui/rigctld-bins/"

echo
echo "rigctld fetch complete: ${ok} succeeded, ${fail} skipped/failed"
if [ $fail -gt 0 ]; then
  echo "(failed platforms will be built without embedded rigctld)"
fi
echo
echo "NOTE: macOS binaries are not bundled — users need 'brew install hamlib'"
