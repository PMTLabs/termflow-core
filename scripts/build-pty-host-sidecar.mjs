// Build the PTY-host sidecar and stage the target-suffixed externalBin.
// On macOS also assemble the helper bundle used by the Pro macOS overlay.
// build-pty-host.sh remains the standalone development build.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // cargo with an explicit --target always emits under <target_directory>/<triple>/release.
  // Ask cargo for target_directory: a user-level `build.target-dir` or CARGO_TARGET_DIR
  // moves it away from the crate's own target/.
  const meta = spawnSync(
    'cargo',
    ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', manifest],
    { encoding: 'utf8', cwd: rootDir, maxBuffer: 64 * 1024 * 1024 },
  );
  if (meta.status !== 0) {
    throw new Error(meta.stderr || 'cargo metadata failed');
  }
  const built = join(
    JSON.parse(meta.stdout).target_directory,
    targetTriple,
    'release',
    `termflow-pty-host${ext}`,
  );
  const outDir = join(rootDir, 'src-tauri', 'binaries');
  const staged = join(outDir, `termflow-pty-host-${targetTriple}${ext}`);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(built, staged);

  if (targetTriple.endsWith('-apple-darwin')) {
    const bundle = join(outDir, 'macos', 'TermFlow Host.app');
    rmSync(bundle, { recursive: true, force: true });
    const contents = join(bundle, 'Contents');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    const exe = join(contents, 'MacOS', 'termflow-pty-host');
    copyFileSync(built, exe);
    chmodSync(exe, 0o755);
    const version = JSON.parse(readFileSync(join(rootDir, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
    const template = readFileSync(join(rootDir, 'src-tauri', 'pty-host', 'macos', 'Info.plist'), 'utf8');
    writeFileSync(join(contents, 'Info.plist'), template.replaceAll('@VERSION@', version));
    copyFileSync(join(rootDir, 'src-tauri', 'icons', 'icon.icns'), join(contents, 'Resources', 'icon.icns'));
    console.log(`Assembled helper: ${bundle}`);
  }
  console.log(`Staged PTY-host sidecar: ${staged}`);
}

main();
