/**
 * renderPolicy.test.ts
 *
 * design/013 (rev 2) — the per-terminal render-policy primitives.
 *
 * The invariant this file exists for is LB (§5.3): no fit issued by the policy
 * layer may measure an element with no layout box. jsdom reports offsetWidth 0
 * for EVERYTHING, so every helper below has to fake a box with
 * Object.defineProperty — the same trick engine.relocate-geometry.test.ts uses.
 * §6.1 item 2 records what that means: these tests prove the guard's arithmetic,
 * not spike 004 Q4's measurement that proposeDimensions() returns a bogus grid
 * under display:none rather than undefined.
 */

import {
  hasLayoutBox,
  fitIfLaidOut,
  getTerminalRenderPolicy,
  countActiveWebGLAddons,
  setTerminalRenderPolicy,
  setCanvasWebGLBudget,
  releaseCanvasWebGLBudget,
  getCanvasWebGLBudget,
  webglAllowedAtCreation,
  getQuarantinedWebGLAddonCount,
  clearWebGLQuarantine,
  quarantineWebGLAddon,
  releaseFromWebGLQuarantine,
} from '../renderPolicy';
import {
  terminalCache,
  resetTerminalRendering,
  refreshGlyphAtlases,
  disableWebGLGlobally,
  cleanupTerminalCache,
} from '../cache';
import { reconcileRenderPolicies } from '../renderPolicyReconciler';
import { setWebGLGloballyDisabled } from '../webgl';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { TerminalEngine } from '../TerminalEngine';
import type { TerminalBridge, Disposable } from '../types';

/** One mock instance. `disposed` does not exist on the real addon; it records that
 *  our dispose() was CALLED, which is all jsdom can show (§6.1 item 1). */
type MockWebglInstance = {
  disposed: boolean;
  dispose: () => void;
  clearTextureAtlas: () => void;
  /** The mock's real emission path — a no-op once disposed, like the addon's own
   *  emitter, which its DisposableStore tears down (rev 15). */
  fireContextLoss: () => void;
};

/** The jsdom WebglAddon mock (src/__mocks__/addon-webgl.ts) adds three statics the
 *  real addon has no equivalent of: a one-shot construction-failure switch, the last
 *  onContextLoss callback loadWebGLAddon registered, and the instance log the FA and
 *  ORPHAN invariants are stated over. */
const MockWebgl = WebglAddon as unknown as {
  failNextConstruction: boolean;
  lastContextLossHandler: (() => void) | null;
  instances: MockWebglInstance[];
};

/** Entries carry the real addon type; these tests need the mock's extra fields. */
const asMock = (addon: unknown): MockWebglInstance => addon as MockWebglInstance;

/** The jsdom FitAddon mock (src/__mocks__/addon-fit.ts) exposes a fitCount the real
 *  addon does not; existing tests reach it via `as any` (engine.relocate-eligibility
 *  .test.ts:81) and this narrows that to the one field we assert on. */
type CountingFit = FitAddon & { fitCount: number };

function makeEntry(
  key: string,
  opts: { parent?: boolean; box?: boolean; childBox?: boolean } = {},
) {
  const term = new Terminal();
  const fitAddon = new FitAddon() as CountingFit;
  term.loadAddon(fitAddon as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  term.open(host);
  // jsdom reports 0 for every box; opt IN to a real one so the default is
  // the dangerous case rather than the safe one.
  //
  // Fake the box on the HOST (term.element.parentElement), because that is the
  // element FitAddon.proposeDimensions() measures and therefore the one LB has to
  // guard. Faking it on the xterm CHILD instead is what let review 120's HIGH hide:
  // the child can report a box while the host it will actually be measured against
  // has none. `opts.childBox` exists to build exactly that asymmetric case.
  const hostEl = term.element!.parentElement!;
  const w = opts.box === false ? 0 : 800;
  const h = opts.box === false ? 0 : 600;
  Object.defineProperty(hostEl, 'offsetWidth', { value: w, configurable: true });
  Object.defineProperty(hostEl, 'offsetHeight', { value: h, configurable: true });
  if (opts.childBox) {
    Object.defineProperty(term.element!, 'offsetWidth', { value: 800, configurable: true });
    Object.defineProperty(term.element!, 'offsetHeight', { value: 600, configurable: true });
  }
  if (opts.parent === false) term.element!.remove();
  const entry = { terminal: term, fitAddon, webglAddon: null, useWebGL: false } as never;
  terminalCache.set(key, entry);
  return { term, fitAddon, entry: terminalCache.get(key)! };
}

/** ORPHAN's tests go through the real mount() path, which needs a bridge and a
 *  container with a layout box; nothing here exercises the PTY side. */
function makeBridge(): TerminalBridge {
  const noop: Disposable = { dispose() {} };
  return { onData: () => noop, onExit: () => noop, write: () => {}, resize: () => {} };
}

/** Addons reachable from the cache — one half of ORPHAN's quiescent equality. */
function reachableAddons(): number {
  return [...terminalCache.values()].filter((e) => e.webglAddon).length;
}

/** Addons that were constructed and have not been disposed — the "live" half. */
function liveAddons(): number {
  return MockWebgl.instances.filter((a) => !a.disposed).length;
}

function makeLaidOutContainer(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: 600, configurable: true });
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
  MockWebgl.failNextConstruction = false;
  MockWebgl.lastContextLossHandler = null;
  MockWebgl.instances = [];
  // The quarantine is module state that deliberately OUTLIVES the cache (that is the
  // whole point of it), so clearing the cache is not enough to isolate tests.
  clearWebGLQuarantine();
  // Test HYGIENE only — it keeps a leaked budget from poisoning the next test. It
  // is NOT the BUDGET-OWNER invariant (§5.2 note (c)), which is about production
  // teardown and gets its own test and release mechanism in Task 9.
  setCanvasWebGLBudget(null);
});

describe('design/013 §5.3 LB — never fit a terminal with no layout box', () => {
  it('is false when term.element has no parentElement', () => {
    const { term } = makeEntry('lb-noparent', { parent: false });
    expect(hasLayoutBox(term.element?.parentElement)).toBe(false);
  });

  it('is false when the element has a parent but zero box (display:none ancestor)', () => {
    const { term } = makeEntry('lb-nobox', { box: false });
    expect(hasLayoutBox(term.element?.parentElement)).toBe(false);
  });

  it('is true for a normally laid-out terminal', () => {
    const { term } = makeEntry('lb-ok');
    expect(hasLayoutBox(term.element?.parentElement)).toBe(true);
  });

  // Review 120 HIGH — the asymmetric case. An overflowing or fixed-size xterm child
  // inside a zero-sized host reports its own non-zero box. Measuring the CHILD says
  // "laid out" and lets the fit run against the zero-sized host FitAddon actually
  // measures, producing the bogus grid LB exists to prevent.
  it('is false when the xterm child has a box but its HOST does not', () => {
    const { term, fitAddon, entry } = makeEntry('lb-asymmetric', {
      box: false,
      childBox: true,
    });
    expect(term.element!.offsetWidth).toBe(800);            // the child looks fine
    expect(hasLayoutBox(term.element?.parentElement)).toBe(false);   // the host does not
    expect(fitIfLaidOut(entry)).toBe(false);
    expect(fitAddon.fitCount).toBe(0);
  });

  it('fitIfLaidOut skips the fit entirely when there is no box', () => {
    const { fitAddon, entry } = makeEntry('lb-skip', { box: false });
    expect(fitIfLaidOut(entry)).toBe(false);
    expect(fitAddon.fitCount).toBe(0);
  });

  it('fitIfLaidOut fits when there is a box', () => {
    const { fitAddon, entry } = makeEntry('lb-fit');
    expect(fitIfLaidOut(entry)).toBe(true);
    expect(fitAddon.fitCount).toBe(1);
  });
});

