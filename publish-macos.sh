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
# Usage:  ./publish-macos.sh [VERSION [NOTES_FILE]]
#         MAC_PWD=... ./publish-macos.sh 1.2.0 notes-1.2.0.md
#         ./publish-macos.sh --verify-only /path/to/TermFlow.app
# Verification requires python3 >= 3.9; VERIFY_TARGET_ARCH overrides the native arch.
#
# NOTES_FILE (or RELEASE_NOTES_FILE) is markdown passed to `vpk pack
# --releaseNotes`. The updater reads release notes from the Velopack feed, not
# from the GitHub release body, so write the notes BEFORE packing.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ENTITLEMENTS="$SCRIPT_DIR/src-tauri/macos/app.entitlements"
HOST_ENTITLEMENTS="$SCRIPT_DIR/src-tauri/pty-host/macos/host.entitlements"
HOST_ID="app.termflow.desktop.pty-host"
SIGN_TEAM="68M75D67LJ"

# Keep the outer app's shipped permissions unchanged: app.entitlements is a
# verbatim copy of vpk 1.2.0 vendor/Velopack.entitlements (NuGet package), used
# by HelperFile.VelopackEntitlements / OsxPackCommandRunner when none is supplied.
# Upstream: https://github.com/velopack/velopack/blob/1.2.0/vendor/Velopack.entitlements

# Record all failures, rather than hiding later checks behind the first failure.
assert_check() {
  local label="$1"
  shift
  if "$@"; then
    echo "✅ $label"
  else
    echo "❌ $label" >&2
    VERIFY_FAILED=1
  fi
}

# Also usable without certificates. Never starts the outer app or a host daemon;
# only the copied helper's non-prompting, one-shot Task 4 status mode is executed.
verify_app() (
  local app="$1" arch="$2" tmp helper exe details requirement bundle_id
  VERIFY_FAILED=0
  tmp="$(mktemp -d)" || exit 1
  trap 'rm -rf "$tmp"' EXIT
  helper="$app/Contents/Helpers/TermFlow Host.app"
  exe="$helper/Contents/MacOS/termflow-pty-host"
  echo "=== Verify delivered app: $app ($arch) ==="
  assert_check "Helper at full bundle path" test -d "$helper"
  bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$helper/Contents/Info.plist" 2>/dev/null)" || bundle_id=""
  assert_check "Helper bundle identifier" test "$bundle_id" = "$HOST_ID"
  details="$(codesign -dv --verbose=4 "$helper" 2>&1)" || details=""
  assert_check "Helper team $SIGN_TEAM" grep -Fxq "TeamIdentifier=$SIGN_TEAM" <<< "$details"
  assert_check "Helper hardened runtime" grep -Eq 'flags=.*\(.*runtime.*\)' <<< "$details"
  # The whole designated requirement, compared exactly (scripts/macos-helper-dr.sh says why).
  requirement="$(codesign -d -r- "$helper" 2>/dev/null)" || requirement=""
  assert_check "Helper DR is exactly the update-stable Developer ID requirement" \
    "$SCRIPT_DIR/scripts/macos-helper-dr.sh" "$HOST_ID" "$SIGN_TEAM" <<< "$requirement"
  assert_check "Read helper entitlements" bash -c 'codesign -d --entitlements :- "$1" > "$2"' _ "$helper" "$tmp/entitlements.plist"
  assert_check "Helper entitlements equal host.entitlements" python3 - "$HOST_ENTITLEMENTS" "$tmp/entitlements.plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    expected = plistlib.load(f)
with open(sys.argv[2], 'rb') as f:
    actual = plistlib.load(f)
assert isinstance(actual, dict) and actual == expected, (actual, expected)
PY
  assert_check "Helper target architecture $arch" bash -o pipefail -c 'lipo -archs "$1" | tr " " "\n" | grep -Fxq "$2"' _ "$exe" "$arch"
  assert_check "Helper executable mode" test -x "$exe"
  assert_check "Helper signature strict" codesign --verify --strict "$helper"
  assert_check "Outer signature deep/strict" codesign --verify --deep --strict "$app"
  assert_check "Outer Gatekeeper acceptance" spctl -a -vv "$app"
  assert_check "Outer stapled ticket" xcrun stapler validate "$app"
  assert_check "Stage helper bundle copy" ditto "$helper" "$tmp/TermFlow Host.app"
  # Capture bytes (not command substitution): enforce exactly one JSON line and
  # exit zero independently, with a timeout so a regression cannot hang publish.
  assert_check "Staged helper --tcc status exits 0 (30s timeout)" python3 - "$tmp/TermFlow Host.app/Contents/MacOS/termflow-pty-host" "$tmp/status.json" <<'PY'
import pathlib, subprocess, sys
result = subprocess.run([sys.argv[1], '--tcc', 'status'], capture_output=True, timeout=30)
pathlib.Path(sys.argv[2]).write_bytes(result.stdout)
if result.stderr:
    sys.stderr.buffer.write(result.stderr)
assert result.returncode == 0, result.returncode
PY
  assert_check "Staged helper emits one status JSON line" python3 - "$tmp/status.json" <<'PY'
import json, pathlib, sys
raw = pathlib.Path(sys.argv[1]).read_bytes()
assert raw.endswith(b'\n') and len(raw.splitlines()) == 1, raw
status = json.loads(raw)
assert isinstance(status, dict) and set(status) == {'accessibility', 'screen_recording'}, status
assert all(v in ('Granted', 'NotGranted', 'Unsupported', 'Unknown') for v in status.values()), status
print(raw.decode(), end='')
PY
  test "$VERIFY_FAILED" -eq 0
)

