#!/bin/bash
set -e
# ─────────────────────────────────────────────────────────────────────────────
# publish-macos.sh — Build, smoke-test, and package TermFlow for macOS via
# Velopack (vpk), Developer-ID signed + notarized.
#
# Modeled on rephlo-desktop/publish-macos.sh, adapted for Tauri. Unlike Windows
# (Azure Trusted Signing, creds from Infisical), macOS signs with Apple
# Developer-ID certs already in the login keychain + a notarytool keychain
# profile — so there are NO Infisical/Azure secrets here.
#
# Usage:
#   ./publish-macos.sh [VERSION]
#
# Production signing env vars (all three ⇒ sign + notarize; PMT Labs team 68M75D67LJ):
#   SIGN_APP_IDENTITY        e.g. "Developer ID Application: PMT Labs LLC (68M75D67LJ)"
#   SIGN_INSTALLER_IDENTITY  e.g. "Developer ID Installer: PMT Labs LLC (68M75D67LJ)"
#   NOTARY_PROFILE           xcrun notarytool keychain profile name
#
# ⚠️ VERIFY-ON-MAC: the Tauri→Velopack packaging path differs from rephlo's
# `dotnet publish`. The two Tauri-specific spots flagged below (where the .app is
# produced, and what --packDir vpk consumes) must be confirmed on the Mac; the
# rest mirrors the proven rephlo flow.
# ─────────────────────────────────────────────────────────────────────────────

VERSION="${1:-1.0.0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASES_DIR="$SCRIPT_DIR/releases"
ICON="$SCRIPT_DIR/src-tauri/icons/icon.icns"
PACK_ID="TermFlow"
PACK_TITLE="TermFlow"
MAIN_EXE="termflow"

export DOTNET_ROLL_FORWARD="LatestMajor"

echo "=== TermFlow macOS Publish ==="
echo "    Version : $VERSION"
echo "    Output  : $RELEASES_DIR/"
echo ""

# ─── Stage 1: Tauri release build (produces TermFlow.app + sidecars) ──────────
# publish:tauri:pro runs a FULL `tauri build` (no --no-bundle) so Tauri emits the
# .app bundle under target/release/bundle/macos/. build:sidecars:pro stages the
# mac fabric + pty-host sidecars first (mcp is built by build.rs).
echo "=== Stage 1: bun run publish:tauri:pro ==="
bun run publish:tauri:pro

# ⚠️ VERIFY-ON-MAC (spot 1): confirm the produced bundle path.
APP_BUNDLE="$SCRIPT_DIR/src-tauri/target/release/bundle/macos/TermFlow.app"
if [ ! -d "$APP_BUNDLE" ]; then
  echo "❌ Expected app bundle not found: $APP_BUNDLE" >&2
  echo "   Check tauri's macOS bundle output dir/name and update APP_BUNDLE." >&2
  exit 1
fi
# The pty-host sidecar must be inside the bundle for hot-swap to work once installed.
if [ ! -f "$APP_BUNDLE/Contents/MacOS/termflow-pty-host" ]; then
  echo "❌ termflow-pty-host missing from the .app — hot-swap would break." >&2
  echo "   Ensure it is in tauri.pro.conf.json externalBin (it is on Windows)." >&2
  exit 1
fi

# ─── Stage 2: startup smoke test (gate) ──────────────────────────────────────
# Run the built binary headless and require it to answer /health before packing.
echo ""
echo "=== Stage 2: startup smoke test ==="
bun scripts/smoke-test-release.mjs "$APP_BUNDLE/Contents/MacOS/termflow"

# ─── Stage 3: vpk pack (project-local vpk 1.2.0, matches the velopack crate) ──
echo ""
echo "=== Stage 3: vpk pack ==="
dotnet tool restore >/dev/null
mkdir -p "$RELEASES_DIR"

# ⚠️ VERIFY-ON-MAC (spot 2): Velopack consumes the .app for macOS packaging.
# Confirm vpk's expected --packDir for a prebuilt .app (pack the bundle's parent
# dir vs the .app itself) against `vpk pack --help` on the Mac.
VPK_ARGS=(
  vpk pack
  --packId      "$PACK_ID"
  --packTitle   "$PACK_TITLE"
  --packVersion "$VERSION"
  --packDir     "$APP_BUNDLE"
  --mainExe     "$MAIN_EXE"
  --icon        "$ICON"
  --outputDir   "$RELEASES_DIR"
)

if [[ -n "${SIGN_APP_IDENTITY}" && -n "${SIGN_INSTALLER_IDENTITY}" && -n "${NOTARY_PROFILE}" ]]; then
  echo "    Signing mode : Production (Developer ID + notarization)"
  VPK_ARGS+=(
    --signAppIdentity     "$SIGN_APP_IDENTITY"
    --signInstallIdentity "$SIGN_INSTALLER_IDENTITY"
    --notaryProfile       "$NOTARY_PROFILE"
  )
else
  echo "    Signing mode : UNSIGNED (set SIGN_APP_IDENTITY, SIGN_INSTALLER_IDENTITY, NOTARY_PROFILE for a shippable build)"
fi

dotnet "${VPK_ARGS[@]}"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Done! ==="
echo "Release artifacts in: $RELEASES_DIR/"
ls -lh "$RELEASES_DIR/" 2>/dev/null || true