describe('design/013 §4 — reading policy and counting addons', () => {
  it('returns null for an unknown terminal id', () => {
    expect(getTerminalRenderPolicy('nope')).toBeNull();
  });

  it('reports dom for an entry with no addon, webgl for one with', () => {
    const { entry } = makeEntry('read-dom');
    expect(getTerminalRenderPolicy('read-dom')).toBe('dom');
    entry.webglAddon = {} as never;
    entry.useWebGL = true;
    expect(getTerminalRenderPolicy('read-dom')).toBe('webgl');
  });

  // D4: we count addons WE manage, never browser-global GPU contexts.
  it('counts addons across the whole cache, not one entry', () => {
    const a = makeEntry('count-a');
    makeEntry('count-b');
    const c = makeEntry('count-c');
    expect(countActiveWebGLAddons()).toBe(0);
    a.entry.webglAddon = {} as never;
    c.entry.webglAddon = {} as never;
    expect(countActiveWebGLAddons()).toBe(2);
  });

  // Spec test 13 / D8 / §4.1 — the addon reference is the source of truth and
  // `useWebGL` is ADVISORY. A context loss nulls the addon (webgl.ts:48-49) and an
  // entry that disagreed would hold budget for a context nobody holds. Both the
  // READ and the COUNT must key off the addon.
  it('the addon reference, not useWebGL, drives both the read and the count', () => {
    const a = makeEntry('count-flag');
    a.entry.useWebGL = true;
    a.entry.webglAddon = null;
    expect(getTerminalRenderPolicy('count-flag')).toBe('dom');
    expect(countActiveWebGLAddons()).toBe(0);
  });
});

describe('design/013 §4 — setTerminalRenderPolicy', () => {
  // Spec test 1 — spike 2 as a real test. This is the capability that did NOT
  // exist before P0-C: loadWebGLAddon had exactly one call site, in mount()'s
  // create-only branch, so a terminal could be demoted but never restored.
  it('promotes an already-open terminal and increments the addon count', () => {
    makeEntry('promote');
    expect(countActiveWebGLAddons()).toBe(0);
    expect(setTerminalRenderPolicy('promote', 'webgl')).toBe('webgl');
    expect(countActiveWebGLAddons()).toBe(1);
    expect(getTerminalRenderPolicy('promote')).toBe('webgl');
  });

  // Spec test 2 — the case resetTerminalRendering alone cannot undo.
  it('demotes, then RE-promotes', () => {
    makeEntry('cycle');
    expect(setTerminalRenderPolicy('cycle', 'webgl')).toBe('webgl');
    expect(setTerminalRenderPolicy('cycle', 'dom')).toBe('dom');
    expect(countActiveWebGLAddons()).toBe(0);
    expect(setTerminalRenderPolicy('cycle', 'webgl')).toBe('webgl');
    expect(countActiveWebGLAddons()).toBe(1);
  });

  // Spec test 3.
  it('is idempotent — setting the current policy is a no-op that returns it', () => {
    const { fitAddon } = makeEntry('idem');
    setTerminalRenderPolicy('idem', 'webgl');
    const addonBefore = terminalCache.get('idem')!.webglAddon;
    const fitsBefore = fitAddon.fitCount;
    expect(setTerminalRenderPolicy('idem', 'webgl')).toBe('webgl');
    expect(terminalCache.get('idem')!.webglAddon).toBe(addonBefore); // not rebuilt
    expect(fitAddon.fitCount).toBe(fitsBefore);                      // no churn
  });

  // D3 + D7 — reported, not thrown, and the entry is left on a coherent 'dom'.
  it('reports dom when promotion fails, and does not throw', () => {
    makeEntry('failpromo');
    MockWebgl.failNextConstruction = true;
    expect(setTerminalRenderPolicy('failpromo', 'webgl')).toBe('dom');
    expect(countActiveWebGLAddons()).toBe(0);
    expect(getTerminalRenderPolicy('failpromo')).toBe('dom');
  });

  // Spec test 8 — a promoted terminal must carry the SAME onContextLoss handler
  // the create path installs, or a lost context leaves a dead addon on the entry.
  // §6.1 item 4: this can only assert the mock captured A handler and that firing
  // it clears the entry — not that it is behaviourally identical to the create path.
  it('a context loss on a promoted terminal nulls the entry and reports dom', () => {
    makeEntry('ctxloss');
    setTerminalRenderPolicy('ctxloss', 'webgl');
    expect(MockWebgl.lastContextLossHandler).toBeTruthy();
    MockWebgl.lastContextLossHandler!();
    expect(getTerminalRenderPolicy('ctxloss')).toBe('dom');
    expect(countActiveWebGLAddons()).toBe(0);
  });

  // Review 120 HIGH (b) — a DEMOTION whose dispose() throws. If dispose() failed
  // before releasing the GPU resource, claiming 'dom' erases the only countable
  // reference to a context that may still be held, and the caller is then free to
  // allocate a replacement. The achieved policy is still 'webgl': the demotion did
  // not happen, and this function's contract is to report what was ACHIEVED (D3).
  it('quarantines and reports dom when the demotion disposal throws (rev 10)', () => {
    // WAS: "reports webgl and keeps the reference". Review 120 chose retention so the
    // addon stayed countable. That was unsafe for a reason nobody traced until rev 10:
    // retention leaves getTerminalRenderPolicy() reporting 'webgl', and the reconciler
    // re-derives that on EVERY pass with no memory of the failure — so the next
    // ordinary reconciliation called straight back in on the SAME addon, whose
    // dispose() was now latched by xterm and returned silently. It fell past the catch,
    // nulled the field and reported success, freeing a slot on no evidence at all.
    //
    // Ownership now moves to the quarantine instead: the count is unchanged (ORPHAN),
    // nothing retries it, and 'dom' is the honest achieved policy because the entry no
    // longer holds an addon.
    const { entry } = makeEntry('demote-fail');
    setTerminalRenderPolicy('demote-fail', 'webgl');
    // DELIBERATELY UN-LATCHED, and single-call-only (review `152` LOW).
    //
    // This addon has been through the real `loadWebGLAddon → term.loadAddon`, so its
    // `.dispose` is already xterm's latching wrapper; assigning over it produces an addon
    // that throws on EVERY call, which no loaded addon does. That shape hid two CRITICALs
    // here, so it is named rather than left to be rediscovered.
    //
    // It is sound ONLY because dispose() is invoked exactly once below. There is no
    // faithful alternative for an already-promoted addon — `wrappedThrower()` (foot of
    // this file) can only wrap at construction time, and the mock exposes no hook to make
    // an underlying dispose throw after `loadAddon` has captured it. If this test ever
    // grows a second dispose, convert it to a wrappedThrower fixture instead.
    const addon = asMock(entry.webglAddon);
    addon.dispose = () => {
      throw new Error('test: dispose failed before releasing the context');
    };

    expect(setTerminalRenderPolicy('demote-fail', 'dom')).toBe('dom');
    expect(entry.webglAddon).toBeNull();
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    // Still counted — the budget must not gain a slot from a context we never freed.
    expect(countActiveWebGLAddons()).toBe(1);
    expect(getTerminalRenderPolicy('demote-fail')).toBe('dom');

    // A second pass is a NO-OP, and that is the honest claim (review `152`). The entry
    // now reads 'dom' (asserted above), so `setTerminalRenderPolicy` short-circuits on
    // `current === want` at renderPolicy.ts:220 and never re-enters the dispose path at
    // all. The rev-10 retention regression is forbidden by the UNCONDITIONAL nulling on
    // line `expect(entry.webglAddon).toBeNull()` above, not by anything down here.
    expect(getTerminalRenderPolicy('demote-fail')).toBe('dom'); // why pass 2 short-circuits
    expect(setTerminalRenderPolicy('demote-fail', 'dom')).toBe('dom');
    expect(countActiveWebGLAddons()).toBe(1);
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
  });

  it('resetTerminalRendering returns false and quarantines when the disposal throws', () => {
    const { entry } = makeEntry('reset-fail');
    setTerminalRenderPolicy('reset-fail', 'webgl');
    const addon = entry.webglAddon;
    // Un-latched and single-call-only, for the same reason as 'demote-fail' above
    // (review `152` LOW) — dispose() is invoked exactly once here.
    asMock(entry.webglAddon).dispose = () => {
      throw new Error('test: dispose failed before releasing the context');
    };
    // Still `false` — the disposal really did fail — but the addon is no longer left
    // on the entry for a later pass to falsely dispose (rev 10).
    expect(resetTerminalRendering('reset-fail')).toBe(false);
    expect(entry.webglAddon).toBeNull();
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);
    releaseFromWebGLQuarantine(addon);
    expect(countActiveWebGLAddons()).toBe(0);
  });

  // Review 120 HIGH (b) — promotion failing AFTER construction. The failNextConstruction
  // switch throws before an instance exists, so it cannot see this: here the addon is
  // built and then activation throws.
  //
  // AN ACTIVATION FAILURE IS NOW CHARGED TO THE BUDGET (round 8 CRITICAL). This test used
  // to assert `countActiveWebGLAddons()` fell to 0 — that our dispose() succeeding proved
  // nothing leaked. Against the real dependency that inference is false:
  // `WebglAddon.activate()` evaluates `new WebglRenderer(...)` BEFORE `_register` captures
  // it, and the renderer acquires the context and appends its canvas to the live screen
  // element BEFORE registering the disposable that removes it again. A throw from
  // `_initializeWebGLState()` therefore leaves a DOM-attached canvas holding a real
  // context that the addon never owned — so `dispose()` succeeds precisely BECAUSE it has
  // nothing to dispose.
  //
  // Note this test still cannot reach that path: it replaces `loadAddon` wholesale, so no
  // renderer is ever constructed. That is the reality gap codex named, and it is why the
  // production fix keys on "did we enter loadAddon" rather than on what dispose() returned.
  it('charges an activation failure to the budget, because dispose() proves nothing there', () => {
    const { entry } = makeEntry('activate-fail');
    (entry.terminal as unknown as { loadAddon: (a: unknown) => void }).loadAddon = () => {
      throw new Error('test: activation failed');
    };

    expect(setTerminalRenderPolicy('activate-fail', 'webgl')).toBe('dom');
    expect(MockWebgl.instances).toHaveLength(1);        // it WAS constructed…
    expect(MockWebgl.instances[0].disposed).toBe(true); // …and we still tried to release it
    // Not reachable from the cache — the promotion reported 'dom'.
    const reachable = [...terminalCache.values()].filter((e) => e.webglAddon).length;
    expect(reachable).toBe(0);
    // …but STILL COUNTED, via the quarantine. A slot held for a context that may not
    // exist is the safe direction; an uncounted context that does exist is not, and
    // repeated failures would accumulate those without bound.
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);
  });

  it('returns dom for an unknown terminal id rather than throwing', () => {
    expect(setTerminalRenderPolicy('ghost', 'webgl')).toBe('dom');
  });

  // §5.3 LB — a policy change must never fit a terminal with no layout box.
  it('does not fit when the host has no layout box', () => {
    const { fitAddon } = makeEntry('nobox-policy', { box: false });
    setTerminalRenderPolicy('nobox-policy', 'webgl');
    expect(fitAddon.fitCount).toBe(0);
  });

  // …and the POSITIVE companion (rev 11, pre-review `140`). Without it the negative
  // above is satisfied by deleting the fit entirely: `fitCount` would be 0 in both
  // cases and the whole suite would stay green while a promoted terminal rendered
  // with stale cell metrics after the renderer swap. A negative needs a positive
  // that fails when the behaviour is removed — the adjacent resetTerminalRendering
  // describe already pairs its two; this one did not.
  it('DOES fit exactly once when the host has a layout box', () => {
    const { fitAddon } = makeEntry('box-policy');
    expect(fitAddon.fitCount).toBe(0);
    expect(setTerminalRenderPolicy('box-policy', 'webgl')).toBe('webgl');
    expect(fitAddon.fitCount).toBe(1);
  });
});

