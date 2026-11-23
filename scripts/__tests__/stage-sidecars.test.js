const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const win = 'x86_64-pc-windows-msvc';

// The module is ESM; run each call in a child node and return its JSON result.
function call(fn, ...args) {
  const code = `import * as m from './scripts/stage-sidecars.mjs';
    const [fn, args] = JSON.parse(process.argv[1]);
    try { console.log(JSON.stringify({ ok: m[fn](...args) ?? null })); }
    catch (e) { console.log(JSON.stringify({ error: String(e.message) })); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify([fn, args])], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stage-sidecars-'));
  mkdirSync(join(dir, 'src-tauri', 'binaries'), { recursive: true });
  writeFileSync(join(dir, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ bundle: { externalBin: ['binaries/base-sidecar'] } }));
  writeFileSync(join(dir, 'src-tauri', 'tauri.pro.conf.json'), JSON.stringify({ bundle: { externalBin: ['binaries/base-sidecar', 'binaries/brand-new-sidecar'] } }));
  for (const name of ['base-sidecar', 'brand-new-sidecar']) {
    writeFileSync(join(dir, 'src-tauri', 'binaries', `${name}-${win}.exe`), `fresh ${name}`);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const proBuild = ['build', '--no-bundle', '--target', win, '--config', 'src-tauri/tauri.pro.conf.json'];

test('a sidecar added only to the config is staged beside the app and verified', () => {
  const release = join(dir, 'target', win, 'release');
  mkdirSync(release, { recursive: true });
  // The stale copies a build-dir build leaves behind.
  writeFileSync(join(release, 'base-sidecar.exe'), 'old base');

  const result = call('stageAfterBuild', dir, proBuild, win, join(dir, 'target'));
  expect(result.error).toBeUndefined();
  expect(result.ok.map(p => p.dest)).toEqual([join(release, 'base-sidecar.exe'), join(release, 'brand-new-sidecar.exe')]);
  expect(readFileSync(join(release, 'base-sidecar.exe'), 'utf8')).toBe('fresh base-sidecar');
  expect(readFileSync(join(release, 'brand-new-sidecar.exe'), 'utf8')).toBe('fresh brand-new-sidecar');
});

test('the guard names every staged file that differs from its source', () => {
  const plan = call('sidecarPlan', dir, ['binaries/base-sidecar', 'binaries/brand-new-sidecar'], win, join(dir, 'out')).ok;
  expect(call('staleSidecars', plan).ok.length).toBe(2); // nothing staged yet
  call('stageSidecars', plan);
  expect(call('staleSidecars', plan).ok).toEqual([]);
  writeFileSync(plan[1].dest, 'tampered');
  expect(call('staleSidecars', plan).ok.map(p => p.dest)).toEqual([plan[1].dest]);
});

test('an identical copy is left alone, so a running current sidecar cannot fail the build', () => {
  const plan = call('sidecarPlan', dir, ['binaries/base-sidecar'], win, join(dir, 'out')).ok;
  call('stageSidecars', plan);
  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(plan[0].dest, old, old);
  call('stageSidecars', plan);
  expect(statSync(plan[0].dest).mtime.getTime()).toBe(old.getTime());
  writeFileSync(plan[0].dest, 'stale');
  call('stageSidecars', plan);
  expect(readFileSync(plan[0].dest, 'utf8')).toBe('fresh base-sidecar');
});

test('a missing source fails the build instead of leaving the old copy', () => {
  rmSync(join(dir, 'src-tauri', 'binaries', `brand-new-sidecar-${win}.exe`));
  const result = call('stageAfterBuild', dir, proBuild, win, join(dir, 'target'));
  expect(result.error).toContain('sidecar source missing');
  expect(result.error).toContain('brand-new-sidecar');
});

test('the list follows Tauri config merging: platform file, then each --config, arrays replace', () => {
  expect(call('externalBinFor', dir, ['build'], win).ok).toEqual(['binaries/base-sidecar']);
  writeFileSync(join(dir, 'src-tauri', 'tauri.windows.conf.json'), JSON.stringify({ bundle: { externalBin: ['binaries/win-only'] } }));
  expect(call('externalBinFor', dir, ['build'], win).ok).toEqual(['binaries/win-only']);
  expect(call('externalBinFor', dir, ['build'], 'x86_64-unknown-linux-gnu').ok).toEqual(['binaries/base-sidecar']);
  expect(call('externalBinFor', dir, proBuild, win).ok).toEqual(['binaries/base-sidecar', 'binaries/brand-new-sidecar']);
  const inline = ['build', '--config=src-tauri/tauri.pro.conf.json', '-c', '{"bundle":{"externalBin":["binaries/x"]}}'];
  expect(call('externalBinFor', dir, inline, win).ok).toEqual(['binaries/x']);
  // A config without externalBin keeps the list; options after `--` are cargo's, not Tauri's.
  writeFileSync(join(dir, 'src-tauri', 'icon.json'), JSON.stringify({ bundle: { icon: [] } }));
  expect(call('externalBinFor', dir, [...proBuild, '--config', 'src-tauri/icon.json', '--', '--config', 'nope.json'], win).ok)
    .toEqual(['binaries/base-sidecar', 'binaries/brand-new-sidecar']);
});

test('release dir: the triple only with an explicit --target, debug only with --debug', () => {
  const t = join(dir, 'target');
  expect(call('releaseDirFor', ['build'], win, t).ok).toBe(join(t, 'release'));
  expect(call('releaseDirFor', ['build', '--target', win], win, t).ok).toBe(join(t, win, 'release'));
  expect(call('releaseDirFor', [`--target=${win}`, '--debug'], win, t).ok).toBe(join(t, win, 'debug'));
  expect(call('releaseDirFor', ['build', '--profile', 'dev'], win, t).ok).toBe(join(t, 'debug'));
  expect(call('releaseDirFor', ['build', '--profile=ci-fast', '--target', win], win, t).ok).toBe(join(t, win, 'ci-fast'));
  expect(call('releaseDirFor', ['build', '--profile'], win, t).error).toContain('Missing --profile value');
  const plan = call('sidecarPlan', dir, ['binaries/a'], 'x86_64-unknown-linux-gnu', t).ok;
  expect(plan).toEqual([{ source: join(dir, 'src-tauri', 'binaries', 'a-x86_64-unknown-linux-gnu'), dest: join(t, 'a') }]);
});

test('only a build stages: dev runs before cargo has produced anything to verify', () => {
  expect(call('stageAfterBuild', dir, ['dev', '--target', win], win, join(dir, 'target')).ok).toEqual([]);
  expect(existsSync(join(dir, 'target'))).toBe(false);
});

test('every build and publish script goes through the stager', () => {
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
  // A step runs the Tauri CLI when one of its words is the CLI itself (tauri, tauri.js, a path to
  // it); `bun run build:tauri` is a script name, not the CLI. Such a step must build only through
  // one of the two wrappers.
  const runsTauri = word => /(^|[\\/])tauri(\.js|\.cmd|\.exe)?$/.test(word);
  let builds = 0;
  for (const [name, command] of Object.entries(scripts)) {
    for (const step of command.split(/&&|\|\||;/).map(s => s.trim().split(/\s+/))) {
      const wrapped = step.some(w => /scripts\/(stage-sidecars|tauri-pro)\.mjs$/.test(w));
      if (wrapped && step.includes('build')) builds += 1;
      if (step.some(runsTauri) && step.includes('build')) {
        throw new Error(`${name} runs tauri build without the sidecar stager: ${step.join(' ')}`);
      }
    }
  }
  expect(builds).toBeGreaterThanOrEqual(10);
  // tauri-pro's main must hand the build to runTauri, not spawn the CLI itself.
  const pro = readFileSync(join(root, 'scripts', 'tauri-pro.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
  const main = pro.slice(pro.indexOf('function main()'), pro.indexOf('if (process.argv[1]'));
  expect(main).toMatch(/process\.exit\(runTauri\(forwarded, target\)\);/);
  expect(main).not.toMatch(/spawnSync|tauri\.js/);
});
