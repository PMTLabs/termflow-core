// Stage every Tauri sidecar next to the built app, then verify each copy.
//
// tauri-build copies `bundle.externalBin` into the target dir it derives from
// the build script's OUT_DIR. With cargo's `build.build-dir` set (intermediate
// files elsewhere), OUT_DIR is not under the target dir, so the copy lands in
// the intermediate tree and the release dir keeps whatever sidecars it had
// before: a fresh app beside an old pty-host. So after `tauri build` this
// copies each `binaries/<name>-<triple>[.exe]` to `<release dir>/<name>[.exe]`
// and fails the build when any staged file's hash differs from its source.
//
// The list is the merged `bundle.externalBin` of the configs this build uses
// (tauri.conf.json, the target platform's tauri.<platform>.conf.json, then each
// --config in order; arrays replace), the same list Tauri itself bundles, so a
// sidecar added there is staged without touching this script.
//
// Run directly as a `tauri` stand-in: `node scripts/stage-sidecars.mjs build ...`.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function options(args) {
  const end = args.indexOf('--');
  return end < 0 ? args : args.slice(0, end);
}

/** The --config values in order (paths or inline JSON). */
export function configValues(args) {
  const opts = options(args);
  const values = [];
  opts.forEach((arg, i) => {
    if (arg === '--config' || arg === '-c') values.push(opts[i + 1]);
    else if (arg.startsWith('--config=')) values.push(arg.slice('--config='.length));
  });
  return values.filter(Boolean);
}

function platformOf(target) {
  if (target.includes('windows')) return 'windows';
  if (target.includes('apple-darwin')) return 'macos';
  if (target.includes('linux')) return 'linux';
  if (target.includes('android')) return 'android';
  if (target.includes('apple-ios')) return 'ios';
  return null;
}

function readConfig(rootDir, value) {
  const text = value.trimStart().startsWith('{')
    ? value
    : readFileSync(isAbsolute(value) ? value : resolve(rootDir, value), 'utf8');
  return JSON.parse(text);
}

/** The merged `bundle.externalBin` for `args` building `target`. */
export function externalBinFor(rootDir, args, target) {
  const sources = [join(rootDir, 'src-tauri', 'tauri.conf.json')];
  const platform = platformOf(target);
  const platformFile = platform && join(rootDir, 'src-tauri', `tauri.${platform}.conf.json`);
  if (platformFile && existsSync(platformFile)) sources.push(platformFile);
  let bins = [];
  for (const value of [...sources, ...configValues(args)]) {
    const bundle = readConfig(rootDir, value).bundle;
    if (bundle && 'externalBin' in bundle) bins = bundle.externalBin ?? [];
  }
  return bins;
}

/** Cargo's output folder for the profile: `dev` builds land in `debug`, every other profile in its own name. */
function profileDir(opts) {
  const index = opts.findIndex(arg => arg === '--profile' || arg.startsWith('--profile='));
  if (index >= 0) {
    const name = opts[index].startsWith('--profile=') ? opts[index].slice('--profile='.length) : opts[index + 1];
    if (!name || name.startsWith('-')) throw new Error('Missing --profile value');
    return name === 'dev' ? 'debug' : name;
  }
  return opts.includes('--debug') || opts.includes('-d') ? 'debug' : 'release';
}

/** `<target dir>[/<triple>]/<profile>`: cargo adds the triple only for an explicit --target. */
export function releaseDirFor(args, target, targetDirectory) {
  const opts = options(args);
  const profile = profileDir(opts);
  const explicit = opts.some(arg => arg === '--target' || arg === '-t' || arg.startsWith('--target='));
  return explicit ? join(targetDirectory, target, profile) : join(targetDirectory, profile);
}

/** Source and destination for every external binary. For `universal-apple-darwin` Tauri itself
 * requires `<name>-universal-apple-darwin` sources, so the same naming holds there. */
export function sidecarPlan(rootDir, externalBin, target, releaseDir) {
  const ext = target.includes('windows') ? '.exe' : '';
  return externalBin.map(entry => ({
    source: resolve(rootDir, 'src-tauri', `${entry}-${target}${ext}`),
    dest: join(releaseDir, `${basename(entry)}${ext}`),
  }));
}

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function stageSidecars(plan) {
  for (const { source, dest } of plan) {
    if (!existsSync(source)) throw new Error(`sidecar source missing: ${source}`);
    // An identical copy is left alone: on Windows a running sidecar cannot be overwritten, and
    // failing the build for a file that is already current would be a false failure.
    if (existsSync(dest) && sha256(source) === sha256(dest)) continue;
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(source, dest);
  }
}

/** Every staged file whose bytes differ from its source (or is missing). */
export function staleSidecars(plan) {
  return plan.filter(({ source, dest }) => !existsSync(dest) || sha256(source) !== sha256(dest));
}

/** Cargo's target directory as tauri's cargo sees it (run from src-tauri, so a relative CARGO_TARGET_DIR resolves there). */
export function cargoTargetDirectory(rootDir) {
  const meta = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: join(rootDir, 'src-tauri'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (meta.status !== 0) throw new Error(meta.stderr || 'cargo metadata failed');
  return JSON.parse(meta.stdout).target_directory;
}

/** After a successful `build`, stage and verify; returns the plan staged (empty for other commands). */
export function stageAfterBuild(rootDir, args, target, targetDirectory = cargoTargetDirectory(rootDir)) {
  if (args[0] !== 'build') return [];
  const plan = sidecarPlan(rootDir, externalBinFor(rootDir, args, target), target, releaseDirFor(args, target, targetDirectory));
  stageSidecars(plan);
  const stale = staleSidecars(plan);
  if (stale.length) {
    throw new Error(`sidecars beside the app do not match their sources:\n${stale.map(s => `  ${s.dest} != ${s.source}`).join('\n')}`);
  }
  for (const { dest } of plan) console.log(`Staged sidecar: ${dest}`);
  return plan;
}

export function hostTarget() {
  const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const target = rustc.stdout?.match(/^host:\s+(\S+)$/m)?.[1];
  if (rustc.status !== 0 || !target) throw new Error('Unable to determine Rust target triple');
  return target;
}

/** The --target value, else TAURI_ENV_TARGET_TRIPLE, else the host triple. */
export function targetFor(args, env, nativeTarget) {
  const opts = options(args);
  const index = opts.findIndex(arg => arg === '--target' || arg === '-t' || arg.startsWith('--target='));
  if (index < 0) return env.TAURI_ENV_TARGET_TRIPLE || nativeTarget();
  const target = opts[index].startsWith('--target=') ? opts[index].slice(9) : opts[index + 1];
  if (!target || target.startsWith('-')) throw new Error('Missing --target value');
  return target;
}

/** Run the Tauri CLI with this node, then stage the sidecars of a successful build. */
export function runTauri(args, target) {
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  // Run the CLI entry with this node: no .bin shim (Bun writes tauri.exe/.bunx, not tauri.cmd) and no cmd.exe.
  const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (result.status !== 0) return result.status ?? 1;
  try {
    stageAfterBuild(rootDir, args, target);
  } catch (e) {
    console.error(String(e.message ?? e));
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  process.exit(runTauri(args, targetFor(args, process.env, hostTarget)));
}