describe('design/013 §5.3 LB — resetTerminalRendering must not fit blind', () => {
  it('refreshes but does NOT fit when the host has no layout box', () => {
    const { fitAddon, entry } = makeEntry('reset-nobox', { box: false });
    entry.webglAddon = { dispose() {} } as never;
    entry.useWebGL = true;
    expect(resetTerminalRendering('reset-nobox')).toBe(true);
    expect(entry.webglAddon).toBeNull();   // still demotes
    expect(fitAddon.fitCount).toBe(0);     // but does not resize to a bogus grid
  });

  it('still fits when the host has a box', () => {
    const { fitAddon } = makeEntry('reset-box');
    resetTerminalRendering('reset-box');
    expect(fitAddon.fitCount).toBe(1);
  });

  // rev 12 (pre-review `142`) — the repaint must happen on the FAILURE path too.
  // Rev 10 added an early `return false` in the dispose catch, which skipped the
  // refresh and the fit at the tail — on the one path most likely to need them,
  // since the renderer really did just change. `origin/develop` always fell
  // through, and the sibling site disableWebGLGlobally still does, so the two
  // performed the same operation with opposite control flow.
  it('still refreshes and fits when the disposal THREW', () => {
    const { fitAddon, entry, term } = makeEntry('reset-throw-repaint');
    let refreshes = 0;
    (term as unknown as { refresh: (a: number, b: number) => void }).refresh = () => {
      refreshes += 1;
    };
    entry.webglAddon = {
      dispose() { throw new Error('test: driver refused'); },
    } as never;
    entry.useWebGL = true;

    // Still reports the disposal failure to the caller...
    expect(resetTerminalRendering('reset-throw-repaint')).toBe(false);
    // ...but the reset itself HAPPENED, and is visible.
    expect(entry.webglAddon).toBeNull();
    expect(refreshes).toBe(1);
    expect(fitAddon.fitCount).toBe(1);
    // The addon is still counted, via the quarantine (ORPHAN).
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);
  });

  // …and the bump is emitted exactly ONCE on that path, not twice. The early return
  // required its own duplicate bump; falling through would double-count it, which
  // would spuriously invalidate a snapshot taken between the two increments.
  it('bumps the generation exactly once when the disposal THREW', () => {
    const { entry } = makeEntry('reset-throw-bump');
    entry.webglAddon = {
      dispose() { throw new Error('test: driver refused'); },
    } as never;
    entry.useWebGL = true;
    const before = entry.nonCanvasPolicyGeneration ?? 0;

    expect(resetTerminalRendering('reset-throw-bump')).toBe(false);

    expect((entry.nonCanvasPolicyGeneration ?? 0) - before).toBe(1);
  });
});

describe('design/013 §5.1 — creation under an active budget', () => {
  it('allows WebGL at creation when no budget is active (every ordinary launch)', () => {
    expect(webglAllowedAtCreation()).toBe(true);
  });

  it('allows creation while the budget has room', () => {
    makeEntry('cap-a').entry.webglAddon = {} as never;
    setCanvasWebGLBudget(2);
    expect(webglAllowedAtCreation()).toBe(true);
  });

  // Spec test 10 — with the budget full, a NEWLY created terminal opens on DOM.
  it('refuses creation-time WebGL once the budget is full', () => {
    makeEntry('cap-1').entry.webglAddon = {} as never;
    makeEntry('cap-2').entry.webglAddon = {} as never;
    setCanvasWebGLBudget(2);
    expect(countActiveWebGLAddons()).toBe(2);
    expect(webglAllowedAtCreation()).toBe(false);
  });

  it('a budget of 0 refuses everything', () => {
    setCanvasWebGLBudget(0);
    expect(webglAllowedAtCreation()).toBe(false);
  });
});

