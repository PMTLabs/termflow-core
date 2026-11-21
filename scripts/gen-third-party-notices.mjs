// Generate legal/THIRD-PARTY-NOTICES.txt from the ACTUAL dependency trees — do not
// hand-maintain. Reproduces each bundled component's license text (attribution), which is
// what MIT/BSD/Apache/etc. require when redistributing the compiled app.
//
//   Rust:  `cargo metadata` for src-tauri (core) and, if present, the peering fabric.
//          License text is read from each crate's own source directory (LICENSE*/COPYING*).
//   JS:    `bunx license-checker --production --json` over the renderer dependency tree;
//          license text from each package's detected licenseFile.
//
// Usage: node scripts/gen-third-party-notices.mjs
//   Env: TERMFLOW_FABRIC_DIR to point at the private fabric crate (else the documented
//        sibling default). Fabric deps are included when the crate is present (Pro).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const LICENSE_FILE_RE = /^(LICENSE|LICENCE|COPYING|NOTICE|UNLICENSE)(\.|$|-)/i;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function readLicenseTexts(dir) {
  if (!dir || !existsSync(dir)) return null;
  let out = '';
  for (const f of readdirSync(dir)) {
    if (!LICENSE_FILE_RE.test(f)) continue;
    const p = join(dir, f);
    try {
      if (statSync(p).isFile()) out += (out ? '\n' : '') + readFileSync(p, 'utf8').trim();
    } catch { /* skip unreadable */ }
  }
  return out || null;
}

// A THIRD-PARTY crate vendored into this repo (src-tauri/vendor/<crate>, e.g. the patched
// portable-pty) is a path dependency with no registry source, but it is not ours: its
// license/attribution must still be reproduced, exactly as when it came from crates.io.
const isVendoredCrate = (p) => /[\\/]vendor[\\/]/.test(p.manifest_path);

function rustDeps(manifestPath, label) {
  if (!existsSync(manifestPath)) return [];
  let meta;
  try {
    meta = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--manifest-path', manifestPath]));
  } catch (e) {
    throw new Error(`[notices] cargo metadata failed for ${label}: ${e.message}`);
  }
  const members = new Set(meta.workspace_members || []);
  const deps = [];
  for (const p of meta.packages || []) {
    // Skip our own crates (workspace members) and local path-only crates (no registry source).
    if (members.has(p.id)) continue;
    if (!p.source && !isVendoredCrate(p)) continue; // path dep (ours)
    deps.push({
      name: p.name,
      version: p.version,
      license: p.license || p.license_file || 'see source',
      dir: dirname(p.manifest_path),
      kind: `rust (${label})`,
    });
  }
  return deps;
}

