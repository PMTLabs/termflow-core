// Keep the macOS overlay after Pro and before profile/icon overlays. Tauri
// merges objects recursively but replaces arrays; the overlay supplies the
// complete macOS externalBin list.
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostTarget, runTauri, targetFor } from './stage-sidecars.mjs';

export { targetFor };

const pro = 'src-tauri/tauri.pro.conf.json';
const macos = 'src-tauri/tauri.pro.macos.conf.json';

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
  const target = targetFor(args, process.env, hostTarget);
  const forwarded = proArgs(args, target);
  if (target.endsWith('-apple-darwin')) validateHelper(target);
  // Stages every sidecar beside the built app afterwards (see stage-sidecars.mjs).
  process.exit(runTauri(forwarded, target));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