describe('design/013 §5.2 BUDGET-OWNER — the creation budget survives no teardown', () => {
  it('is null before canvas mode ever runs', () => {
    expect(getCanvasWebGLBudget()).toBeNull();
  });

  // Spec test 14, the normal path.
  it('is null after an explicit release', () => {
    setCanvasWebGLBudget(12);
    expect(getCanvasWebGLBudget()).toBe(12);
    releaseCanvasWebGLBudget();
    expect(getCanvasWebGLBudget()).toBeNull();
    expect(webglAllowedAtCreation()).toBe(true);
  });

  // Spec test 14, the path that matters: canvas exit NEVER RUNS. Nothing calls
  // releaseCanvasWebGLBudget here — the arming itself must have registered the
  // release. Without it, every terminal created for the rest of the session opens
  // on the DOM renderer with no cause a user or a log could point at.
  it('is null after a teardown that never runs the canvas exit path', () => {
    setCanvasWebGLBudget(0);
    expect(webglAllowedAtCreation()).toBe(false);   // budget is armed and biting

    window.dispatchEvent(new Event('pagehide'));    // reload / detach / window close

    expect(getCanvasWebGLBudget()).toBeNull();
    expect(webglAllowedAtCreation()).toBe(true);
  });

  // Re-arming after a teardown must still work.
  it('re-arms cleanly after a teardown release', () => {
    setCanvasWebGLBudget(3);
    window.dispatchEvent(new Event('pagehide'));
    setCanvasWebGLBudget(5);
    expect(getCanvasWebGLBudget()).toBe(5);
    window.dispatchEvent(new Event('pagehide'));
    expect(getCanvasWebGLBudget()).toBeNull();
  });

  // Review 120 LOW. The test above cannot see listener STACKING: every stacked
  // listener performs the same idempotent `canvasWebGLBudget = null`, so an
  // implementation that registers one per arm passes it unchanged. Counting the
  // registrations is the only thing that proves the `budgetReleaseArmed` guard.
  //
  // A fresh module registry is required: `budgetReleaseArmed` is module state and
  // the suites above have already armed it, so the spy would see zero calls on the
  // shared instance rather than the one this asserts.
  it('registers exactly ONE pagehide listener across repeated arms', () => {
    const addSpy = jest.spyOn(window, 'addEventListener');
    try {
      let mod!: typeof import('../renderPolicy');
      jest.isolateModules(() => {
        mod = require('../renderPolicy') as typeof import('../renderPolicy');
      });
      mod.setCanvasWebGLBudget(1);
      mod.setCanvasWebGLBudget(null);
      mod.setCanvasWebGLBudget(2);
      window.dispatchEvent(new Event('pagehide'));
      mod.setCanvasWebGLBudget(3);
      mod.releaseCanvasWebGLBudget();
      mod.setCanvasWebGLBudget(4);

      const pagehideRegistrations = addSpy.mock.calls.filter((c) => c[0] === 'pagehide');
      expect(pagehideRegistrations).toHaveLength(1);
    } finally {
      addSpy.mockRestore();
    }
  });
});

describe('design/013 §4.2 FA — promotion always constructs a fresh addon', () => {
  it('never hands back the disposed addon on a re-promotion', () => {
    makeEntry('fa-cycle');
    setTerminalRenderPolicy('fa-cycle', 'webgl');
    const first = asMock(terminalCache.get('fa-cycle')!.webglAddon);
    expect(MockWebgl.instances).toHaveLength(1);

    setTerminalRenderPolicy('fa-cycle', 'dom');
    expect(first.disposed).toBe(true);
    expect(terminalCache.get('fa-cycle')!.webglAddon).toBeNull();

    setTerminalRenderPolicy('fa-cycle', 'webgl');
    const second = asMock(terminalCache.get('fa-cycle')!.webglAddon);
    expect(second).not.toBe(first);          // FA: a FRESH addon, not the cached one
    expect(second.disposed).toBe(false);
    expect(MockWebgl.instances).toHaveLength(2);
    expect(countActiveWebGLAddons()).toBe(1);
  });

  // The budget-boundary thrash the "optimisation" would target: N cycles must
  // produce N addons, all but the last disposed. If a disposed addon is ever
  // retained, the instance count stops tracking the cycle count.
  it('produces one addon per cycle across repeated thrash', () => {
    makeEntry('fa-thrash');
    for (let i = 0; i < 5; i++) {
      setTerminalRenderPolicy('fa-thrash', 'webgl');
      setTerminalRenderPolicy('fa-thrash', 'dom');
    }
    expect(MockWebgl.instances).toHaveLength(5);
    expect(MockWebgl.instances.every((a) => a.disposed)).toBe(true);
    expect(countActiveWebGLAddons()).toBe(0);
  });

  // The §4.2 corollary: an addon promoted around a resume signal has a NEW atlas,
  // so refreshGlyphAtlases' order-dependence is not incorrectness. Pinned because
  // the corollary is what makes the FA statement load-bearing rather than a note.
  it('a freshly promoted addon is reachable by refreshGlyphAtlases', () => {
    makeEntry('fa-atlas');
    setTerminalRenderPolicy('fa-atlas', 'webgl');
    const addon = asMock(terminalCache.get('fa-atlas')!.webglAddon);
    addon.clearTextureAtlas = jest.fn();
    refreshGlyphAtlases();
    expect(addon.clearTextureAtlas).toHaveBeenCalledTimes(1);
  });
});

