// Build the PTY-host sidecar (Rust) and STAGE it as a Tauri externalBin, i.e.
// `src-tauri/binaries/termflow-pty-host-<rust-triple>[.exe]`. This is the
// packaging counterpart to `build-pty-host.sh` (which only builds into the
// crate's own target/ for `TERMFLOW_PTY_HOST_BIN` dev use).
//
// Wire-up (deferred — decide the dev-flow tradeoff first): add
// `"binaries/termflow-pty-host"` to `tauri.conf.json > bundle.externalBin`, add
// a `build:pty-host-sidecar` package.json script running this file, and call it
// from `beforeBuildCommand`. NOTE: Tauri resolves externalBin for `tauri dev`
// too, so either also stage it in `beforeDevCommand` or keep dev on
// TERMFLOW_PTY_HOST_BIN and only add externalBin for release bundles.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function getHostTriple() {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Failed to determine Rust host triple');
  }
  const match = result.stdout.match(/^host:\s+(\S+)$/m);
  if (!match) {
    throw new Error('Failed to determine Rust host triple');
  }
  return match[1];
}

// Same resolution order as build-mcp-sidecar.mjs: explicit override, then the
// triple Tauri sets when cross-compiling, then the host triple.
function getTargetTriple() {
  return (
    process.env.TERMFLOW_RUST_TARGET ||
    process.env.TAURI_ENV_TARGET_TRIPLE ||
    getHostTriple()
  );
}

function main() {
  const rootDir = process.cwd();
  const targetTriple = getTargetTriple();
  const isWindows = targetTriple.includes('windows');
  const ext = isWindows ? '.exe' : '';

  const manifest = join(rootDir, 'src-tauri', 'pty-host', 'Cargo.toml');
  const buildArgs = [
    'build',
    '--release',
    '--manifest-path',
    manifest,
    '--target',
    targetTriple,
  ];
  const build = spawnSync('cargo', buildArgs, { stdio: 'inherit', cwd: rootDir });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  // cargo with an explicit --target always emits under target/<triple>/release.
  const built = join(
    rootDir,
    'src-tauri',
    'pty-host',
    'target',
    targetTriple,
    'release',
    `termflow-pty-host${ext}`,
  );
  const outDir = join(rootDir, 'src-tauri', 'binaries');
  const staged = join(outDir, `termflow-pty-host-${targetTriple}${ext}`);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(built, staged);

  console.log(`Staged PTY-host sidecar: ${staged}`);
}

main();
