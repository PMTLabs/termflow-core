# MCP hold real-process tests

The `state::mcp_hold_e2e` library tests run on Linux and Windows. They start only
owned, detached PTY hosts on random private endpoints, and the source MCP sidecar
under Bun. They never start the app, use `connect_or_spawn`, or connect to a saved
profile. macOS Layer A is not enabled.

From the repository root, install dependencies with `bun install` and
`cd mcp-server && bun install`. Use the repository's shared, non-Pro Cargo target:

```sh
export CARGO_INCREMENTAL=0
export CARGO_TARGET_DIR="$PWD/src-tauri/target"
cargo build --manifest-path src-tauri/pty-host/Cargo.toml
export TERMFLOW_PTY_HOST_BIN="$CARGO_TARGET_DIR/debug/termflow-pty-host"
export TERMFLOW_E2E_REQUIRED=1
cargo test --manifest-path src-tauri/Cargo.toml --lib mcp_hold_e2e -- --nocapture
```

On Windows, set `TERMFLOW_PTY_HOST_BIN` to the `.exe`. **Cargo creates a
non-breakaway kill-on-close Job Object** around its tests. Consequently, a real
host correctly refuses `ArmDetach` when started by an ordinary `cargo test`.
Build with Cargo, then run its exact library test artifact outside Cargo's job
(the Windows CI step does this):

```powershell
$env:CARGO_INCREMENTAL = '0'
$env:CARGO_TARGET_DIR = "$PWD/src-tauri/target"
cargo build --manifest-path src-tauri/pty-host/Cargo.toml
$env:TERMFLOW_PTY_HOST_BIN = "$env:CARGO_TARGET_DIR/debug/termflow-pty-host.exe"
$env:TERMFLOW_E2E_REQUIRED = '1'
$artifacts = cargo test --manifest-path src-tauri/Cargo.toml --lib --no-run --message-format=json
if ($LASTEXITCODE -ne 0) { throw 'test build failed' }
$tests = @($artifacts | ForEach-Object {
  $item = $_ | ConvertFrom-Json
  if ($item.reason -eq 'compiler-artifact' -and $item.profile.test -and $item.executable) {
    $item.executable
  }
})
if ($tests.Count -ne 1) { throw 'expected one library test executable' }
& $tests[0] mcp_hold_e2e --nocapture
if ($LASTEXITCODE -ne 0) { throw 'real-process tests failed' }
```

Use an independent shell, not another non-breakaway job. An arm refusal is a test
failure, never an after-setup skip. Running without the filter executes the entire
library suite; add `--features velopack-updates` to the build for that gate.

Missing prerequisites skip only when `TERMFLOW_E2E_REQUIRED` is not `1`. An explicit
missing host override never falls back. Unsafe executable or artifact paths fail
regardless of that flag. Installed `%LOCALAPPDATA%/TermFlow`, all
`target-pro-windows*` paths, and paths outside approved test roots are refused
with canonical parents, including resolved symlinks/junctions.

The ignored `new_app_old_host_uses_normal_search` additionally requires
`TERMFLOW_E2E_OLD_HOST_BIN`. Its test comment describes building the pre-PR128
fixture in a disposable worktree, using the same shared target, copying the old
executable within that target, and rebuilding the current host before the test.
Run it explicitly with `--ignored --nocapture` and `TERMFLOW_E2E_REQUIRED=1`.

`MEASURE` output reports both bind modes' holder takeover and release-call to
listening. Port-stop assertions use an exclusive same-address rebind: on Windows,
TCP's delayed connection refusal can itself exceed the one-second stop bound.
SSE EOF is separately bounded; a connect timeout is never accepted as a late-claim
oracle.