describe('design/013 §5.2 ORPHAN — no addon is replaced without being disposed', () => {
  // The reattach half: a mount() with no unmount() carries the SAME addon forward
  // (TerminalEngine.ts:2052-2053), so nothing is orphaned and the count is unchanged.
  it('a remount that reattaches keeps the same addon and the same count', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'orphan-reattach' });
    engine.mount(makeLaidOutContainer());
    const first = asMock(terminalCache.get('orphan-reattach')!.webglAddon);
    expect(first).toBeTruthy();

    engine.mount(makeLaidOutContainer());          // no unmount() in between

    expect(terminalCache.get('orphan-reattach')!.webglAddon).toBe(first);
    expect(first.disposed).toBe(false);
    expect(countActiveWebGLAddons()).toBe(1);
  });

  // The create half — the hole. The create branch is entered when the cached
  // terminal has no element, and it REPLACES the entry. Every constructed addon
  // must therefore be either reachable from the cache or disposed; an addon that
  // is neither is a GPU context nobody can free and nobody can count.
  it('a remount that falls to the create branch disposes the addon it replaces', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'orphan-create' });
    engine.mount(makeLaidOutContainer());
    const first = asMock(terminalCache.get('orphan-create')!.webglAddon);
    expect(first).toBeTruthy();

    // Force the create branch on the next mount: the reattach path is gated on
    // `cached.terminal.element`, the create path on its negation.
    (terminalCache.get('orphan-create')!.terminal as { element?: unknown }).element = undefined;

    engine.mount(makeLaidOutContainer());          // still no unmount()

    const second = asMock(terminalCache.get('orphan-create')!.webglAddon);
    expect(second).not.toBe(first);
    expect(first.disposed).toBe(true);             // silently orphaned without the fix
    // ORPHAN, stated as the end-state property it is: live addons == reachable addons.
    const reachable = [...terminalCache.values()].filter((e) => e.webglAddon).length;
    const live = MockWebgl.instances.filter((a) => !a.disposed).length;
    expect(live).toBe(reachable);
    expect(countActiveWebGLAddons()).toBe(reachable);
  });

  // Review 120 HIGH — the reattach FAILURE route. The reattach path used to answer an
  // appendChild/fit throw by deleting the cache entry and falling through to create.
  // disposeOrphanedWebGLAddon then looked the id up, found nothing, and could not
  // dispose the outgoing addon: a live, uncounted context, i.e. ORPHAN false on a
  // route neither test above reaches (both force the create branch with the entry
  // still present). The fix aborts the mount and keeps the entry.
  it('a reattach whose fit throws keeps the entry rather than orphaning its addon', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'orphan-reattach-fail' });
    engine.mount(makeLaidOutContainer());
    const entryBefore = terminalCache.get('orphan-reattach-fail')!;
    const first = asMock(entryBefore.webglAddon);
    expect(first).toBeTruthy();

    // The reattach path is entered because `terminal.element` is set; its re-fit
    // is the throw this finding is about.
    (entryBefore.fitAddon as unknown as { fit: () => void }).fit = () => {
      throw new Error('test: reattach fit failed');
    };

    engine.mount(makeLaidOutContainer());          // still no unmount()

    // Nothing was deleted and re-created: the same Terminal and the same addon are
    // still owned by the cache, so the scrollback and the GPU context both survive.
    // (The ENTRY OBJECT is legitimately rebuilt at the end of a successful mount,
    // carrying these forward — so identity is asserted on the terminal and the
    // addon, not on the entry wrapper.)
    const after = terminalCache.get('orphan-reattach-fail')!;
    expect(after.terminal).toBe(entryBefore.terminal);
    expect(after.webglAddon).toBe(first);
    expect(first.disposed).toBe(false);
    // No second addon was constructed to replace it.
    expect(MockWebgl.instances).toHaveLength(1);
    // ORPHAN as the end-state property: live addons == addons reachable from the cache.
    const reachable = [...terminalCache.values()].filter((e) => e.webglAddon).length;
    const live = MockWebgl.instances.filter((a) => !a.disposed).length;
    expect(live).toBe(reachable);
  });

  // Review 124 HIGH — the abort itself was the bug. Aborting mid-mount left the
  // engine half-built: `this.container` repointed, both disposable sets already
  // run, and the early return skipping `this.term`, the listener/observer wiring
  // and the watchdog. mount() returns void, so no caller can detect it;
  // TerminalDisplay went on to attach() and then read `engine.terminal`, whose
  // getter throws. A fit failure must therefore be NON-fatal.
  it('finishes the mount when the reattach fit throws, leaving a usable engine', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'reattach-fit-nonfatal' });
    engine.mount(makeLaidOutContainer());
    const entryBefore = terminalCache.get('reattach-fit-nonfatal')!;

    (entryBefore.fitAddon as unknown as { fit: () => void }).fit = () => {
      throw new Error('test: reattach fit failed');
    };

    const target = makeLaidOutContainer();
    engine.mount(target);

    // Same Terminal — no delete-and-recreate. (The entry wrapper is rebuilt by a
    // successful mount, which is exactly the point: the mount COMPLETED.)
    const after = terminalCache.get('reattach-fit-nonfatal')!;
    expect(after.terminal).toBe(entryBefore.terminal);
    // The surface really did move to the new host...
    expect(after.terminal.element!.parentElement).toBe(target);
    // ...and the engine is USABLE: this getter is what threw for the caller before.
    expect(() => engine.terminal).not.toThrow();
    expect(engine.terminal).toBe(entryBefore.terminal);
  });

  // Review 126 MEDIUM — the surface MOVE failure, as a PUBLIC contract.
  //
  // Making only the FIT non-fatal left the MOVE abort with the same unreportable
  // shape: before appendChild the method had already repointed `this.container`,
  // disconnected the observer and run BOTH of the entry's disposable sets, so the
  // comment claiming the entry stayed "exactly as it was" was false — the old
  // container's focus/search listeners and the local handlers were gone — and
  // `mount(): void` gave the caller no way to know. A caller continuing to
  // `engine.terminal` got "terminal accessed before mount()".
  //
  // The move now runs BEFORE anything is torn down, and mount() returns whether it
  // mounted.
  it('a reattach whose surface MOVE throws refuses the mount and leaves the entry usable', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'move-fail' });
    expect(engine.mount(makeLaidOutContainer())).toBe(true);
    const entry = terminalCache.get('move-fail')!;
    const surface = entry.terminal.element!;
    const homeContainer = surface.parentElement;
    expect(entry.disposables.length).toBeGreaterThan(0);
    expect(entry.containerDisposables.length).toBeGreaterThan(0);

    // A host supplies a container appendChild refuses — e.g. a descendant of the
    // terminal surface, which raises HierarchyRequestError.
    const bad = makeLaidOutContainer();
    bad.appendChild = () => {
      throw new Error('test: HierarchyRequestError');
    };

    // REFUSE ON THE ORIGINAL, LIVE ENGINE FIRST (review 129 MEDIUM 1). Asserting
    // this only through a fresh second engine — as rev 5 did — could not observe
    // the defect at all: that engine's observer and disposer arrays are empty
    // before the call, so "the arrays are still populated" was true no matter what
    // mount() did to the engine that owned the live mount. The engine-local half of
    // this (the observer, and unmount() still removing the container listeners)
    // needs a ResizeObserver stub jsdom does not provide and lives in
    // engine.mount-refusal.test.ts; what belongs HERE is the CACHE-side contract.
    expect(engine.mount(bad)).toBe(false);
    expect((engine as unknown as { containerDisposables: unknown[] }).containerDisposables)
      .toHaveLength(4);
    expect(terminalCache.get('move-fail')!.disposables.length).toBeGreaterThan(0);
    expect(surface.parentElement).toBe(homeContainer);

    // Production builds a FRESH engine per React mount.
    const engine2 = new TerminalEngine(makeBridge(), { cacheKey: 'move-fail' });
    expect(engine2.mount(bad)).toBe(false);

    // Nothing was torn down and nothing moved: same Terminal, same addon, both
    // disposable sets still live, surface still in its old container.
    const after = terminalCache.get('move-fail')!;
    expect(after.terminal).toBe(entry.terminal);
    expect(after.disposables.length).toBeGreaterThan(0);
    expect(after.containerDisposables.length).toBeGreaterThan(0);
    expect(surface.parentElement).toBe(homeContainer);
    // The refusal is DETECTABLE, and the engine that refused is honest about it.
    // `engine2` was never mounted, so its getter throws; `engine` — refused while
    // ALREADY mounted — stays usable where it was, which is the contract rev 6
    // states and rev 5 got backwards.
    expect(() => engine2.terminal).toThrow();
    // The VALUE is the contract, not merely that the getter survives (rev 16, test
    // audit `150` H1). design/013 §5.2 says a refused-mid-move engine "stays mounted,
    // wired and observed on its old container — `this.term` is still assigned and
    // still valid". A pre-commit reassignment to a truthy-but-WRONG Terminal would
    // leave `not.toThrow()` green while the engine silently drove someone else's
    // terminal, and this spec has recorded "another pre-commit mutation slipped past
    // review" three separate times.
    expect(engine.terminal).toBe(entry.terminal);

    // ...and a retry into a good container still works.
    const good = makeLaidOutContainer();
    const engine3 = new TerminalEngine(makeBridge(), { cacheKey: 'move-fail' });
    expect(engine3.mount(good)).toBe(true);
    expect(engine3.terminal).toBe(entry.terminal);
    expect(entry.terminal.element!.parentElement).toBe(good);
  });

  // Review 120 HIGH (b) — disposal that THROWS on the create path. Nulling the entry
  // fields anyway erases the only countable reference to a context that may still be
  // held; allocating a replacement on top of it is the unsafe direction for a hard
  // budget. Retaining the reference and refusing the replacement is the safe one.
  it('a create-path disposal that throws allocates no replacement context', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'orphan-dispose-fail' });
    engine.mount(makeLaidOutContainer());
    const first = asMock(terminalCache.get('orphan-dispose-fail')!.webglAddon);
    first.dispose = () => {
      throw new Error('test: dispose failed before releasing the context');
    };

    // Force the create branch, exactly as the two tests above do.
    (terminalCache.get('orphan-dispose-fail')!.terminal as { element?: unknown }).element =
      undefined;
    engine.mount(makeLaidOutContainer());

    // No second context was allocated on top of one that may still be held: the
    // replacing terminal opens on the DOM renderer instead.
    expect(MockWebgl.instances).toHaveLength(1);
    expect(getTerminalRenderPolicy('orphan-dispose-fail')).toBe('dom');
    // The addon that refused to be disposed is the only live one, and it is exactly
    // as live as it was before the remount — the count never grows past a failure.
    expect(first.disposed).toBe(false);
    expect(MockWebgl.instances.filter((a) => !a.disposed)).toHaveLength(1);
    // Review 124 HIGH — and it is still COUNTED. The entry that held it has been
    // replaced, so `reachable` can no longer see it; the quarantine is what keeps
    // ORPHAN's equality exact: live === reachable + quarantined === count.
    expect(reachableAddons()).toBe(0);
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);
  });

  // The ordering the fix depends on: the dispose frees a slot the NEW terminal is
  // entitled to, so it must run BEFORE webglAllowedAtCreation(). Reversed, a
  // remount under a full budget silently drops to the DOM renderer.
  it('the freed slot is available to the terminal replacing it, even at a full budget', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'orphan-budget' });
    engine.mount(makeLaidOutContainer());
    expect(countActiveWebGLAddons()).toBe(1);

    setCanvasWebGLBudget(1);                       // full, counting this terminal
    (terminalCache.get('orphan-budget')!.terminal as { element?: unknown }).element = undefined;
    engine.mount(makeLaidOutContainer());

    expect(getTerminalRenderPolicy('orphan-budget')).toBe('webgl');
    expect(countActiveWebGLAddons()).toBe(1);
  });
});

