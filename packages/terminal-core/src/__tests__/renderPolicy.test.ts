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
import { terminalCache, resetTerminalRendering } from '../cache';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';

/** The jsdom WebglAddon mock (src/__mocks__/addon-webgl.ts) adds two statics the real
 *  addon has no equivalent of: a one-shot construction-failure switch and the last
 *  onContextLoss callback loadWebGLAddon registered. */
const MockWebgl = WebglAddon as unknown as {
  failNextConstruction: boolean;
  lastContextLossHandler: (() => void) | null;
};

/** The jsdom FitAddon mock (src/__mocks__/addon-fit.ts) exposes a fitCount the real
 *  addon does not; existing tests reach it via `as any` (engine.relocate-eligibility
 *  .test.ts:81) and this narrows that to the one field we assert on. */
type CountingFit = FitAddon & { fitCount: number };

function makeEntry(key: string, opts: { parent?: boolean; box?: boolean } = {}) {
  const term = new Terminal();
  const fitAddon = new FitAddon() as CountingFit;
  term.loadAddon(fitAddon as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  term.open(host);
  if (opts.parent === false) term.element!.remove();
  // jsdom reports 0 for every box; opt IN to a real one so the default is
  // the dangerous case rather than the safe one.
  const w = opts.box === false ? 0 : 800;
  const h = opts.box === false ? 0 : 600;
  Object.defineProperty(term.element!, 'offsetWidth', { value: w, configurable: true });
  Object.defineProperty(term.element!, 'offsetHeight', { value: h, configurable: true });
  const entry = { terminal: term, fitAddon, webglAddon: null, useWebGL: false } as never;
  terminalCache.set(key, entry);
  return { term, fitAddon, entry: terminalCache.get(key)! };
}

afterEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
  MockWebgl.failNextConstruction = false;
  MockWebgl.lastContextLossHandler = null;
  // Test HYGIENE only — it keeps a leaked budget from poisoning the next test. It
  // is NOT the BUDGET-OWNER invariant (§5.2 note (c)), which is about production
  // teardown and gets its own test and release mechanism in Task 9.
  setCanvasWebGLBudget(null);
});

describe('design/013 §5.3 LB — never fit a terminal with no layout box', () => {
  it('is false when term.element has no parentElement', () => {
    const { term } = makeEntry('lb-noparent', { parent: false });
    expect(hasLayoutBox(term)).toBe(false);
  });

  it('is false when the element has a parent but zero box (display:none ancestor)', () => {
    const { term } = makeEntry('lb-nobox', { box: false });
    expect(hasLayoutBox(term)).toBe(false);
  });

  it('is true for a normally laid-out terminal', () => {
    const { term } = makeEntry('lb-ok');
    expect(hasLayoutBox(term)).toBe(true);
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

  // Re-arming after a teardown must still work, and must not stack a second
  // listener per arm — a leak that grows with every canvas entry.
  it('re-arms cleanly after a teardown release', () => {
    setCanvasWebGLBudget(3);
    window.dispatchEvent(new Event('pagehide'));
    setCanvasWebGLBudget(5);
    expect(getCanvasWebGLBudget()).toBe(5);
    window.dispatchEvent(new Event('pagehide'));
    expect(getCanvasWebGLBudget()).toBeNull();
  });
});
