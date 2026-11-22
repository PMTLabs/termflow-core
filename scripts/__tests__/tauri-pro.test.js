const { spawnSync } = require('node:child_process');
const { readFileSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const proPath = 'src-tauri/tauri.pro.conf.json';
const macPath = 'src-tauri/tauri.pro.macos.conf.json';

// Tauri applies JSON merge patches: objects merge recursively; arrays replace.
function merge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (typeof value === 'object' && !Array.isArray(value)) out[key] = merge(out[key] || {}, value);
    else out[key] = value;
  }
  return out;
}

function wrapper(args, env = {}, native = 'aarch64-apple-darwin') {
  const code = `import { targetFor, proArgs } from './scripts/tauri-pro.mjs';
    const [args, env, native] = JSON.parse(process.argv[1]);
    const target = targetFor(args, env, () => native);
    console.log(JSON.stringify({ target, args: proArgs(args, target) }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify([args, env, native])], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

const baseArgs = ['build', '--config', proPath, '--config', 'src-tauri/tauri.icon-dev.conf.json'];

test('target option wins over environment and native; overlay precedes profile', () => {
  const result = wrapper([...baseArgs, '--target=aarch64-apple-darwin'], { TAURI_ENV_TARGET_TRIPLE: 'x86_64-pc-windows-msvc' }, 'x86_64-unknown-linux-gnu');
  expect(result.target).toBe('aarch64-apple-darwin');
  expect(result.args.slice(1, 7)).toEqual(['--config', proPath, '--config', macPath, '--config', 'src-tauri/tauri.icon-dev.conf.json']);
});

test('environment and native fallback select by target, never host OS', () => {
  expect(wrapper(baseArgs, { TAURI_ENV_TARGET_TRIPLE: 'aarch64-apple-darwin' }, 'x86_64-pc-windows-msvc').args).toContain(macPath);
  expect(wrapper(baseArgs, {}, 'aarch64-apple-darwin').args).toContain(macPath);
  expect(wrapper([...baseArgs, '-t', 'x86_64-pc-windows-msvc'], {}, 'aarch64-apple-darwin').args).toEqual([...baseArgs, '-t', 'x86_64-pc-windows-msvc']);
  expect(wrapper([...baseArgs, '--target', 'x86_64-unknown-linux-gnu'], {}, 'aarch64-apple-darwin').args).not.toContain(macPath);
  expect(wrapper([...baseArgs, '--', '--target', 'x86_64-pc-windows-msvc']).args).toContain(macPath);
});

test('accepts alternate config syntax and rejects malformed target or missing Pro config', () => {
  expect(wrapper(['build', `--config=${proPath}`]).args).toEqual(['build', `--config=${proPath}`, '--config', macPath]);
  expect(() => wrapper(['build', '--target', '--config', proPath])).toThrow('Missing --target value');
  expect(() => wrapper(['build', '--config', 'other.json'])).toThrow('Expected explicit Pro config');
});

test('effective macOS config replaces externalBin and preserves Pro resources', () => {
  const base = readJson('src-tauri/tauri.conf.json');
  const pro = readJson(proPath);
  const effective = merge(merge(base, pro), readJson(macPath));
  expect(effective.bundle.externalBin).toEqual(['binaries/termflow-mcp-server', 'binaries/termflow-fabric']);
  expect(effective.bundle.macOS.files).toEqual({ 'Helpers/TermFlow Host.app': 'binaries/macos/TermFlow Host.app' });
  expect(effective.bundle.resources).toEqual(merge(base.bundle.resources, pro.bundle.resources));
});

test.each([['windows', 'x86_64-pc-windows-msvc'], ['linux', 'x86_64-unknown-linux-gnu']])('%s effective config remains the pre-wrapper configuration', (platform, target) => {
  const base = readJson('src-tauri/tauri.conf.json');
  const platformConfig = readJson(`src-tauri/tauri.${platform}.conf.json`);
  const pro = readJson(proPath);
  const oldConfig = merge(merge(base, platformConfig), pro);
  const args = wrapper([...baseArgs, '--target', target]).args;
  const configPaths = args.filter((arg, i) => args[i - 1] === '--config');
  const actual = configPaths.reduce((config, path) => merge(config, readJson(path)), merge(base, platformConfig));
  const oldWithProfile = merge(oldConfig, readJson('src-tauri/tauri.icon-dev.conf.json'));
  expect(actual).toEqual(oldWithProfile);
  expect(actual.bundle.externalBin).toContain('binaries/termflow-pty-host');
});

(process.platform === 'darwin' ? test : test.skip)('missing and wrong-architecture helpers fail before invoking Tauri', () => {
  const dir = mkdtempSync(join(root, 'node_modules', '.tauri-pro-test-'));
  try {
    const contents = join(dir, 'src-tauri', 'binaries', 'macos', 'TermFlow Host.app', 'Contents');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    writeFileSync(join(contents, 'Info.plist'), 'fixture');
    writeFileSync(join(contents, 'Resources', 'icon.icns'), 'fixture');
    const exe = join(contents, 'MacOS', 'termflow-pty-host');
    const archs = spawnSync('lipo', [process.execPath, '-archs'], { encoding: 'utf8' }).stdout.trim().split(/\s+/);
    const absentArch = ['arm64', 'x86_64', 'arm64e'].find(arch => !archs.includes(arch));
    expect(absentArch).toBeDefined();
    const target = `${absentArch === 'arm64' ? 'aarch64' : absentArch}-apple-darwin`;
    const run = () => spawnSync(process.execPath, [join(root, 'scripts/tauri-pro.mjs'), 'build', '--target', target, '--config', proPath], { cwd: dir, encoding: 'utf8' });
    const missing = run();
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('ENOENT');
    copyFileSync(process.execPath, exe);
    chmodSync(exe, 0o755);
    const wrong = run();
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain('Helper missing required architectures');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all package Pro invocations pass through the wrapper', () => {
  const scripts = readJson('package.json').scripts;
  const invocations = Object.entries(scripts).filter(([, value]) => value.includes(proPath));
  expect(invocations.length).toBeGreaterThan(0);
  for (const [, value] of invocations) expect(value).toContain('node scripts/tauri-pro.mjs');
  expect(readFileSync(resolve(root, 'publish-macos.sh'), 'utf8')).toContain('bun run publish:tauri:pro');
});