# Exit before builds, tool restore, and ALL keychain/signing operations.
if [ "${1:-}" = "--verify-only" ]; then
  [ "$#" -eq 2 ] || { echo "Usage: $0 --verify-only <path-to-.app>" >&2; exit 1; }
  case "$(uname -m)" in arm64) VERIFY_ARCH=arm64 ;; x86_64) VERIFY_ARCH=x86_64 ;; *) exit 1 ;; esac
  verify_app "$2" "${VERIFY_TARGET_ARCH:-$VERIFY_ARCH}"
  exit $?
fi

VERSION="${1:-1.0.0}"
NOTES_FILE="${2:-${RELEASE_NOTES_FILE:-}}"
NOTES_ARGS=()
if [ -n "$NOTES_FILE" ]; then
  if [ ! -f "$NOTES_FILE" ]; then
    echo "Release notes file not found: $NOTES_FILE" >&2
    exit 1
  fi
  NOTES_ARGS=(--releaseNotes "$(cd "$(dirname "$NOTES_FILE")" && pwd)/$(basename "$NOTES_FILE")")
fi

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
[ -x "$APP_BUNDLE/Contents/Helpers/TermFlow Host.app/Contents/MacOS/termflow-pty-host" ] \
  || { echo "❌ TermFlow Host helper missing from the .app." >&2; exit 1; }
[ ! -e "$APP_BUNDLE/Contents/MacOS/termflow-pty-host" ] \
  || { echo "❌ Unexpected bare pty-host in the .app." >&2; exit 1; }
echo "    Built + helper present."

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

# ─── Stage 3: sign existing code inside-out (never --deep) ───────────────────
echo "=== Stage 3: sign sidecars, helper, then outer app ==="
while IFS= read -r -d '' nested; do
  [ "$nested" != "$APP_BUNDLE/Contents/MacOS/$MAIN_EXE" ] || continue
  if file -b "$nested" | grep -q 'Mach-O'; then
    codesign --force --options runtime --timestamp --sign "$SIGN_APP_IDENTITY" \
      --entitlements "$APP_ENTITLEMENTS" "$nested"
  fi
done < <(find "$APP_BUNDLE/Contents/MacOS" -type f -print0)
codesign --force --options runtime --timestamp --sign "$SIGN_APP_IDENTITY" \
  --identifier "$HOST_ID" --entitlements "$HOST_ENTITLEMENTS" \
  "$APP_BUNDLE/Contents/Helpers/TermFlow Host.app"
