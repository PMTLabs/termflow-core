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
} from '../renderPolicy';
import { terminalCache, resetTerminalRendering, refreshGlyphAtlases } from '../cache';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { TerminalEngine } from '../TerminalEngine';
import type { TerminalBridge, Disposable } from '../types';

/** One mock instance. `disposed` does not exist on the real addon; it records that
 *  our dispose() was CALLED, which is all jsdom can show (§6.1 item 1). */
type MockWebglInstance = { disposed: boolean; dispose: () => void; clearTextureAtlas: () => void };

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
  it('reports webgl when the demotion disposal throws, and keeps the reference', () => {
    const { entry } = makeEntry('demote-fail');
    setTerminalRenderPolicy('demote-fail', 'webgl');
    const addon = asMock(entry.webglAddon);
    addon.dispose = () => {
      throw new Error('test: dispose failed before releasing the context');
    };

    expect(setTerminalRenderPolicy('demote-fail', 'dom')).toBe('webgl');
    expect(entry.webglAddon).toBe(addon);          // still countable
    expect(countActiveWebGLAddons()).toBe(1);
    expect(getTerminalRenderPolicy('demote-fail')).toBe('webgl');
  });

  it('resetTerminalRendering returns false when the disposal throws', () => {
    const { entry } = makeEntry('reset-fail');
    setTerminalRenderPolicy('reset-fail', 'webgl');
    asMock(entry.webglAddon).dispose = () => {
      throw new Error('test: dispose failed before releasing the context');
    };
    expect(resetTerminalRendering('reset-fail')).toBe(false);
    expect(entry.webglAddon).not.toBeNull();
  });

  // Review 120 HIGH (b) — promotion failing AFTER construction. The failNextConstruction
  // switch throws before an instance exists, so it cannot see this: here the addon is
  // built (and may already hold GPU resources) and then activation throws. Returning
  // null without disposing it leaks a live, unreachable context.
  it('disposes the constructed addon when activation throws after construction', () => {
    const { entry } = makeEntry('activate-fail');
    (entry.terminal as unknown as { loadAddon: (a: unknown) => void }).loadAddon = () => {
      throw new Error('test: activation failed');
    };

    expect(setTerminalRenderPolicy('activate-fail', 'webgl')).toBe('dom');
    expect(MockWebgl.instances).toHaveLength(1);   // it WAS constructed…
    expect(MockWebgl.instances[0].disposed).toBe(true); // …and must not survive
    const reachable = [...terminalCache.values()].filter((e) => e.webglAddon).length;
    const live = MockWebgl.instances.filter((a) => !a.disposed).length;
    expect(live).toBe(reachable);
    expect(countActiveWebGLAddons()).toBe(0);
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

    // The entry object itself survives — nothing was deleted and re-created, so the
    // scrollback and the addon are both still owned by the cache.
    expect(terminalCache.get('orphan-reattach-fail')).toBe(entryBefore);
    expect(terminalCache.get('orphan-reattach-fail')!.webglAddon).toBe(first);
    expect(first.disposed).toBe(false);
    // No second addon was constructed to replace it.
    expect(MockWebgl.instances).toHaveLength(1);
    // ORPHAN as the end-state property: live addons == addons reachable from the cache.
    const reachable = [...terminalCache.values()].filter((e) => e.webglAddon).length;
    const live = MockWebgl.instances.filter((a) => !a.disposed).length;
    expect(live).toBe(reachable);
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
