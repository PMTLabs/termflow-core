#!/usr/bin/env bash
# Build the PTY-host sidecar (milestone A, Windows dev).
# Produces src-tauri/pty-host/target/release/termflow-pty-host(.exe).
# Point the app at it with TERMFLOW_PTY_HOST_BIN and enable TERMFLOW_PTY_HOST=1.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cargo build --manifest-path "$here/src-tauri/pty-host/Cargo.toml" --release
manifest="$here/src-tauri/pty-host/Cargo.toml"
# target_directory honours CARGO_TARGET_DIR / a user-level build.target-dir.
target_dir="$(cargo metadata --format-version 1 --no-deps --manifest-path "$manifest" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).target_directory')"
bin="$target_dir/release/termflow-pty-host"
[ -f "$bin.exe" ] && bin="$bin.exe"
echo "built: $bin"
echo 'enable with:  export TERMFLOW_PTY_HOST=1; export TERMFLOW_PTY_HOST_BIN="'"$bin"'"'
