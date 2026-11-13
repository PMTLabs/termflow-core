// Plan 067 dependency evidence. Run from src-tauri with Bun; no installed audit tool.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const packages = new Map(metadata.packages.map(p => [p.id, p]));
const nodes = new Map(metadata.resolve.nodes.map(n => [n.id, n]));
const visited = new Set();
function visit(id) { if (visited.has(id)) return; visited.add(id); for (const dependency of nodes.get(id)?.dependencies || []) visit(dependency); }
for (const p of packages.values()) if (['russh', 'russh-sftp', 'ssh-key', 'hmac', 'sha1', 'zeroize', 'aes-gcm'].includes(p.name)) visit(p.id);
const subtree = [...visited].map(id => packages.get(id)).sort((a, b) => a.name.localeCompare(b.name));
const above = (version, major, minor) => { const [a, b] = (version || '0.0').split('.').map(Number); return a > major || (a === major && b > minor); };
let failed = false;
for (const p of subtree) {
  console.log(`${p.name}@${p.version} MSRV=${p.rust_version || 'undeclared'} license=${p.license || 'see source'}`);
  if (above(p.rust_version, 1, 89)) { failed = true; console.error(`MSRV ABOVE 1.89: ${p.name}`); }
}
if (readFileSync('Cargo.lock', 'utf8').includes('name = "aws-lc')) throw new Error('aws-lc found in product lock');
if (subtree.filter(p => p.name === 'ssh-key').length !== 1) throw new Error('more than one ssh-key implementation');
const queries = subtree.filter(p => p.source?.startsWith('registry+')).map(p => ({ package: { name: p.name, ecosystem: 'crates.io' }, version: p.version }));
const response = await fetch('https://api.osv.dev/v1/querybatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries }), signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`OSV HTTP ${response.status}`);
const result = await response.json();
for (let i = 0; i < queries.length; i++) for (const vulnerability of result.results[i]?.vulns || []) {
  failed = true;
  const detail = await fetch(`https://api.osv.dev/v1/vulns/${vulnerability.id}`, { signal: AbortSignal.timeout(30000) }).then(r => r.json());
  console.log(`OSV-AFFECTED ${queries[i].package.name}@${queries[i].version}: ${vulnerability.id}: ${detail.summary}`);
}
console.log(`SSH subtree: ${subtree.length} packages; checked ${queries.length} OSV versions. ${failed ? 'REVIEW REQUIRED' : 'No affected OSV versions; declared MSRVs <= 1.89; no aws-lc.'}`);
process.exitCode = failed ? 1 : 0;
