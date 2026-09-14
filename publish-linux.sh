#!/bin/bash
set -e
# ─────────────────────────────────────────────────────────────────────────────
# publish-linux.sh — Build and package TermFlow for Linux via Velopack (vpk).
#
# Linux needs no code signing (unlike Windows' Azure Trusted Signing or macOS'
# Developer ID + notarization) — `vpk pack` run on a Linux host just produces
# an AppImage. Designed to run from WSL (Ubuntu) against the same repo checkout
# used for the Windows builds, or on any Linux host with the Tauri prereqs.
#
# Prereqs (Tauri 2 Debian/Ubuntu prerequisites — see rust-tests.yml CI job):
#   sudo apt update && sudo apt install -y \
#     libwebkit2gtk-4.1-dev build-essential curl wget file \
#     libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
#
# Usage:  ./publish-linux.sh [VERSION]
# ─────────────────────────────────────────────────────────────────────────────

VERSION="${1:-1.0.0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Tools may not be on a non-interactive shell's PATH.
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.dotnet:$PATH"
export DOTNET_ROLL_FORWARD="LatestMajor"

RELEASE_DIR="$SCRIPT_DIR/src-tauri/target/release"
STAGE_DIR="$SCRIPT_DIR/publish/linux-x64"
RELEASES_DIR="$SCRIPT_DIR/releases"
ICON="$SCRIPT_DIR/src-tauri/icons/128x128.png"
PACK_ID="TermFlow"
PACK_TITLE="TermFlow"
MAIN_EXE="termflow"

# Same payload set as Windows (publish-windows.ps1): the app binary + the three
# sidecars. termflow-pty-host in particular is required for hot-swap on update.
PAYLOAD_FILES=(termflow termflow-mcp-server termflow-fabric termflow-pty-host)
PAYLOAD_DIRS=(legal resources)

echo "=== TermFlow Linux Publish ==="
echo "    Version : $VERSION"
echo ""

# ─── Stage 1: Tauri release build (+ all sidecars) ────────────────────────────
echo "=== Stage 1: bun run publish:tauri:pro ==="
bun run publish:tauri:pro
[ -f "$RELEASE_DIR/termflow" ] || { echo "❌ termflow binary not found: $RELEASE_DIR/termflow" >&2; exit 1; }

# NOTE: no startup smoke test here — like the macOS build host, this runs
# headless (WSL / SSH), and launching the WebView needs a display. Smoke the
# Windows build (publish-windows.ps1) or run the AppImage manually.

# ─── Stage 2: assemble a clean payload dir ───────────────────────────────────
echo ""
echo "=== Stage 2: stage payload -> $STAGE_DIR ==="
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
for f in "${PAYLOAD_FILES[@]}"; do
  src="$RELEASE_DIR/$f"
  [ -f "$src" ] || { echo "❌ Required payload file missing: $src" >&2; exit 1; }
  cp "$src" "$STAGE_DIR/$f"
done
for d in "${PAYLOAD_DIRS[@]}"; do
  src="$RELEASE_DIR/$d"
  [ -d "$src" ] && cp -r "$src" "$STAGE_DIR/$d"
done
echo "    Staged ${#PAYLOAD_FILES[@]} binaries + resource dirs"

# ─── Stage 3: vpk pack — builds the .AppImage (unsigned, no notarization) ────
echo ""
echo "=== Stage 3: vpk pack (AppImage) ==="
dotnet tool restore >/dev/null
mkdir -p "$RELEASES_DIR"
dotnet vpk pack \
  --packId      "$PACK_ID" \
  --packTitle   "$PACK_TITLE" \
  --packVersion "$VERSION" \
  --packDir     "$STAGE_DIR" \
  --mainExe     "$MAIN_EXE" \
  --icon        "$ICON" \
  --outputDir   "$RELEASES_DIR"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Done! ==="
ls -lh "$RELEASES_DIR" 2>/dev/null || true
