#!/usr/bin/env bun
/**
 * Startup smoke test — the class-agnostic gate that catches ANY startup-fatal
 * regression: a Rust panic, a native heap corruption / access violation (like
 * the shortcut-AUMID double-free), a missing sidecar DLL, or a bad config. The
 * failure that motivated this could not be caught by any in-process try/catch
 * (an OS fail-fast kills the process), but it IS trivially caught here: a build
 * that crashes on launch never answers /health.
 *
 * What it does: launch the built binary headless on ephemeral ports, poll its
 * /health endpoint until it answers, then kill the whole process tree. Exit 0
 * only if the app came up; non-zero (with the exit code + stderr) otherwise.
 *
 * Usage:
 *   bun scripts/smoke-test-release.mjs [path-to-binary]
 *   SMOKE_BIN=... SMOKE_TIMEOUT_MS=30000 bun scripts/smoke-test-release.mjs
 *
 * Default binary: the release main binary for the current OS. Pass a path (or
 * SMOKE_BIN) to smoke a debug build, e.g. src-tauri/target/debug/termflow-app.exe.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultBinary() {
  const rel = path.join(REPO_ROOT, 'src-tauri', 'target', 'release');
  // `mainBinaryName` is "termflow"; on Windows the built exe is termflow.exe.
  return process.platform === 'win32'
    ? path.join(rel, 'termflow.exe')
    : path.join(rel, 'termflow');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function killTree(pid) {
  if (pid == null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    // Child is a group leader (detached), so kill the whole group incl. sidecars.
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

async function checkHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body && body.status === 'ok';
  } catch {
    return false;
  }
}

function hex(code) {
  if (code == null) return 'null';
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

async function main() {
  const bin = path.resolve(process.argv[2] || process.env.SMOKE_BIN || defaultBinary());
  if (!fs.existsSync(bin)) {
    console.error(`[smoke] FAIL: binary not found: ${bin}`);
    console.error('[smoke] build it first (e.g. `bun run build:tauri:pro`) or pass a path.');
    process.exit(1);
  }

  const [apiPort, mcpPort] = await Promise.all([freePort(), freePort()]);
  console.log(`[smoke] launching: ${bin}`);
  console.log(`[smoke] headless, api-port=${apiPort} mcp-port=${mcpPort}, timeout=${TIMEOUT_MS}ms`);

  const child = spawn(
    bin,
    ['--headless', '--api-port', String(apiPort), '--mcp-port', String(mcpPort)],
    {
      cwd: path.dirname(bin),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        // The smoke check never creates terminals, and an INSTALLED TermFlow may
        // be running on this machine: without the kill-switch this headless app
        // would find the production pty-host pipe busy and spawn a COMPETING
        // host on the same pipe name (plus leak its ConPTY conhost, which once
        // blocked the installer with an Access-denied rename). Keep the sidecar
        // fully out of the smoke.
        TERMFLOW_PTY_HOST: '0',
      },
    }
  );

  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', (d) => { stdout += d.toString(); });

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (err) => { exited = { code: null, signal: null, err: String(err) }; });

  const deadline = Date.now() + TIMEOUT_MS;
  let healthy = false;
  while (Date.now() < deadline) {
    if (exited) break; // process died before it ever became healthy
    if (await checkHealth(apiPort)) { healthy = true; break; }
    await sleep(300);
  }

  killTree(child.pid);

  if (healthy) {
    console.log('[smoke] PASS: app launched and answered /health.');
    process.exit(0);
  }

  console.error('[smoke] FAIL: app did not become healthy.');
  if (exited) {
    console.error(
      `[smoke] process exited early: code=${exited.code} (${hex(exited.code)})` +
      `${exited.signal ? ` signal=${exited.signal}` : ''}${exited.err ? ` err=${exited.err}` : ''}`
    );
    if (exited.code != null && (exited.code >>> 0) === 0xc0000374) {
      console.error('[smoke] 0xC0000374 = STATUS_HEAP_CORRUPTION (native memory bug).');
    }
  } else {
    console.error(`[smoke] process still running after ${TIMEOUT_MS}ms but never answered /health.`);
  }
  if (stdout.trim()) console.error(`[smoke] --- stdout (tail) ---\n${stdout.slice(-1500)}`);
  if (stderr.trim()) console.error(`[smoke] --- stderr (tail) ---\n${stderr.slice(-1500)}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`[smoke] FAIL: unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
