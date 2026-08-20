import {
  MAX_WEBGL_PER_RENDERER,
  webglAllowedAtCreation,
  setCanvasWebGLBudget,
  releaseCanvasWebGLBudget,
  countActiveWebGLAddons,
  setTerminalRenderPolicy,
  getTerminalRenderPolicy,
} from '../renderPolicy';
import { terminalCache } from '../cache';

/**
 * The browser force-loses the OLDEST WebGL context when a renderer goes past its ceiling,
 * and `getContext` never reports it — measured: a page allocated 20 and 16 survived. So the
 * overrun is silent, and its victim is whichever terminal has been open longest, which is
 * the one the user is most likely to care about.
 *
 * Before this gate, `webglAllowedAtCreation()` returned `true` unconditionally whenever no
 * canvas session was armed — i.e. on every ordinary launch — so a window with enough tabs
 * walked straight past the ceiling.
 *
 * SCOPE (retraction, worth keeping): this ceiling is **per renderer process**, not global.
 * A page in a separate renderer allocated its own 20 and took nothing from the first. An
 * earlier revision coordinated a budget across windows via localStorage on the strength of
 * a measurement whose two pages shared one renderer process; that only ever demonstrated
 * the per-process cap. Being wrong in that direction is expensive — every terminal past the
 * shared limit paints on the DOM renderer, at ~2.3x the CPU per repaint.
 */

/**
 * A cache entry that counts towards the budget: `countActiveWebGLAddons` keys on `webglAddon`.
 *
 * `terminal.element` is not decoration. Demotion runs `resetTerminalRendering` ->
 * `fitIfLaidOut`, which reads `entry.terminal.element?.parentElement`; an entry without it
 * throws a TypeError that looks like a product bug rather than a fixture gap. `null` is the
 * honest value here — these terminals were never opened — and it makes `hasLayoutBox` return
 * false, so no fit is attempted and no `fitAddon` is needed either.
 */
function fakeEntry(id: string, withContext: boolean) {
  terminalCache.set(id, {
    webglAddon: withContext ? { dispose() {} } : null,
    useWebGL: withContext,
    terminal: { element: null },
  } as unknown as Parameters<typeof terminalCache.set>[1]);
}

const fakeEntryWithContext = (id: string) => fakeEntry(id, true);
const fakeEntryOnDom = (id: string) => fakeEntry(id, false);

afterEach(() => {
  terminalCache.clear();
  releaseCanvasWebGLBudget();
});

describe('the per-renderer WebGL ceiling', () => {
  // Not a tautology despite testing only a constant: it pins the constant to the MEASURED
  // browser cap, and raising it to 16+ — the obvious "we have headroom" edit — is exactly
  // the change that reintroduces silent eviction. This is the only place that relationship
  // is written down as an executable claim rather than a comment.
  it('stays below the browser\'s measured cap of 16, keeping a reserve', () => {
    const BROWSER_CAP = 16; // measured: a page allocated 20 contexts and 16 survived
    expect(MAX_WEBGL_PER_RENDERER).toBeLessThan(BROWSER_CAP);
    expect(MAX_WEBGL_PER_RENDERER).toBeGreaterThan(0);
  });

  it('allows creation while under the ceiling', () => {
    for (let i = 0; i < MAX_WEBGL_PER_RENDERER - 1; i++) fakeEntryWithContext(`t${i}`);
    expect(countActiveWebGLAddons()).toBe(MAX_WEBGL_PER_RENDERER - 1);
    expect(webglAllowedAtCreation()).toBe(true);
  });

  // The case the old code got wrong: no canvas budget armed is EVERY ordinary launch, and
  // it used to mean "yes" forever.
  it('refuses creation at the ceiling even with no canvas session armed', () => {
    for (let i = 0; i < MAX_WEBGL_PER_RENDERER; i++) fakeEntryWithContext(`t${i}`);
    expect(webglAllowedAtCreation()).toBe(false);
  });

  it('still refuses past the ceiling', () => {
    for (let i = 0; i < MAX_WEBGL_PER_RENDERER + 5; i++) fakeEntryWithContext(`t${i}`);
    expect(webglAllowedAtCreation()).toBe(false);
  });

  // Canvas's own budget is TIGHTER than the ceiling, so it must keep biting first;
  // the ceiling is a backstop, not a replacement for it.
  it('lets a smaller canvas budget bind before the ceiling does', () => {
    setCanvasWebGLBudget(3);
    for (let i = 0; i < 3; i++) fakeEntryWithContext(`t${i}`);
    expect(countActiveWebGLAddons()).toBeLessThan(MAX_WEBGL_PER_RENDERER);
    expect(webglAllowedAtCreation()).toBe(false);
  });

  it('a canvas budget cannot raise the ceiling above the browser cap', () => {
    setCanvasWebGLBudget(999);
    for (let i = 0; i < MAX_WEBGL_PER_RENDERER; i++) fakeEntryWithContext(`t${i}`);
    expect(webglAllowedAtCreation()).toBe(false);
  });
});

/**
 * The PROMOTION path, which is a second entry point and was previously untested.
 *
 * Creation and promotion are different doors to the same resource: `webglAllowedAtCreation`
 * guards `mount()`, while `setTerminalRenderPolicy(id, 'webgl')` is what the canvas
 * reconciler, the diagnostics toggle and `restoreRenderPolicies` all call. Gating only the
 * first would let a canvas session walk past the ceiling one promotion at a time.
 */
describe('the ceiling also gates promotion, not just creation', () => {
  it('refuses to promote once the renderer is at the ceiling', () => {
    for (let i = 0; i < MAX_WEBGL_PER_RENDERER; i++) fakeEntryWithContext(`held${i}`);
    // A terminal that exists and is currently on the DOM renderer.
    terminalCache.set('victim', {
      webglAddon: null,
      useWebGL: false,
      terminal: { element: null },
    } as unknown as Parameters<typeof terminalCache.set>[1]);

    expect(setTerminalRenderPolicy('victim', 'webgl')).toBe('dom');
    // And it must not have been left believing it holds a context.
    expect(getTerminalRenderPolicy('victim')).toBe('dom');
    expect(countActiveWebGLAddons()).toBe(MAX_WEBGL_PER_RENDERER);
  });

  /**
   * Returning 'dom' is what the reconciler reads as a FAILED PROMOTION (D3 / CALLER-DROP),
   * which is how a refused id gets suppressed instead of re-requested every pass. A refusal
   * that threw, or that reported 'webgl', would either break the pass or spin it forever.
   */
  it('reports the refusal as an achieved policy rather than throwing', () => {
    for (let i = 0; i < MAX_WEBGL_PER_RENDERER + 3; i++) fakeEntryWithContext(`held${i}`);
    terminalCache.set('victim', {
      webglAddon: null,
      useWebGL: false,
      terminal: { element: null },
    } as unknown as Parameters<typeof terminalCache.set>[1]);

    expect(() => setTerminalRenderPolicy('victim', 'webgl')).not.toThrow();
    expect(setTerminalRenderPolicy('victim', 'webgl')).toBe('dom');
  });

  // Demotion must stay possible at the ceiling — otherwise nothing could ever free a slot
  // and the renderer would be wedged at the limit for the rest of the session.
  it('still allows demotion while at the ceiling', () => {
    for (let i = 0; i < MAX_WEBGL_PER_RENDERER; i++) fakeEntryWithContext(`held${i}`);
    expect(setTerminalRenderPolicy('held0', 'dom')).toBe('dom');
  });
});