/**
 * design/013 §5.2 ORPHAN, review 124 HIGH — the QUARANTINE.
 *
 * `disposeOrphanedWebGLAddon` retaining a failed addon on its entry is defeated the
 * moment the caller replaces that entry: the addon is then live, unreachable, and
 * invisible to `countActiveWebGLAddons()`. Refusing to allocate in that one
 * expression bounds nothing — every repetition adds another uncounted live context,
 * and neither the cache cap nor the budget bounds objects no longer in the cache.
 *
 * The quarantine restates ORPHAN as an equality that survives entry replacement:
 *
 *     live === reachable + quarantined === countActiveWebGLAddons()
 */
describe('design/013 §5.2 ORPHAN — the failed-disposal quarantine', () => {
  /** Force the next mount down the create branch: reattach is gated on element. */
  const dropElement = (key: string) => {
    (terminalCache.get(key)!.terminal as { element?: unknown }).element = undefined;
  };
  const throwOnDispose = (addon: MockWebglInstance) => {
    addon.dispose = () => {
      throw new Error('test: dispose failed before releasing the context');
    };
  };

  it('keeps a create-path disposal failure counted after its entry is replaced', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'q-single' });
    engine.mount(makeLaidOutContainer());
    const first = asMock(terminalCache.get('q-single')!.webglAddon);
    throwOnDispose(first);

    dropElement('q-single');
    engine.mount(makeLaidOutContainer());

    // The entry that held it is gone, so nothing reaches it — but it is still live.
    expect(first.disposed).toBe(false);
    expect(terminalCache.get('q-single')!.webglAddon).toBeNull();
    expect(reachableAddons()).toBe(0);
    // ORPHAN's equality, stated exactly.
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(liveAddons()).toBe(reachableAddons() + getQuarantinedWebGLAddonCount());
    expect(countActiveWebGLAddons()).toBe(liveAddons());
  });

  // The UNBOUNDED half of the finding: one failure is a rounding error, N failures
  // are a budget that has silently stopped meaning anything. Each iteration wedges a
  // fresh addon and replaces its entry, so the drift — if any — accumulates.
  it('never lets the count drift below the live addons across repeated failures', () => {
    for (let i = 0; i < 5; i++) {
      const key = `q-repeat-${i}`;
      const engine = new TerminalEngine(makeBridge(), { cacheKey: key });
      engine.mount(makeLaidOutContainer());
      const addon = asMock(terminalCache.get(key)!.webglAddon);
      throwOnDispose(addon);
      dropElement(key);
      engine.mount(makeLaidOutContainer());

      // Asserted INSIDE the loop: the drift is per-iteration, so a check only at the
      // end cannot tell "never drifted" from "drifted and recovered".
      expect(countActiveWebGLAddons()).toBe(liveAddons());
      expect(countActiveWebGLAddons()).toBeGreaterThanOrEqual(i + 1);
    }
    expect(getQuarantinedWebGLAddonCount()).toBe(5);
    expect(liveAddons()).toBe(reachableAddons() + getQuarantinedWebGLAddonCount());
  });

  // The concrete failure the reviewer described: a free-looking slot. The budget is
  // the only thing standing between a wedged context and a second context allocated
  // on top of it, and the budget can only see what the count reports.
  it('does not free a budget slot for a terminal created after the failure', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'q-budget' });
    engine.mount(makeLaidOutContainer());
    throwOnDispose(asMock(terminalCache.get('q-budget')!.webglAddon));

    setCanvasWebGLBudget(1);
    dropElement('q-budget');
    engine.mount(makeLaidOutContainer());

    // One context is wedged and uncollectable; the budget of 1 is therefore SPENT.
    expect(countActiveWebGLAddons()).toBe(1);
    expect(webglAllowedAtCreation()).toBe(false);

    const other = new TerminalEngine(makeBridge(), { cacheKey: 'q-budget-2' });
    other.mount(makeLaidOutContainer());
    expect(getTerminalRenderPolicy('q-budget-2')).toBe('dom');
    expect(liveAddons()).toBe(1);
  });

  // RETRACTED at rev 10. Was: "the quarantine is a holding pen, not a graveyard —
  // a context that later frees must give its slot back". It is a graveyard, because
  // nothing can tell us a context freed. The fixture below is what hid that: it
  // restored `first.dispose = realDispose`, overwriting the wrapper xterm installed
  // and manufacturing a recovery that cannot occur for a loaded addon.
  it('keeps holding the slot even after the underlying driver recovers', () => {
    const engine = new TerminalEngine(makeBridge(), { cacheKey: 'q-drain' });
    engine.mount(makeLaidOutContainer());
    const first = asMock(terminalCache.get('q-drain')!.webglAddon);
    throwOnDispose(first);
    dropElement('q-drain');
    engine.mount(makeLaidOutContainer());
    expect(countActiveWebGLAddons()).toBe(1);
    expect(getQuarantinedWebGLAddonCount()).toBe(1);

    // No amount of ordinary activity releases it: there is no drain to run, and the
    // addon's own dispose() is latched, so a caller retrying it would get silence.
    //
    // `dropElement` FIRST, and that is load-bearing (review `152`). Without it this
    // mount takes the REATTACH branch (TerminalEngine.ts:1122) — the entry's new
    // terminal has an element, and `disposeOrphanedWebGLAddon` exists only in the
    // CREATE branch (:1547). The assertions below then held trivially because nothing
    // ran, which is not the same as "ordinary activity did not release it".
    dropElement('q-drain');
    engine.mount(makeLaidOutContainer());
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    // ORPHAN itself: live === reachable + quarantined. The wedged addon is still
    // LIVE (never disposed), and the count still sees it — which is the whole point.
    // The old drain would have deleted it here and broken this equality downward.
    expect(countActiveWebGLAddons()).toBe(liveAddons());
  });

  // The UNBOUNDED half of the finding: one failure is a rounding error, N failures
  // are a budget that has silently stopped meaning anything. Each iteration wedges a
  // fresh addon and replaces its entry, so the drift — if any — accumulates.


  // webgl.ts's last hole: activation fails, and the cleanup dispose ALSO throws. The
  // addon was constructed — so it may hold a context — and `loadWebGLAddon` returns
  // null, dropping the only reference that will ever exist to it.
  it('quarantines an addon whose failed-activation cleanup also throws', () => {
    const { entry } = makeEntry('q-activate-fail');
    (entry.terminal as unknown as { loadAddon: (a: unknown) => void }).loadAddon = (a) => {
      throwOnDispose(a as MockWebglInstance);
      throw new Error('test: activation failed');
    };

    expect(setTerminalRenderPolicy('q-activate-fail', 'webgl')).toBe('dom');

    expect(MockWebgl.instances).toHaveLength(1);
    expect(MockWebgl.instances[0].disposed).toBe(false);   // it refused to die…
    expect(getQuarantinedWebGLAddonCount()).toBe(1);       // …so it is still counted
    expect(entry.webglAddon).toBeNull();
    expect(liveAddons()).toBe(reachableAddons() + getQuarantinedWebGLAddonCount());
    expect(countActiveWebGLAddons()).toBe(1);
  });

});

/**
 * design/013 D4 — the addon REFERENCE is the source of truth for the budget count,
 * so no path may null it while the context may still be held.
 *
 * `disableWebGLGlobally` swallowed a dispose() error and nulled anyway. Before P0-C
 * that was merely untidy; now `countActiveWebGLAddons` reads that reference, so it
 * under-counts a context we failed to free — the unsafe direction for a hard budget,
 * and the same hazard review 120 found in the disposal helpers. Flagged by the
 * implementer of `fd860c1`; no reviewer had examined it.
 */
