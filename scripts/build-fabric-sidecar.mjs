import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Build the private `termflow-fabric` peering sidecar and stage it as a Tauri
 * externalBin (`src-tauri/binaries/termflow-fabric-<triple>[.exe]`).
 *
 * OPEN-CORE BOUNDARY: the fabric is a SEPARATE, privately-licensed (BSL) Cargo
 * crate that lives OUTSIDE this repo. This script is only used by the `:pro`
 * build/dev flows. If the fabric source is not present (any OSS/CI checkout),
 * it prints a clear notice and exits 0 so a plain build is never broken.
 *
 * Source dir resolution:
 *   1. $TERMFLOW_FABRIC_DIR (absolute or relative to the repo root), else
 *   2. the documented default sibling `../termflow-fabric`
 *      (i.e. D:/sources/work/termflow/termflow-fabric for a repo at
 *      D:/sources/work/termflow/termflow-core).
 */

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

// Resolution order: explicit override, then the triple Tauri CLI sets for
// beforeBuildCommand hooks when cross-compiling. This script itself runs
// *before* `tauri build` (chained via `&&` in package.json), outside any
// Tauri hook, so TAURI_ENV_TARGET_TRIPLE is only present if the caller
// already exported it manually.
function getTargetTriple(hostTriple) {
  return process.env.TERMFLOW_RUST_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple;
}

function resolveFabricDir(rootDir) {
  const override = process.env.TERMFLOW_FABRIC_DIR;
  if (override && override.trim() !== '') {
    // Allow either an absolute path or one relative to the repo root.
    // `join` would corrupt an absolute override (concatenating it under rootDir),
    // so pass absolute paths through unchanged.
    return isAbsolute(override) ? override : join(rootDir, override);
  }
  return join(rootDir, '..', 'termflow-fabric');
}

function main() {
  const rootDir = process.cwd();
  const fabricDir = resolveFabricDir(rootDir);

  if (!existsSync(fabricDir)) {
    console.log(
      `[build:fabric-sidecar] fabric source not found at ${fabricDir}; ` +
        `skipping (OSS build without peering). ` +
        `Set TERMFLOW_FABRIC_DIR to point at the private termflow-fabric crate to enable it.`,
    );
    process.exit(0);
  }

  const hostTriple = getHostTriple();
  const targetTriple = getTargetTriple(hostTriple);
  const isCrossCompile = targetTriple !== hostTriple;

  console.log(
    `[build:fabric-sidecar] building fabric from ${fabricDir}` +
      (isCrossCompile ? ` (cross-compiling for ${targetTriple})` : ''),
  );

  const cargoArgs = ['build', '--release'];
  if (isCrossCompile) {
    cargoArgs.push('--target', targetTriple);
  }
  const build = spawnSync('cargo', cargoArgs, {
    stdio: 'inherit',
    cwd: fabricDir,
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const ext = targetTriple.includes('-windows-') ? '.exe' : '';
  const releaseDir = isCrossCompile
    ? join(fabricDir, 'target', targetTriple, 'release')
    : join(fabricDir, 'target', 'release');
  const builtBinary = join(releaseDir, `termflow-fabric${ext}`);
  if (!existsSync(builtBinary)) {
    console.error(
      `[build:fabric-sidecar] expected build output missing: ${builtBinary}`,
    );
    process.exit(1);
  }

  const outDir = join(rootDir, 'src-tauri', 'binaries');
  const outFile = join(outDir, `termflow-fabric-${targetTriple}${ext}`);
  mkdirSync(outDir, { recursive: true });

  // Only copy if the content actually changed. copyFileSync always stamps a
  // fresh mtime on outFile, and Tauri's build.rs watches this exact path via
  // `cargo:rerun-if-changed` — an unconditional copy (even of byte-identical
  // output from a cargo-cached no-op build) was forcing the `app` crate to
  // recompile on every single build.
  if (existsSync(outFile) && sha256(outFile) === sha256(builtBinary)) {
    console.log(`[build:fabric-sidecar] unchanged: ${outFile}`);
  } else {
    copyFileSync(builtBinary, outFile);
    console.log(`[build:fabric-sidecar] staged fabric sidecar: ${outFile}`);
  }

  // Ship the fabric's actual FSL license text in the Pro bundle (FSL Redistribution
  // clause: include a copy of the Terms). `legal/LICENSE-fabric-fsl.txt` is bundled as a
  // resource by tauri.pro.conf.json; overwrite the committed placeholder with the real one.
  // The fabric LICENSE is the canonical FSL *Markdown*; the About & Legal panel renders
  // plain <pre> text, so strip the heading markers when staging (`##` sections uppercased
  // to keep the hierarchy readable, matching the other legal .txt docs).
  const fabricLicense = join(fabricDir, 'LICENSE');
  if (existsSync(fabricLicense)) {
    const legalDir = join(rootDir, 'legal');
    mkdirSync(legalDir, { recursive: true });
    const licenseOutFile = join(legalDir, 'LICENSE-fabric-fsl.txt');
    const plainText = readFileSync(fabricLicense, 'utf8').replace(
      /^(#{1,3}) (.+)$/gm,
      (_m, hashes, title) => (hashes.length === 2 ? title.toUpperCase() : title),
    );
    // Same mtime-churn concern as the binary above: this is also a bundled resource
    // watched by tauri-build's `cargo:rerun-if-changed`. Compare with line endings
    // normalized so a CRLF checkout of the committed file doesn't force a rewrite.
    const normalize = (s) => s.replace(/\r\n/g, '\n');
    if (existsSync(licenseOutFile) && normalize(readFileSync(licenseOutFile, 'utf8')) === normalize(plainText)) {
      console.log('[build:fabric-sidecar] LICENSE unchanged');
    } else {
      writeFileSync(licenseOutFile, plainText);
      console.log('[build:fabric-sidecar] staged plain-text fabric LICENSE -> legal/LICENSE-fabric-fsl.txt');
    }
  } else {
    console.warn(`[build:fabric-sidecar] fabric LICENSE not found at ${fabricLicense}; keeping placeholder`);
  }
}

main();
