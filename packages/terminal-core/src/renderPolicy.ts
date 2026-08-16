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
 *
 * REACHABLE + QUARANTINED (review 124 HIGH). An addon whose dispose() threw may still
 * hold its context, and the cache entry it was retained on can be REPLACED out from
 * under it (mount()'s create branch does exactly that). Counting only the cache would
 * then under-state by one more context per failure, without bound. The quarantine
 * below is where those addons live, and it is part of the count for as long as they
 * refuse to be disposed.
 */
export function countActiveWebGLAddons(): number {
  let n = 0;
  for (const entry of terminalCache.values()) if (entry.webglAddon) n += 1;
  return n + webglQuarantine.size;
}

/* ------------------------------------------------------------------ quarantine */

/** Minimal shape the quarantine needs; the real addon and the jsdom mock both fit. */
type DisposableAddon = { dispose(): void };

/**
 * design/013 §5.2 ORPHAN, review 124 HIGH — addons whose `dispose()` THREW.
 *
 * Retaining such an addon on its cache entry is only safe while that entry survives.
 * The create path in mount() replaces the whole entry, so the retained addon becomes
 * unreachable and stops being counted — and every repetition adds another one, which
 * is why the under-count is UNBOUNDED rather than off-by-one. Neither the cache cap
 * nor the budget bounds objects that are no longer in the cache.
 *
 * This registry is the second half of the count: an addon that could not be disposed
 * moves here instead of vanishing, so ORPHAN's quiescent equality holds as
 *
 *     live === reachable + quarantined === countActiveWebGLAddons()
 *
 * Keyed by addon, so re-quarantining the same addon cannot double-count it.
 *
 * A SET, not a retry queue (rev 10, pre-review `138`). Quarantine is TERMINAL: an
 * addon lands here and is charged to the budget until something proves its context
 * is gone, and retrying `dispose()` is not, and cannot be, such a proof.
 *
 * WHY — xterm 6.0.0's `AddonManager.loadAddon` replaces the addon instance's own
 * `.dispose` with a wrapper, and `_wrappedAddonDispose` latches `isDisposed = true`
 * BEFORE invoking the real one:
 *
 *     loadAddon(term, addon) { const rec = {instance: addon, dispose: addon.dispose,
 *       isDisposed: false}; ...; addon.dispose = () => this._wrappedAddonDispose(rec) }
 *     _wrappedAddonDispose(rec) { if (rec.isDisposed) return;
 *       ...; rec.isDisposed = true; rec.dispose.apply(rec.instance); ... }
 *
 * Every addon this module quarantines was loaded that way (`webgl.ts` calls
 * `term.loadAddon`), so once the real dispose has thrown once, the latch is set and
 * EVERY later `dispose()` returns immediately — silently, doing no work and throwing
 * nothing. A retry that "succeeds" proves only that the latch is set.
 *
 * Wrapping `dispose` ourselves before `loadAddon` does NOT fix this: xterm captures
 * our wrapper as `rec.dispose` and reassigns `addon.dispose` to its own, so ours ends
 * up INSIDE the latch and is never reached on a retry either. Reaching the real
 * dispose again would mean bypassing the AddonManager entirely — and there is no
 * reason to think re-running a teardown that threw partway through freeing GL
 * resources succeeds the second time.
 *
 * Rev 7's bounded round-robin retry (review `132` LOW) is RETRACTED: it could never
 * have fired in production, because `failures` could not exceed 0 for a latched
 * addon, and its release path converted a safe over-count into the unsafe under-count
 * this registry exists to prevent.
 *
 * QUARANTINE IS PERMANENT FOR THE RENDERER'S LIFETIME (rev 15, codex round 7 MEDIUM).
 * Rev 10 said an addon leaves "on that addon reporting context loss". That signal is
 * unreachable for anything actually in here. In `@xterm/addon-webgl@0.19.0`,
 * `onContextLoss` is an `Emitter` created via `this._register(...)`, so it belongs to
 * the addon's own `DisposableStore`; and xterm's `DisposableStore.clear()` is
 * `try { dispose(children) } finally { this._toDispose.clear() }` — the store empties
 * EVEN WHEN A CHILD THROWS. Every path into this registry arrives *because* a
 * `dispose()` threw, so by then the emitter is already gone and our handler can never
 * fire again.
 *
 * `releaseFromWebGLQuarantine` is therefore NOT a recovery path. It is retained for
 * the opposite ordering — a healthy addon losing its context *before* anything tried
 * to dispose it, where the handler does fire and the addon was never quarantined; the
 * call is a no-op there. Do not describe it as automatic recovery, and do not add one:
 * this fails SAFE (a wedged context holds a budget slot rather than being handed out
 * twice), which is the only direction a hard budget may fail in.
 */
const webglQuarantine = new Set<DisposableAddon>();

/**
 * Not an eviction threshold — evicting would silently reintroduce exactly the
 * under-count this registry exists to prevent, and would not free anything, because
 * the context is held by the addon, not by our reference to it. Crossing it means
 * "this session has accumulated this many GPU contexts it cannot free"; that is a
 * driver-level leak that will end in a lost context, and the log is the only warning
 * anyone gets. The registry deliberately keeps growing past it.
 */
const QUARANTINE_LOG_THRESHOLD = 8;

/** Take ownership of an addon we failed to dispose. Idempotent. */
export function quarantineWebGLAddon(addon: DisposableAddon | null | undefined): void {
  if (!addon) return;
  if (webglQuarantine.has(addon)) return;
  webglQuarantine.add(addon);
  if (webglQuarantine.size >= QUARANTINE_LOG_THRESHOLD) {
    console.error(
      `terminal-core/renderPolicy: ${webglQuarantine.size} WebGL addons have refused ` +
        'disposal and are held in quarantine; their GPU contexts are still counted ' +
        'against the budget and cannot be reclaimed.',
    );
  } else {
    console.warn(
      'terminal-core/renderPolicy: quarantining a WebGL addon whose dispose() threw ' +
        `(${webglQuarantine.size} held).`,
    );
  }
}

/** How many un-disposable addons the count is currently carrying. */
export function getQuarantinedWebGLAddonCount(): number {
  return webglQuarantine.size;
}

/**
 * Remove ONE addon from the quarantine set.
 *
 * READ THIS BEFORE TREATING IT AS A RELEASE MECHANISM: for an addon that is actually
 * IN the quarantine, this is UNREACHABLE, and quarantine is therefore permanent for the
 * renderer's lifetime (rev 15; the earlier text here promised the opposite and was the
 * LOW of codex round 7 and a MEDIUM of round 8).
 *
 * The only caller is the context-loss handler installed in `webgl.ts`. An addon enters
 * the quarantine exclusively BECAUSE its `dispose()` threw — and `WebglAddon`'s
 * `onContextLoss` is an `Emitter` created with `this._register(...)`, so it belongs to
 * the addon's own `DisposableStore`, whose `clear()` is
 * `try { dispose(children) } finally { this._toDispose.clear() }`. The store empties even
 * when a child throws. So by the time an addon is quarantined its emitter is already
 * gone, and no context loss it might suffer can ever call this.
 *
 * What the call IS for is the opposite ordering: context loss arriving while the addon is
 * still healthy and un-quarantined. There it is a harmless no-op on the set (the addon is
 * not a member) and the handler's real work is clearing the cache field.
 *
 * The consequence is deliberate and it fails SAFE — a wedged context holds a budget slot
 * for the session rather than being handed out twice. Do not "fix" it by accepting a
 * non-throwing `dispose()` as proof of release: that is false for every addon xterm has
 * wrapped (see the registry's own comment above), and it is what the deleted
 * `drainWebGLQuarantine` got wrong.
 */
export function releaseFromWebGLQuarantine(addon: DisposableAddon | null | undefined): void {
  if (!addon) return;
  webglQuarantine.delete(addon);
}

/** Test hygiene only: the quarantine outlives terminalCache.clear() by design. */
export function clearWebGLQuarantine(): void {
  webglQuarantine.clear();
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
    // It returns false when the disposal THREW. Since rev 10 that no longer means
    // "still on WebGL": the failure path hands the addon to the QUARANTINE and
    // clears the entry's fields, so the terminal really is off WebGL and 'dom' is
    // the honest achieved policy (D3). The budget is not falsely freed either —
    // countActiveWebGLAddons() counts the quarantine.
    //
    // Rev 9 and earlier said the opposite here ("deliberately keeps the addon on
    // the entry (review 120) … reporting 'dom' would both lie and free a budget
    // slot that is not free"), and left an `entry.webglAddon ? 'webgl' : 'dom'`
    // ternary to express it. That ternary was already dead — `entry` is the same
    // object `resetTerminalRendering` just cleared — and the stale rationale is
    // part of what let rev 10's regression through. Reduced to the value it always
    // returned (rev 11, pre-review `140`).
    //
    // canvasOwned: this IS the canvas policy layer, so the demotion must not
    // invalidate canvas's own snapshot (review 124 / D6).
    resetTerminalRendering(terminalId, { canvasOwned: true });
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
 * "disposed it" and "there was nothing to dispose". `false` means dispose() THREW.
 *
 * Review 124 HIGH corrects what happens then. Leaving the addon ON THE ENTRY was not
 * enough: this function's only caller replaces that entry immediately afterwards, so
 * the retained addon became unreachable and uncounted anyway, once per failure and
 * without bound. It is now moved to the QUARANTINE, which countActiveWebGLAddons()
 * includes — the count stays exact across the entry replacement, and the entry fields
 * can be cleared honestly because the quarantine, not the entry, now owns it.
 *
 * The caller is still told not to build a replacement on top of it (review 120): the
 * context may still be held, and declining to add a second one is the conservative
 * direction for a hard budget.
 */
export function disposeOrphanedWebGLAddon(terminalId: string): boolean {
  // No opportunistic drain here any more (rev 10): quarantine is terminal, because a
  // retried dispose() on an xterm-wrapped addon returns silently whether or not the
  // context was ever freed. See the quarantine registry's comment.
  const entry = terminalCache.get(terminalId);
  if (!entry?.webglAddon) return true;
  try {
    entry.webglAddon.dispose();
  } catch (e) {
    console.warn('terminal-core/renderPolicy: error disposing orphaned WebGL addon:', e);
    quarantineWebGLAddon(entry.webglAddon);
    entry.webglAddon = null;   // ownership moved to the quarantine; still counted there
    entry.useWebGL = false;
    return false;
  }
  entry.webglAddon = null;
  entry.useWebGL = false; // advisory field kept in step (D8)
  return true;
}