describe('design/013 D4 — global disable must not erase a possibly-live addon', () => {
  it('quarantines (and keeps counting) the addon when dispose() throws', () => {
    // WAS: "retains the reference (and the count)". Retention kept the count right
    // but left the addon on the entry — and this path is RE-DRIVABLE: `toggleWebGL`
    // in the context menu lets a user disable, re-enable and disable again. The
    // second pass's dispose() hits xterm's already-set `isDisposed` latch, returns
    // silently, and the old code then took its `disposed === true` branch and nulled
    // the field — freeing a budget slot for a call that did no work whatsoever.
    // This is the same root cause as the demotion path, at a third site (rev 10).
    const { entry } = makeEntry('gd-throws');
    const addon = { dispose: () => { throw new Error('gpu wedged'); }, clearTextureAtlas: () => {} };
    entry.webglAddon = addon as never;
    entry.useWebGL = true;
    expect(countActiveWebGLAddons()).toBe(1);

    disableWebGLGlobally();

    // The context may still be held, so it must still be counted — but by the
    // QUARANTINE, which nothing can talk into a false success.
    expect(entry.webglAddon).toBeNull();
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);

    // Toggling again is a NO-OP, and saying so is the honest version of this block
    // (review `152`). `disableWebGLGlobally` nulls `webglAddon` on the THROW branch as
    // well as the success branch, so the second call finds the field already falsy
    // (cache.ts:435) and skips the dispose/quarantine block entirely — it re-exercises
    // NOTHING. What actually forbids the rev-10 retention regression is that
    // unconditional nulling, asserted directly above.
    expect(entry.webglAddon).toBeNull(); // the precondition that makes pass 2 a no-op
    setWebGLGloballyDisabled(false);
    disableWebGLGlobally();
    expect(countActiveWebGLAddons()).toBe(1);
    expect(getQuarantinedWebGLAddonCount()).toBe(1);

    setWebGLGloballyDisabled(false);
  });

  it('clears the reference when dispose() succeeds', () => {
    const { entry } = makeEntry('gd-ok');
    let disposed = false;
    entry.webglAddon = { dispose: () => { disposed = true; }, clearTextureAtlas: () => {} } as never;
    entry.useWebGL = true;

    disableWebGLGlobally();

    expect(disposed).toBe(true);
    expect(entry.webglAddon).toBeNull();
    expect(entry.useWebGL).toBe(false);
    expect(countActiveWebGLAddons()).toBe(0);

    setWebGLGloballyDisabled(false);
  });
});

/**
 * Review 126 HIGH — a quarantined addon's context-loss handler must not mutate its
 * REPLACEMENT. The handler closes over `terminalId`, not over cache ownership, so
 * it outlives the addon's tenure. The quarantine made that reachable by design: A
 * fails to dispose and is quarantined, the same terminal is later promoted onto B,
 * then A reports context loss. Unguarded, A's handler cleared B from the cache and
 * bumped B's generation — B live but unreachable — and a later drain of A dropped
 * the count to zero while B still held a context.
 */
describe('design/013 §5.2 — a stale context-loss handler must not clear a replacement', () => {
  it('leaves the replacement addon reachable and keeps live == reachable + quarantined', () => {
    const { entry } = makeEntry('stale-ctxloss');

    // Promote onto addon A, capturing A's handler and making its dispose throw so
    // the create/demote path has to quarantine it.
    setTerminalRenderPolicy('stale-ctxloss', 'webgl');
    const addonA = asMock(entry.webglAddon);
    const handlerA = MockWebgl.lastContextLossHandler!;
    expect(handlerA).toBeTruthy();
    addonA.dispose = () => { throw new Error('test: A refuses disposal'); };

    // Demotion fails, so A stays owned and counted.
    setTerminalRenderPolicy('stale-ctxloss', 'dom');
    quarantineWebGLAddon(addonA as never);
    entry.webglAddon = null;
    entry.useWebGL = false;
    expect(getQuarantinedWebGLAddonCount()).toBe(1);

    // The same terminal is promoted again — onto a fresh addon B.
    setTerminalRenderPolicy('stale-ctxloss', 'webgl');
    const addonB = asMock(entry.webglAddon);
    expect(addonB).not.toBe(addonA);
    const genBefore = entry.nonCanvasPolicyGeneration ?? 0;

    // Now A's saved handler is invoked directly, long after A stopped owning the slot.
    //
    // WHAT THIS IS, PRECISELY (corrected, round 8 MEDIUM): a DEFENCE-IN-DEPTH check on a
    // call production can no longer make. Invoking `handlerA()` bypasses xterm's disposal
    // wrapper and the mock's own `fireContextLoss()`, and A's emitter died inside
    // `DisposableStore.clear()` when its `dispose()` threw — so nothing can deliver this.
    // The earlier version of this test asserted the quarantine fell 1 -> 0 here and called
    // it real GPU recovery, which contradicted rev 15's own §5 text: quarantine is
    // PERMANENT for the renderer's lifetime.
    //
    // The guard being pinned is the review-126 HIGH — a stale handler must not mutate its
    // REPLACEMENT — and that is worth keeping precisely because it is cheap and the
    // consequence (B live but unreachable) is severe.
    handlerA();

    // B must survive untouched: still cached, still counted, generation not bumped.
    expect(entry.webglAddon).toBe(addonB as never);
    expect(entry.nonCanvasPolicyGeneration ?? 0).toBe(genBefore);
    // A leaves the SET, because that is what this direct call does — but note it is the
    // impossible path. The reachable-path assertion is the sibling test below.
    expect(getQuarantinedWebGLAddonCount()).toBe(0);

    const reachable = [...terminalCache.values()].filter((e) => e.webglAddon).length;
    expect(reachable).toBe(1);
    expect(countActiveWebGLAddons()).toBe(reachable + getQuarantinedWebGLAddonCount());
  });

  // The REACHABLE path, which no test covered until round 8 pointed out that the one
  // above only ever exercised the impossible one.
  //
  // Delivered through the addon's real emission path instead of a saved callback: a
  // quarantined addon's emitter was torn down by the very `dispose()` that quarantined it,
  // so no listener runs and the count MUST hold at 1 for the renderer's lifetime. This is
  // the assertion that would catch someone "restoring" opportunistic release.
  it('a quarantined addon stays quarantined when context loss is delivered for real', () => {
    const { entry } = makeEntry('ctxloss-reachable');

    setTerminalRenderPolicy('ctxloss-reachable', 'webgl');
    const addonA = asMock(entry.webglAddon);

    // TEAR DOWN FIRST, THEN THROW — the order `DisposableStore.clear()` actually has:
    // `try { dispose(children) } finally { this._toDispose.clear() }`. The emitter dies
    // even though the disposal fails, which is the entire reason quarantine is permanent.
    //
    // Writing this as a bare `dispose = () => { throw }` (the shape used elsewhere in this
    // file) skips the mock's own teardown, leaves the listener alive, and makes the
    // release below reachable — so the test would have asserted the opposite of reality.
    // That mistake was made HERE first, on the test written to prove this very point.
    const realDispose = addonA.dispose.bind(addonA);
    addonA.dispose = () => {
      realDispose();
      throw new Error('test: A refuses disposal');
    };

    setTerminalRenderPolicy('ctxloss-reachable', 'dom');
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);

    // The real emission path. The mock models the emitter dying with dispose(), so this
    // reaches nobody — exactly as the production addon behaves.
    addonA.fireContextLoss();

    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);
  });
});

/**
 * Review 132 LOW 1 — the drain's synchronous cost per pass must be bounded by a
 * constant, not by the quarantine's size.
 *
 * The declined-backoff rationale claimed the quarantine was bounded by the GPU
 * budget. It is not: §5.2 says the registry deliberately grows past its warning
 * threshold, and outside canvas mode no budget is armed at all. N permanently wedged
 * addons therefore made every reconciliation perform N throwing `dispose()` calls.
 */
