import type { Terminal } from '@xterm/xterm';
// import cycle is safe: cross-refs are call-time only (never at module load)
import { terminalCache, resetTerminalRendering, type TerminalCacheEntry } from './cache';
import { loadWebGLAddon } from './webgl';

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

/**
 * design/013 §4. Returns the policy ACTUALLY ACHIEVED, which may differ from `want`
 * (D3): promotion can fail on the GPU context limit, a driver refusal, or the global
 * WebGL toggle. A caller that assumes success silently overruns its budget.
 *
 * Both directions are idempotent — setting the policy a terminal already has is a
 * no-op that returns it, with no addon rebuild and no fit.
 */
export function setTerminalRenderPolicy(terminalId: string, want: RenderPolicy): RenderPolicy {
  const entry = terminalCache.get(terminalId);
  if (!entry) return 'dom';

  const current: RenderPolicy = entry.webglAddon ? 'webgl' : 'dom';
  if (current === want) return current;

  if (want === 'dom') {
    // Reuse before reinvent: the existing demotion primitive already disposes the
    // addon and nulls both fields. Task 4 makes its fit conditional (LB).
    resetTerminalRendering(terminalId);
    return 'dom';
  }

  // Promotion. loadWebGLAddon installs the SAME onContextLoss handler the create
  // path uses (webgl.ts) — required, or a context loss on a promoted terminal
  // leaves a dead addon on the entry (spec test 8). It returns null rather than
  // throwing when the global toggle is off or construction fails. Constructing a
  // FRESH addon every time is invariant FA (§4.2): a fresh addon is what guarantees
  // a fresh glyph atlas, so demote -> re-promote cannot resurrect the shipped
  // stale-atlas defect.
  const addon = loadWebGLAddon(entry.terminal, terminalId);
  if (!addon) {
    entry.webglAddon = null;
    entry.useWebGL = false;
    return 'dom';                     // D7: not an error, the budget was reached
  }
  entry.webglAddon = addon;
  entry.useWebGL = true;
  // Renderer swap can change cell metrics; re-measure, but only when it is safe to.
  fitIfLaidOut(entry);
  return 'webgl';
}

/**
 * The GPU budget Canvas Mode is currently enforcing, or `null` when no canvas
 * session is active. Module-level because mount()'s create branch — which runs
 * before any reconciler can see the new terminal — has no other way to ask.
 */
let canvasWebGLBudget: number | null = null;

/**
 * Canvas Mode arms this on entry and clears it (`null`) on exit.
 *
 * Clearing on the exit path alone does NOT satisfy BUDGET-OWNER (§5.2 note (c)),
 * because canvas exit is not guaranteed to run — webview reload, renderer crash and
 * cross-window detach all skip it. Task 9 adds the release mechanism that closes
 * that; this setter is only the arming half.
 */
export function setCanvasWebGLBudget(budget: number | null): void {
  canvasWebGLBudget = budget;
}

/**
 * design/013 §5.1 "Creation-time policy". Consulted by mount()'s create branch
 * BEFORE loadWebGLAddon, so a terminal created mid-canvas-session never transiently
 * exceeds the budget and the reconciler never has to chase a context it did not
 * approve.
 *
 * `true` whenever no budget is armed, which is every ordinary launch — arming is
 * what changes behaviour, so nothing outside a canvas session is affected.
 */
export function webglAllowedAtCreation(): boolean {
  if (canvasWebGLBudget === null) return true;
  return countActiveWebGLAddons() < canvasWebGLBudget;
}
