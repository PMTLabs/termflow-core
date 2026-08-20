import {
  MAX_WEBGL_PER_RENDERER,
  webglAllowedAtCreation,
  setCanvasWebGLBudget,
  releaseCanvasWebGLBudget,
  countActiveWebGLAddons,
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

/** A cache entry that counts towards the budget: `countActiveWebGLAddons` keys on `webglAddon`. */
function fakeEntryWithContext(id: string) {
  terminalCache.set(id, {
    webglAddon: { dispose() {} },
    useWebGL: true,
  } as unknown as Parameters<typeof terminalCache.set>[1]);
}

afterEach(() => {
  terminalCache.clear();
  releaseCanvasWebGLBudget();
});

describe('the per-renderer WebGL ceiling', () => {
  it('sits below the browser\'s measured cap of 16, leaving a reserve', () => {
    expect(MAX_WEBGL_PER_RENDERER).toBeLessThan(16);
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