describe('design/013 §5.2 — quarantine is TERMINAL (rev 10, retracting review 132 LOW)', () => {
  /**
   * Rev 7 added a bounded round-robin retry so a driver hiccup would not tax the
   * budget for the session. Rev 10 deletes it, and these tests record why rather
   * than vanishing quietly.
   *
   * The retry could never have fired in production. Its per-addon `failures` counter
   * could not exceed 0, because xterm's AddonManager latches `isDisposed` BEFORE
   * calling the real dispose — so a wrapped addon can throw at most ONCE, and every
   * later dispose() returns silently. The old tests passed only because `makeWedged`
   * built a plain object that had never been through `term.loadAddon`, i.e. a
   * contract no real addon has. Worse, the drain RELEASED on a non-throwing dispose,
   * so in production it would have freed a budget slot for a context that was never
   * released — the exact under-count the quarantine exists to prevent.
   */
  it('holds a wedged addon forever, and never retries dispose()', () => {
    const term = new Terminal();
    const addon = new WebglAddon();
    let realDisposeCalls = 0;
    (addon as unknown as { dispose: () => void }).dispose = () => {
      realDisposeCalls += 1;
      throw new Error('test: driver refused to release the context');
    };
    // THROUGH loadAddon — this is the whole point. The mock now installs xterm's
    // real wrapper, so the latch behaves as it does in production.
    term.loadAddon(addon as never);

    expect(() => addon.dispose()).toThrow();
    expect(realDisposeCalls).toBe(1);
    quarantineWebGLAddon(addon);
    expect(countActiveWebGLAddons()).toBe(1);

    // The latch is set: a retry does no work and throws nothing. This is what made
    // "dispose() did not throw" worthless as evidence of release.
    expect(() => addon.dispose()).not.toThrow();
    expect(realDisposeCalls).toBe(1);

    // …and nothing in the module retries or releases it.
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);
  });

  it('releases only on context loss, the one proof we actually have', () => {
    const stuck = { dispose() { throw new Error('test: wedged'); } };
    quarantineWebGLAddon(stuck);
    expect(getQuarantinedWebGLAddonCount()).toBe(1);

    releaseFromWebGLQuarantine(stuck);
    expect(getQuarantinedWebGLAddonCount()).toBe(0);
    expect(countActiveWebGLAddons()).toBe(0);
  });
});

/**
 * THE TEST WHOSE ABSENCE LET BOTH CRITICALS THROUGH (rev 10, pre-review `138`).
 *
 * Every pre-existing quarantine/demotion test built its failing addon as a plain
 * object, or overwrote `.dispose` on a loaded one. Both produce an addon that throws
 * on EVERY call — a contract no real addon has. xterm's AddonManager replaces the
 * instance's `.dispose` at `loadAddon` time and latches `isDisposed` BEFORE invoking
 * the original, so a real addon throws at most ONCE and every retry returns silently.
 *
 * These tests route an addon through the REAL `term.loadAddon` wrapper first, and
 * only then make its underlying dispose throw — which is the production shape, and
 * the one shape nothing in this suite covered.
 */
describe('a REAL loadAddon-wrapped addon whose dispose throws (rev 10)', () => {
  /** Wrap like production, then make the UNDERLYING dispose throw once. */
  function wrappedThrower() {
    const term = new Terminal();
    let underlyingCalls = 0;
    const addon = {
      dispose() {
        underlyingCalls += 1;
        throw new Error('test: driver refused to release the context');
      },
      activate() {},
      clearTextureAtlas() {},
    };
    term.loadAddon(addon as never);
    return { addon, calls: () => underlyingCalls };
  }

  it('throws exactly ONCE, then returns silently forever — the latch', () => {
    const { addon, calls } = wrappedThrower();

    expect(() => addon.dispose()).toThrow();
    expect(calls()).toBe(1);

    // THE MECHANISM. Not "it recovered" — the underlying dispose was never reached.
    expect(() => addon.dispose()).not.toThrow();
    expect(() => addon.dispose()).not.toThrow();
    expect(calls()).toBe(1);
  });

  it('a demotion that fails does not become a success on the next pass', () => {
    const { entry } = makeEntry('wrapped-demote');
    const { addon, calls } = wrappedThrower();
    entry.webglAddon = addon as never;
    entry.useWebGL = true;
    expect(countActiveWebGLAddons()).toBe(1);

    // Pass 1: the real dispose throws. Ownership moves to the quarantine.
    expect(setTerminalRenderPolicy('wrapped-demote', 'dom')).toBe('dom');
    expect(calls()).toBe(1);
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);

    // Passes 2 and 3 are NO-OPS, and the honest claim is that they cannot be anything
    // else (review `152`). `resetTerminalRendering` nulls `webglAddon` on the throw
    // branch too, so the entry already reads 'dom' and each repeat short-circuits on
    // `current === want` before reaching the dispose path.
    //
    // The retention world this comment used to describe — entry still holding the addon,
    // its latched dispose() returning silently, the code freeing a slot for a context
    // nobody released — is UNREACHABLE precisely because of that unconditional nulling.
    // Reconstructing it here would take a fixture harsher than reality, which is the same
    // defect class as one kinder than reality; the guard is the assertion above.
    expect(getTerminalRenderPolicy('wrapped-demote')).toBe('dom'); // why they short-circuit
    setTerminalRenderPolicy('wrapped-demote', 'dom');
    setTerminalRenderPolicy('wrapped-demote', 'dom');
    expect(calls()).toBe(1);                       // never re-attempted — the xterm latch
    expect(countActiveWebGLAddons()).toBe(1);      // and never falsely freed
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
  });

  it('a cleanup that fails does not become a success on any later activity', () => {
    const { addon, calls } = wrappedThrower();
    terminalCache.set('wrapped-cleanup', {
      terminal: { dispose() {} },
      fitAddon: {},
      webglAddon: addon,
      useWebGL: true,
      disposables: [],
      containerDisposables: [],
    } as never);
    expect(countActiveWebGLAddons()).toBe(1);

    cleanupTerminalCache('wrapped-cleanup');
    expect(calls()).toBe(1);
    expect(terminalCache.has('wrapped-cleanup')).toBe(false);
    // The entry is gone, so the quarantine is the ONLY thing keeping this counted.
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);

    // Reconciliation used to drain here and release it on the silent return.
    reconcileRenderPolicies({ desired: {}, budget: 4, order: [] });
    expect(calls()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);

    // Only context loss releases it.
    releaseFromWebGLQuarantine(addon);
    expect(countActiveWebGLAddons()).toBe(0);
  });
});

/**
 * rev 15 (codex round 7, MEDIUM) — the quarantine's advertised release signal is
 * UNREACHABLE for anything actually quarantined, and the mock used to hide that.
 *
 * `onContextLoss` is an Emitter owned by the real addon's own DisposableStore, and
 * xterm's `DisposableStore.clear()` empties the store in a `finally` — so it goes even
 * when a child throws. Since an addon only ever reaches the quarantine BY a dispose()
 * that threw, its emitter is already torn down by then.
 *
 * The mock now models that teardown. These tests pin the real contract so nobody
 * re-adds a recovery claim the dependency cannot honour.
 */
describe('quarantine is permanent, because the release signal is already gone (rev 15)', () => {
  it('a disposed addon can no longer deliver a context loss', () => {
    const addon = new (WebglAddon as unknown as new () => {
      onContextLoss(cb: () => void): void;
      dispose(): void;
      fireContextLoss(): void;
    })();
    let fired = 0;
    addon.onContextLoss(() => { fired += 1; });

    addon.fireContextLoss();
    expect(fired).toBe(1);          // healthy addon: the handler works

    addon.dispose();
    addon.fireContextLoss();
    expect(fired).toBe(1);          // …and after dispose it is gone, not merely idle
  });

  it('a quarantined addon stays counted forever', () => {
    // The production shape: dispose() throws, so the addon is quarantined — and that
    // very dispose() is what removed its ability to ever report a context loss.
    const wedged = { dispose() { throw new Error('test: driver refused'); } };
    quarantineWebGLAddon(wedged);
    expect(countActiveWebGLAddons()).toBe(1);

    // There is no drain, no retry, and no signal it can still emit. It is charged to
    // the budget for the life of the renderer. That is the SAFE direction: a wedged
    // context holds a slot rather than being handed out a second time.
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);
  });
});
