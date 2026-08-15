import type { Terminal } from '@xterm/xterm';
// import cycle is safe: cross-refs are call-time only (never at module load)
import { terminalCache, type TerminalCacheEntry } from './cache';

/** design/013 D1. There is no 'parked' — every terminal is permanently mounted. */
export type RenderPolicy = 'webgl' | 'dom';

/**
 * design/013 §5.3, invariant LB. Deliberately a DOM layout box and NOT
 * geometryEligible(): this layer holds no TerminalEngine handle (D10), and §5.3
 * proves that is safe — the eligibility gate sits downstream at
 * flushBackendResize (TerminalEngine.ts:2939), so no fit from any caller can
 * SIGWINCH an ineligible engine.
 *
 * Two DIFFERENT failure cases, and only checking one of them still resizes the PTY:
 *   - no `parentElement`  -> proposeDimensions() returns undefined, so fit() is a no-op
 *   - a `display:none` ancestor -> proposeDimensions() returns a BOGUS grid (spike 004
 *     Q4), so fit() happily resizes to garbage
 * The second is why a `parentElement` check alone is not enough.
 */
export function hasLayoutBox(term: Terminal): boolean {
  const el = term.element;
  if (!el || !el.parentElement) return false;
  return el.offsetWidth > 0 && el.offsetHeight > 0;
}

/** Fit only when it is safe to. Returns whether the fit actually ran. */
export function fitIfLaidOut(entry: TerminalCacheEntry): boolean {
  if (!hasLayoutBox(entry.terminal)) return false;
  try {
    entry.fitAddon.fit();
  } catch (e) {
    console.warn('terminal-core/renderPolicy: fit failed:', e);
    return false;
  }
  return true;
}

/** The policy a terminal is CURRENTLY on. `null` when the id is not cached. */
export function getTerminalRenderPolicy(terminalId: string): RenderPolicy | null {
  const entry = terminalCache.get(terminalId);
  if (!entry) return null;
  return entry.webglAddon ? 'webgl' : 'dom';
}

/**
 * design/013 D4 — addons THIS PROCESS manages, not browser GPU contexts, which we
 * cannot observe. Named for what it actually measures.
 *
 * Keys off the addon reference rather than `useWebGL`, because a context loss nulls
 * `webglAddon` (webgl.ts) and the flag is only advisory; counting the flag would hold
 * budget against a terminal that no longer has a context.
 */
export function countActiveWebGLAddons(): number {
  let n = 0;
  for (const entry of terminalCache.values()) if (entry.webglAddon) n += 1;
  return n;
}
