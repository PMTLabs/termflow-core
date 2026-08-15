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
 *
 * MEASURE THE HOST, NOT THE XTERM CHILD. `FitAddon.proposeDimensions()` measures
 * `term.element.parentElement` — the host — so this predicate must measure the same
 * element or it guards the wrong thing. An earlier version took a `Terminal` and
 * measured `term.element`, which a zero-sized host can defeat: an overflowing or
 * fixed-size xterm child still reports non-zero offsets, the guard passes, and the
 * fit then runs against the zero-sized host and produces exactly the bogus grid LB
 * exists to prevent. Taking an `HTMLElement` is also the signature design/013 §5.3
 * declares.
 */
export function hasLayoutBox(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  return el.offsetWidth > 0 && el.offsetHeight > 0;
}

/** Fit only when it is safe to. Returns whether the fit actually ran. */
export function fitIfLaidOut(entry: TerminalCacheEntry): boolean {
  // The exact element FitAddon will measure. A null parentElement is the first
  // failure case above and is caught by hasLayoutBox's null branch.
  if (!hasLayoutBox(entry.terminal.element?.parentElement)) return false;
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
    //
    // It returns false when the disposal THREW, in which case it deliberately keeps
    // the addon on the entry (review 120): the context may still be held, so the
    // demotion has NOT been achieved and reporting 'dom' would both lie and free a
    // budget slot that is not free. D3 says report what was achieved.
    if (!resetTerminalRendering(terminalId)) return entry.webglAddon ? 'webgl' : 'dom';
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
 * design/013 §5.2 invariant BUDGET-OWNER. The budget is owned by Canvas Mode and
 * must be `null` whenever canvas mode is not active — INCLUDING teardowns that never
 * run the canvas exit path (webview reload, cross-window detach, renderer crash).
 * Clearing it only on the exit path is not sufficient, so the release is armed at
 * the moment the budget is armed.
 *
 * Reload and crash destroy this module's state along with the JS realm, so they are
 * self-healing; the path that is not is a teardown inside a SURVIVING realm, and
 * `pagehide` is the last point our code runs there. `beforeunload` is deliberately
 * not used — a webview does not fire it reliably.
 *
 * Registered lazily at ARM time, never at module load, so this module still has no
 * top-level execution (the import cycle with cache.ts depends on that) and an app
 * that never enters canvas mode never touches `window`. Idempotent: one listener for
 * the life of the module, not one per canvas entry.
 */
let budgetReleaseArmed = false;

function armBudgetRelease(): void {
  if (budgetReleaseArmed) return;
  if (typeof window === 'undefined') return; // non-DOM host: nothing to tear down
  budgetReleaseArmed = true;
  window.addEventListener('pagehide', () => {
    canvasWebGLBudget = null;
  });
}

/** Canvas Mode arms this on entry. Passing `null` releases it. */
export function setCanvasWebGLBudget(budget: number | null): void {
  canvasWebGLBudget = budget;
  if (budget !== null) armBudgetRelease();
}

/** Explicit release, for the normal canvas-exit path. */
export function releaseCanvasWebGLBudget(): void {
  canvasWebGLBudget = null;
}

/** Read-only accessor — BUDGET-OWNER is asserted against it, and it is the only way
 *  a diagnostic can tell "no canvas session" from "a budget of 0". */
export function getCanvasWebGLBudget(): number | null {
  return canvasWebGLBudget;
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

/**
 * design/013 §5.2 invariant ORPHAN. Called by any path that is about to REPLACE a
 * cache entry's `webglAddon` rather than carry it forward — today that is exactly
 * mount()'s create branch, which can be reached without a prior unmount() when a
 * pane moves to a new container and the cached terminal has lost its element.
 *
 * Without this, the outgoing addon keeps its GPU context, becomes unreachable from
 * terminalCache, and stops being visible to countActiveWebGLAddons() — the budget
 * under-counts, which is the one direction a budget must never fail in.
 *
 * Idempotent and total: unknown ids and addon-less entries are no-ops.
 *
 * Returns whether the caller may now allocate a replacement. `true` covers both
 * "disposed it" and "there was nothing to dispose". `false` means dispose() THREW:
 * the addon is left ON THE ENTRY rather than nulled, because it may still hold its
 * context and the entry field is the only thing countActiveWebGLAddons() can see.
 * The caller must not build a replacement on top of it (review 120).
 */
export function disposeOrphanedWebGLAddon(terminalId: string): boolean {
  const entry = terminalCache.get(terminalId);
  if (!entry?.webglAddon) return true;
  try {
    entry.webglAddon.dispose();
  } catch (e) {
    console.warn('terminal-core/renderPolicy: error disposing orphaned WebGL addon:', e);
    return false;
  }
  entry.webglAddon = null;
  entry.useWebGL = false; // advisory field kept in step (D8)
  return true;
}
