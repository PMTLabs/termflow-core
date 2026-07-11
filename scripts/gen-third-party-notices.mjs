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
import { join, dirname, isAbsolute } from 'node:path';

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

function rustDeps(manifestPath, label) {
  if (!existsSync(manifestPath)) return [];
  let meta;
  try {
    meta = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--manifest-path', manifestPath]));
  } catch (e) {
    console.warn(`[notices] cargo metadata failed for ${label}: ${e.message}`);
    return [];
  }
  const members = new Set(meta.workspace_members || []);
  const deps = [];
  for (const p of meta.packages || []) {
    // Skip our own crates (workspace members) and local path-only crates (no registry source).
    if (members.has(p.id)) continue;
    if (!p.source) continue; // path dep (ours / vendored)
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

function jsDeps() {
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
  if (o && o.trim()) return isAbsolute(o) ? o : join(ROOT, o);
  return join(ROOT, '..', 'termflow-fabric');
}

// --- collect ---------------------------------------------------------------
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

const js = jsDeps();

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

writeFileSync(join(ROOT, 'legal', 'THIRD-PARTY-NOTICES.txt'), header + '\n' + body + '\n');
console.log(`[notices] wrote legal/THIRD-PARTY-NOTICES.txt — ${all.length} components (${withText} with text)`);
