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
} from '../renderPolicy';
import { terminalCache } from '../cache';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

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
