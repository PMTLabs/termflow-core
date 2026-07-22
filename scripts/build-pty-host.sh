#!/usr/bin/env bash
# Build the PTY-host sidecar (milestone A, Windows dev).
# Produces src-tauri/pty-host/target/release/termflow-pty-host(.exe).
# Point the app at it with TERMFLOW_PTY_HOST_BIN and enable TERMFLOW_PTY_HOST=1.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cargo build --manifest-path "$here/src-tauri/pty-host/Cargo.toml" --release
bin="$here/src-tauri/pty-host/target/release/termflow-pty-host"
[ -f "$bin.exe" ] && bin="$bin.exe"
echo "built: $bin"
echo 'enable with:  export TERMFLOW_PTY_HOST=1; export TERMFLOW_PTY_HOST_BIN="'"$bin"'"'
