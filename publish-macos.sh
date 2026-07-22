#!/bin/bash
set -e
# ─────────────────────────────────────────────────────────────────────────────
# publish-macos.sh — Build, Developer-ID sign, and notarize TermFlow for macOS
# via Velopack. Validated end-to-end on the PMT Labs Mac (2026-07-21):
# TermFlow-osx-Setup.pkg came out signed + notarized + stapled + spctl-accepted.
#
# Unlike Windows (Azure Trusted Signing, creds from Infisical), macOS signs with
# Apple Developer-ID certs in the login keychain + a notarytool keychain profile.
#
# Prereqs (all present on the PMT Labs Mac):
#   - Developer ID Application + Developer ID Installer identities in the login
#     keychain (team 68M75D67LJ).
#   - notarytool profile "termflow-notary" (App Store Connect .p8). Create once:
#       xcrun notarytool store-credentials termflow-notary \
#         --key ~/key/AuthKey_33Y825QZ7R.p8 --key-id 33Y825QZ7R \
#         --issuer d0e5f0c0-fac5-4f41-98ce-aeb6abe4b609
#   - The login keychain UNLOCKED (codesign needs it non-interactively). Either
#     run this from a GUI console session, or export MAC_PWD (the login-keychain
#     password) before running — e.g. the orchestrator pipes it in from Infisical
#     (env dev, /machine). MAC_PWD is used only to unlock; never echoed.
#
# Usage:  ./publish-macos.sh [VERSION]
#         MAC_PWD=... ./publish-macos.sh 1.2.0
# ─────────────────────────────────────────────────────────────────────────────

VERSION="${1:-1.0.0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Tools are not on a non-interactive shell's PATH (bun in ~/.bun, dotnet in
# /usr/local/share/dotnet, cargo in ~/.cargo, brew node in /opt/homebrew) — add
# them explicitly so this works over SSH as well as from a terminal.
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/share/dotnet:$PATH"
export DOTNET_ROLL_FORWARD="LatestMajor"

APP_BUNDLE="$SCRIPT_DIR/src-tauri/target/release/bundle/macos/TermFlow.app"
RELEASES_DIR="$SCRIPT_DIR/releases"
ICON="$SCRIPT_DIR/src-tauri/icons/icon.icns"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
PACK_ID="TermFlow"
PACK_TITLE="TermFlow"
MAIN_EXE="termflow"
SIGN_APP_IDENTITY="${SIGN_APP_IDENTITY:-Developer ID Application: PMT Labs LLC (68M75D67LJ)}"
SIGN_INSTALLER_IDENTITY="${SIGN_INSTALLER_IDENTITY:-Developer ID Installer: PMT Labs LLC (68M75D67LJ)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-termflow-notary}"

echo "=== TermFlow macOS Publish ==="
echo "    Version : $VERSION"
echo ""

# ─── Stage 1: Tauri release build → TermFlow.app (+ sidecars) ─────────────────
# Full `tauri build` (via publish:tauri:pro) so Tauri emits the .app bundle;
# build:sidecars:pro stages the mac fabric + pty-host sidecars first.
echo "=== Stage 1: bun run publish:tauri:pro ==="
bun run publish:tauri:pro
[ -d "$APP_BUNDLE" ] || { echo "❌ app bundle not found: $APP_BUNDLE" >&2; exit 1; }
# The pty-host sidecar MUST be inside the bundle or the installed app can't hot-swap.
[ -f "$APP_BUNDLE/Contents/MacOS/termflow-pty-host" ] \
  || { echo "❌ termflow-pty-host missing from the .app — hot-swap would break." >&2; exit 1; }
echo "    Built + pty-host present."

# NOTE: no startup smoke test here — it launches a GUI (WebView) window that needs
# an Aqua session, which an SSH build host does not have. Smoke the x64/arm64
# Windows builds (publish-windows.ps1) or run the .app manually from a console.

# ─── Stage 2: unlock the login keychain (needed for non-interactive codesign) ─
if [ -n "$MAC_PWD" ]; then
  echo "=== Stage 2: unlock login keychain ==="
  security unlock-keychain -p "$MAC_PWD" "$KEYCHAIN"
  # Grant codesign/productsign non-interactive access to the Developer ID key,
  # and stop the keychain auto-relocking mid-build.
  security set-key-partition-list -S apple-tool:,apple: -s -k "$MAC_PWD" "$KEYCHAIN" >/dev/null 2>&1 || true
  security set-keychain-settings "$KEYCHAIN"
else
  echo "=== Stage 2: MAC_PWD not set — assuming the login keychain is already unlocked ==="
fi

# ─── Stage 3: vpk pack — sign (.app, --deep) + notarize + staple, build .pkg ──
# Velopack accepts the prebuilt Tauri .app directly as --packDir (validated).
echo "=== Stage 3: vpk pack (sign + notarize) ==="
dotnet tool restore >/dev/null
rm -rf "$RELEASES_DIR"
dotnet vpk pack \
  --packId      "$PACK_ID" \
  --packTitle   "$PACK_TITLE" \
  --packVersion "$VERSION" \
  --packDir     "$APP_BUNDLE" \
  --mainExe     "$MAIN_EXE" \
  --icon        "$ICON" \
  --outputDir   "$RELEASES_DIR" \
  --signAppIdentity     "$SIGN_APP_IDENTITY" \
  --signInstallIdentity "$SIGN_INSTALLER_IDENTITY" \
  --notaryProfile       "$NOTARY_PROFILE"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Done! ==="
ls -lh "$RELEASES_DIR" 2>/dev/null || true
echo ""
pkgutil --check-signature "$RELEASES_DIR/TermFlow-osx-Setup.pkg" 2>&1 | head -4 || true
