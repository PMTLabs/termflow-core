import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Latest mtime (ms) among a file, or recursively within a directory.
function latestMtimeMs(path) {
  const st = statSync(path);
  if (!st.isDirectory()) {
    return st.mtimeMs;
  }
  let latest = st.mtimeMs;
  for (const entry of readdirSync(path)) {
    latest = Math.max(latest, latestMtimeMs(join(path, entry)));
  }
  return latest;
}

// Rust target triple -> bun's `--compile --target=` cross-compile string.
// Only the triples this project actually ships need to be listed here.
const RUST_TO_BUN_TARGET = {
  'x86_64-pc-windows-msvc': 'bun-windows-x64',
  'aarch64-pc-windows-msvc': 'bun-windows-arm64',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-unknown-linux-gnu': 'bun-linux-x64',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
};

function getHostTriple() {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Failed to determine Rust host triple');
  }
  const output = result.stdout;
  const match = output.match(/^host:\s+(\S+)$/m);
  if (!match) {
    throw new Error('Failed to determine Rust host triple');
  }
  return match[1];
}

// Resolution order: explicit override, then the triple Tauri CLI sets for
// beforeBuildCommand hooks when cross-compiling (`tauri build --target ...`),
// then the host triple (plain `tauri dev` / same-arch build).
function getTargetTriple() {
  return process.env.TERMFLOW_RUST_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE || getHostTriple();
}

function main() {
  const rootDir = process.cwd();
  const targetTriple = getTargetTriple();
  const bunTarget = RUST_TO_BUN_TARGET[targetTriple];
  if (!bunTarget) {
    throw new Error(`No bun --compile target mapping for Rust triple: ${targetTriple}`);
  }
  const binaryName = 'termflow-mcp-server';
  const ext = bunTarget.startsWith('bun-windows') ? '.exe' : '';
  const outDir = join(rootDir, 'src-tauri', 'binaries');
  const outFile = join(outDir, `${binaryName}-${targetTriple}${ext}`);

  mkdirSync(outDir, { recursive: true });

  // Skip recompiling when nothing under mcp-server/src (or package.json /
  // bun.lock / this script) is newer than the existing binary. bun --compile
  // output isn't byte-deterministic (rebuilding identical sources yields a
  // different hash each time), so comparing output content can't detect
  // "unchanged" — an unconditional rebuild-and-overwrite bumps outFile's
  // mtime every single build, which Tauri's build.rs watches via
  // `cargo:rerun-if-changed`, forcing the `app` crate to recompile every
  // build even with zero source changes. Checking staleness up front (like
  // make) avoids that entirely.
  const watchPaths = [
    join(rootDir, 'mcp-server', 'src'),
    join(rootDir, 'mcp-server', 'package.json'),
    join(rootDir, 'scripts', 'build-mcp-sidecar.mjs'),
  ];
  const lockFile = join(rootDir, 'mcp-server', 'bun.lock');
  if (existsSync(lockFile)) {
    watchPaths.push(lockFile);
  }
  if (existsSync(outFile)) {
    const outMtime = statSync(outFile).mtimeMs;
    const newestSource = Math.max(...watchPaths.map(latestMtimeMs));
    if (outMtime > newestSource) {
      console.log(`MCP sidecar up to date: ${outFile}`);
      return;
    }
  }

  const bunArgs = [
    'build',
    '--compile',
    `--target=${bunTarget}`,
    `--outfile=${outFile}`,
  ];
  // Embed the TermFlow icon into the Windows executable so the MCP sidecar shows
  // a proper icon in Explorer / Task Manager instead of the generic exe glyph.
  if (bunTarget.startsWith('bun-windows')) {
    bunArgs.push(`--windows-icon=${join(rootDir, 'src-tauri', 'icons', 'icon.ico')}`);
  }
  // Workaround for a bun bug (seen on 1.3.14): bun's own download+extract of
  // its cross-compile base executable for some targets (e.g. bun-windows-arm64)
  // can fail with "Failed to extract executable ... download may be incomplete"
  // even though the release asset itself is fine. If that's been hit before,
  // set this to a manually-downloaded `bun[.exe]` from the matching
  // https://github.com/oven-sh/bun/releases/download/bun-v<version>/<target-with-aarch64>.zip
  // to bypass bun's downloader entirely.
  if (process.env.TERMFLOW_BUN_COMPILE_EXE) {
    bunArgs.push(`--compile-executable-path=${process.env.TERMFLOW_BUN_COMPILE_EXE}`);
  }
  bunArgs.push(join('mcp-server', 'src', 'index.ts'));

  const result = spawnSync('bun', bunArgs, {
    stdio: 'inherit',
    cwd: rootDir,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log(`Built MCP sidecar: ${outFile}`);
}

main();
