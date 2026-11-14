import { test, expect } from 'bun:test';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
const source = readFileSync(new URL('./gen-third-party-notices.mjs', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function jsFingerprint()'), source.indexOf('function jsDeps()')) + source.slice(source.indexOf('function resolveFabricDir()'), source.indexOf('// --- collect'));
test('notice cache fingerprints all JS manifests and preserves license-body dividers', () => {
  const ROOT = mkdtempSync(join(tmpdir(), 'tf-notice-'));
  try {
    mkdirSync(join(ROOT, 'legal')); mkdirSync(join(ROOT, 'packages/a'), { recursive: true });
    writeFileSync(join(ROOT, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    writeFileSync(join(ROOT, 'packages/a/package.json'), '{}'); writeFileSync(join(ROOT, 'bun.lock'), 'fixture');
    const context = vm.createContext({ ROOT, readFileSync, readdirSync, existsSync, join, dirname, resolve, isAbsolute, createHash, console, process: { env: {} }, run: () => '../main/.git' });
    vm.runInContext(functions, context);
    const hash = vm.runInContext('jsFingerprint()', context);
    const text = `A license\n${'='.repeat(80)}\nNot an entry header\nFull remaining license`;
    writeFileSync(join(ROOT, 'legal/THIRD-PARTY-NOTICES.txt'), `JavaScript inputs SHA-256: ${hash}\n\n${'='.repeat(80)}\n\na 1  —  MIT  [javascript]\n-------------------------\n${text}\n`);
    expect(vm.runInContext('cachedJsNotices()[0].text', context)).toBe(text);
    for (const file of ['package.json', 'bun.lock', 'packages/a/package.json']) {
      const original = readFileSync(join(ROOT, file)); writeFileSync(join(ROOT, file), original.toString() + ' ');
      expect(() => vm.runInContext('cachedJsNotices()', context)).toThrow('inputs changed');
      writeFileSync(join(ROOT, file), original);
    }
  } finally { rmSync(ROOT, { recursive: true, force: true }); }
});
test('worktree fabric resolution uses common git checkout and missing fabric is fatal', () => {
  const workspace = join(tmpdir(), 'tf-workspace');
  const fabric = join(workspace, 'termflow-fabric');
  const context = vm.createContext({ ROOT: join(workspace, 'core/.claude/worktrees/ssh'), join, dirname, resolve, isAbsolute, existsSync: p => p === join(fabric, 'Cargo.toml'), process: { env: {} }, run: () => join(workspace, 'core/.git') });
  vm.runInContext(functions, context);
  expect(vm.runInContext('resolveFabricDir()', context)).toBe(fabric);
  context.existsSync = () => false;
  expect(() => vm.runInContext('resolveFabricDir()', context)).toThrow('Fabric source not found');
});