codesign --force --options runtime --timestamp --sign "$SIGN_APP_IDENTITY" \
  --entitlements "$APP_ENTITLEMENTS" "$APP_BUNDLE"
TARGET_ARCH="$(lipo -archs "$APP_BUNDLE/Contents/MacOS/$MAIN_EXE")"

# ─── Stage 4: vpk signs UpdateMac + outer app, notarizes, staples, builds .pkg ─
# Velopack accepts the prebuilt Tauri .app directly as --packDir (validated).
echo "=== Stage 4: vpk pack (sign + notarize, no deep re-sign) ==="
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
  "${NOTES_ARGS[@]}" \
  --signDisableDeep true \
  --signEntitlements "$APP_ENTITLEMENTS" \
  --signAppIdentity     "$SIGN_APP_IDENTITY" \
  --signInstallIdentity "$SIGN_INSTALLER_IDENTITY" \
  --notaryProfile       "$NOTARY_PROFILE"

# vpk 1.2.0 EasyZip does not preserve file modes or native symlinks. Reconstruct
# the delivered update exactly as lib-rust/src/bundle.rs does on macOS:
# extract_lib_contents_to_path sets regular files to 0755 and restores
# .__symlink markers. Plain ditto/unzip would falsely fail exec/signature checks.
extract_full_update() {
  python3 - "$1" "$2" <<'PY'
import os, pathlib, shutil, sys, zipfile
root = pathlib.Path(sys.argv[2]).resolve()
root.mkdir(parents=True)
links = []
with zipfile.ZipFile(sys.argv[1]) as archive:
    for entry in archive.infolist():
        if not entry.filename.startswith('lib/app/'):
            continue
        relative = entry.filename[len('lib/app/'):]
        if not relative:
            continue
        path = root / relative
        assert path.resolve().is_relative_to(root), entry.filename
        if relative.endswith('.__symlink'):
            links.append((pathlib.Path(str(path)[:-len('.__symlink')]),
                          archive.read(entry).decode().rstrip('/')))
        elif entry.is_dir():
            path.mkdir(parents=True, exist_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, path.open('wb') as target:
                shutil.copyfileobj(source, target)
            path.chmod(0o755)
for path, target in links:
    assert (path.parent / target).resolve().is_relative_to(root), target
    path.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(target, path)
assert (root / 'Contents/Info.plist').is_file(), 'Missing update app contents'
PY
}

# ─── Stage 5: verify BOTH delivered payloads, not the pre-vpk build ───────────
verify_delivered() (
  local tmp pkg full arch failed=0
  tmp="$(mktemp -d)" || exit 1
  trap 'rm -rf "$tmp"' EXIT
  VERIFY_FAILED=0
  pkg="$RELEASES_DIR/TermFlow-osx-Setup.pkg"
  assert_check "Expand delivered installer" pkgutil --expand-full "$pkg" "$tmp/pkg"
  # vpk 1.2.0 OsxBuildTools.CreateInstallerPkg names its component 1.pkg.
  for arch in $TARGET_ARCH; do
    verify_app "$tmp/pkg/1.pkg/Payload/TermFlow.app" "$arch" || failed=1
  done
  shopt -s nullglob
  local full_packages=("$RELEASES_DIR/"*-full.nupkg)
  assert_check "Exactly one full-update package" test "${#full_packages[@]}" -eq 1
  for full in "${full_packages[@]}"; do
    # PackageBuilder.CreateReleasePackage stores Contents under lib/app, without
    # an .app parent; reconstruct that parent and the updater's mode/symlinks.
    assert_check "Extract full-update zip (Velopack updater semantics)" extract_full_update "$full" "$tmp/update/TermFlow.app"
    for arch in $TARGET_ARCH; do
      verify_app "$tmp/update/TermFlow.app" "$arch" || failed=1
    done
  done
  test "$VERIFY_FAILED" -eq 0 && test "$failed" -eq 0
)
verify_delivered

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Done! ==="
ls -lh "$RELEASES_DIR" 2>/dev/null || true
echo ""
pkgutil --check-signature "$RELEASES_DIR/TermFlow-osx-Setup.pkg" 2>&1 | head -4 || true
