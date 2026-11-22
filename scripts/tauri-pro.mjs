// Keep the macOS overlay after Pro and before profile/icon overlays. Tauri
// merges objects recursively but replaces arrays; the overlay supplies the
// complete macOS externalBin list.
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pro = 'src-tauri/tauri.pro.conf.json';
const macos = 'src-tauri/tauri.pro.macos.conf.json';

export function targetFor(args, env, nativeTarget) {
  const options = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
  const index = options.findIndex(arg => arg === '--target' || arg === '-t' || arg.startsWith('--target='));
  if (index < 0) return env.TAURI_ENV_TARGET_TRIPLE || nativeTarget();
  const target = options[index].startsWith('--target=') ? options[index].slice(9) : options[index + 1];
  if (!target || target.startsWith('-')) throw new Error('Missing --target value');
  return target;
}

export function proArgs(args, target) {
  const result = [...args];
  const end = result.indexOf('--');
  const options = end < 0 ? result : result.slice(0, end);
  const index = options.findIndex((arg, i) =>
    ((options[i - 1] === '--config' || options[i - 1] === '-c') && arg === pro) ||
    arg === `--config=${pro}`);
  if (index < 0) throw new Error('Expected explicit Pro config');
  if (target.endsWith('-apple-darwin')) result.splice(index + 1, 0, '--config', macos);
  return result;
}

function nativeTarget() {
  const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const target = rustc.stdout?.match(/^host:\s+(\S+)$/m)?.[1];
  if (rustc.status !== 0 || !target) throw new Error('Unable to determine Rust target triple');
  return target;
}

function validateHelper(target) {
  const contents = join('src-tauri', 'binaries', 'macos', 'TermFlow Host.app', 'Contents');
  const binary = join(contents, 'MacOS', 'termflow-pty-host');
  accessSync(join(contents, 'Info.plist'), constants.R_OK);
  accessSync(join(contents, 'Resources', 'icon.icns'), constants.R_OK);
  accessSync(binary, constants.X_OK);
  const targetArch = target.split('-')[0];
  const arches = targetArch === 'universal' ? ['arm64', 'x86_64'] :
    [targetArch === 'aarch64' ? 'arm64' : targetArch];
  const check = spawnSync('lipo', [binary, '-verify_arch', ...arches], { stdio: 'inherit' });
  if (check.status !== 0) throw new Error(`Helper missing required architectures: ${arches.join(', ')}`);
}

function main() {
  const args = process.argv.slice(2);
  const target = targetFor(args, process.env, nativeTarget);
  const forwarded = proArgs(args, target);
  if (target.endsWith('-apple-darwin')) validateHelper(target);
  // Run the CLI entry with this node: no .bin shim (Bun writes tauri.exe/.bunx, not tauri.cmd) and no cmd.exe.
  const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...forwarded], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
