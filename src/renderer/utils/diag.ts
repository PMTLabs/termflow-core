import { invoke } from '@tauri-apps/api/core';

/**
 * Terminal diagnostics logging.
 *
 * These hooks are left in the code permanently but are DISABLED by default, so
 * they add ~zero overhead in normal use. Enable them only when troubleshooting a
 * terminal rendering/resize/cursor issue; output is mirrored to BOTH the webview
 * console and the Rust logger (so it shows up in the `bun run dev:tauri`
 * terminal without needing DevTools).
 *
 * Toggle it via the terminal right-click menu ("Enable Diagnostics Logging") or
 * from a console with `window.setTermDiag(true)`. The choice persists across
 * reloads (localStorage). See docs/024-terminal-diagnostics-logging.md.
 */

const STORAGE_KEY = 'termDiagEnabled';

let enabled = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
})();

export function isTermDiagEnabled(): boolean {
  return enabled;
}

export function setTermDiag(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  const line = `[TERM-DIAG] diagnostics ${on ? 'ENABLED' : 'disabled'}`;
  console.log(line);
  try {
    void invoke('diag_log', { msg: line }).catch(() => {});
  } catch {
    /* not in a Tauri context */
  }
}

/**
 * Emit a diagnostic line (no-op unless diagnostics are enabled). Pass a thunk for
 * messages that are expensive to build (e.g. JSON.stringify of output) so that
 * cost is only paid when diagnostics are on.
 */
export function termDiag(msg: string | (() => string)): void {
  if (!enabled) return;
  const line = typeof msg === 'function' ? msg() : msg;
  console.log(line);
  try {
    void invoke('diag_log', { msg: line }).catch(() => {});
  } catch {
    /* not in a Tauri context */
  }
}

// Expose a console/automation toggle for power users.
if (typeof window !== 'undefined') {
  (window as any).setTermDiag = setTermDiag;
}