// Rust-only dependency updates can retain the already generated JS attributions
// when bun.lock/package.json are unchanged. This avoids fetching a notice tool.
// Explicit opt-in only; ordinary release regeneration still scans the JS tree.
function jsFingerprint() {
  const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const files = ['package.json', 'bun.lock'];
  for (const workspace of rootPackage.workspaces || []) {
    if (workspace.endsWith('/*')) {
      const dir = workspace.slice(0, -2);
      for (const name of readdirSync(join(ROOT, dir))) {
        const manifest = `${dir}/${name}/package.json`;
        if (existsSync(join(ROOT, manifest))) files.push(manifest);
      }
    } else files.push(`${workspace}/package.json`);
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file + '\0').update(readFileSync(join(ROOT, file))).update('\0');
  return hash.digest('hex');
}
function cachedJsNotices() {
  const previous = readFileSync(join(ROOT, 'legal', 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  if (previous.match(/^JavaScript inputs SHA-256: ([a-f0-9]{64})$/m)?.[1] !== jsFingerprint()) {
    throw new Error('JavaScript notice inputs changed or fingerprint missing; run a full regeneration');
  }
  const entries = [];
  for (const block of previous.split(/\r?\n={80}\r?\n(?=\r?\n?[^\r\n]+ [^ ]+  —  [^\r\n]+  \[(?:javascript|rust \([^\r\n]+\))\]\r?\n-+\r?\n)/)) {
    const match = block.trim().match(/^(.+) ([^ ]+)  —  (.+)  \[javascript\]\r?\n-+\r?\n([\s\S]*)$/);
    if (!match) continue;
    const [, name, version, license, text] = match;
    entries.push({ name, version, license, text: text.startsWith('(No bundled license') ? null : text.trim(), kind: 'javascript' });
  }
  if (!entries.length) throw new Error('No cached JavaScript notices; run a full regeneration');
  console.log(`[notices] reusing ${entries.length} unchanged JavaScript attributions`);
  return entries;
}
function jsDeps() {
  if (process.argv.includes('--reuse-js-notices')) return cachedJsNotices();
  let json;
  try {
    json = run('bunx', ['license-checker', '--production', '--json', '--excludePrivatePackages', '--start', ROOT]);
  } catch (e) {
    // license-checker exits non-zero if it finds "unknown" licenses; still prints JSON to stdout.
    json = e.stdout && e.stdout.toString ? e.stdout.toString() : (typeof e.stdout === 'string' ? e.stdout : '');
    if (!json) {
      console.warn(`[notices] license-checker failed: ${e.message}`);
      return [];
    }
  }
  let obj;
  try { obj = JSON.parse(json); } catch { console.warn('[notices] could not parse license-checker JSON'); return []; }
  const deps = [];
  for (const [key, v] of Object.entries(obj)) {
    const at = key.lastIndexOf('@');
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (name === 'auto-terminal' || name === '') continue; // our own package
    let text = null;
    if (v.licenseFile && existsSync(v.licenseFile)) {
      try { text = readFileSync(v.licenseFile, 'utf8').trim(); } catch { /* skip */ }
    }
    deps.push({ name, version, license: v.licenses || 'UNKNOWN', text, kind: 'javascript' });
  }
  return deps;
}

function resolveFabricDir() {
  const o = process.env.TERMFLOW_FABRIC_DIR;
  const direct = o?.trim() ? (isAbsolute(o) ? o : join(ROOT, o)) : join(ROOT, '..', 'termflow-fabric');
  if (existsSync(join(direct, 'Cargo.toml'))) return direct;
  if (o?.trim()) throw new Error(`Fabric source not found: ${direct}`);
  try {
    const common = run('git', ['rev-parse', '--git-common-dir']).trim();
    const linked = join(dirname(resolve(ROOT, common)), '..', 'termflow-fabric');
    if (existsSync(join(linked, 'Cargo.toml'))) return linked;
  } catch { /* Archives and standalone core checkouts need neither git nor fabric. */ }
  if (process.argv.includes('--require-fabric')) throw new Error('Fabric source not found (--require-fabric)');
  return direct;
}

// --- collect ---------------------------------------------------------------
const js = jsDeps();
const rust = [
  ...rustDeps(join(ROOT, 'src-tauri', 'Cargo.toml'), 'core'),
];
const fabricDir = resolveFabricDir();
if (existsSync(join(fabricDir, 'Cargo.toml'))) {
  rust.push(...rustDeps(join(fabricDir, 'Cargo.toml'), 'peering fabric (Pro)'));
  console.log(`[notices] included fabric Rust deps from ${fabricDir}`);
} else {
  console.log(`[notices] fabric not found at ${fabricDir}; Rust notices cover the core only`);
}
for (const d of rust) d.text = readLicenseTexts(d.dir);

// dedup by name@version, prefer an entry that has license text
const byKey = new Map();
for (const d of [...rust, ...js]) {
  const key = `${d.name}@${d.version}`;
  const cur = byKey.get(key);
  if (!cur || (!cur.text && d.text)) byKey.set(key, d);
}
const all = [...byKey.values()].sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version));

// --- emit ------------------------------------------------------------------
const withText = all.filter((d) => d.text).length;
const header = `TermFlow — Third-Party Open-Source Notices

TermFlow includes the open-source components listed below, each under its own license.
This file reproduces the available license/attribution texts to satisfy those licenses.
Generated by scripts/gen-third-party-notices.mjs from the actual dependency trees; do not
hand-edit — regenerate with: node scripts/gen-third-party-notices.mjs

Components: ${all.length} (${withText} with reproduced license text)
Rust: ${rust.length}  ·  JavaScript: ${js.length}
JavaScript inputs SHA-256: ${jsFingerprint()}
A human-readable summary is also published at https://termflow.app/licenses.

================================================================================
`;

const body = all
  .map((d) => {
    const head = `${d.name} ${d.version}  —  ${d.license}  [${d.kind}]`;
    const text = d.text ? `\n${d.text}\n` : `\n(No bundled license file found in the package; component licensed under: ${d.license}.)\n`;
    return `${head}\n${'-'.repeat(head.length)}${text}`;
  })
  .join('\n================================================================================\n\n');

writeFileSync(join(ROOT, 'legal', 'THIRD-PARTY-NOTICES.txt'), (header + '\n' + body + '\n').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, ''));
console.log(`[notices] wrote legal/THIRD-PARTY-NOTICES.txt — ${all.length} components (${withText} with text)`);
