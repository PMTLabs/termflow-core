/** @jest-environment jsdom */
import fs from 'fs';
import path from 'path';
import { FitAddon } from '@xterm/addon-fit';

// `terminalCache` really is a bare `Map<string, TerminalCacheEntry>` (cache.ts:142), so a Map
// here is the faithful double rather than a convenient one — nothing about the real export has
// behaviour this could fail to reproduce.
const fakeCache = new Map<string, any>();
jest.mock('@termflow/terminal-core', () => ({ terminalCache: fakeCache }));

// eslint-disable-next-line import/first
import { measureHostBox, clearHostBoxes, _hostBoxCount } from '../canvasHostBoxes';

const FALLBACK = { w: 1600, h: 680 };

/** A terminal sitting in a pane, shaped exactly as `measureHostBox` reads it. */
function seed(id: string, rect: { width: number; height: number }, opts: { inCanvas?: boolean } = {}) {
  const parent = document.createElement('div');
  parent.className = 'terminal-display';
  if (opts.inCanvas) {
    const surface = document.createElement('div');
    surface.className = 'canvas-surface';
    surface.appendChild(parent);
    document.body.appendChild(surface);
  } else {
    document.body.appendChild(parent);
  }
  const element = document.createElement('div');
  parent.appendChild(element);
  parent.getBoundingClientRect = () => ({ ...rect, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }) as DOMRect;
  fakeCache.set(id, { terminal: { element } });
  return { parent, element };
}

beforeEach(() => {
  fakeCache.clear();
  clearHostBoxes();
  document.body.innerHTML = '';
});

describe('measureHostBox', () => {
  it('copies the pane box exactly, fractions included', () => {
    seed('t1', { width: 1234.53125, height: 617.09375 });
    // NOT rounded. `proposeDimensions` floors `availableWidth / cell.width`, so a value nudged
    // to the wrong side of a cell boundary changes the column count by one — which is a resize,
    // which is the entire thing this module exists to avoid.
    expect(measureHostBox('t1', FALLBACK)).toEqual({ w: 1234.53125, h: 617.09375 });
  });

  it('falls back when the terminal has never been rendered', () => {
    // A tab restored but never shown: no cache entry at all.
    expect(measureHostBox('ghost', FALLBACK)).toEqual(FALLBACK);
    expect(_hostBoxCount()).toBe(0);          // and nothing is frozen from it
  });

  it('falls back when the pane has no layout, without freezing the zero', () => {
    seed('t1', { width: 0, height: 0 });
    expect(measureHostBox('t1', FALLBACK)).toEqual(FALLBACK);
    // The freeze is the dangerous half: a stored 0 would size the host at 0 for the whole
    // session and the terminal would be fitted to FitAddon's 2-column minimum.
    expect(_hostBoxCount()).toBe(0);
  });

  it('refuses to measure a container of its own making', () => {
    // After relocation `term.element.parentElement` IS the canvas host. Measuring it would be
    // measuring the number we wrote, which reads as correct forever and then drifts.
    seed('t1', { width: 900, height: 400 }, { inCanvas: true });
    expect(measureHostBox('t1', FALLBACK)).toEqual(FALLBACK);
    expect(_hostBoxCount()).toBe(0);
  });

  it('is frozen for the session — a later pane resize does not move it (RC2)', () => {
    const { parent } = seed('t1', { width: 1000, height: 500 });
    expect(measureHostBox('t1', FALLBACK)).toEqual({ w: 1000, h: 500 });
    parent.getBoundingClientRect = () => ({ width: 1800, height: 900 }) as DOMRect;
    // Re-measuring mid-session is exactly the resize `plan/017` removes: the terminal keeps the
    // grid it had and picks the new one up on the return trip, where the fit is a real fit.
    expect(measureHostBox('t1', FALLBACK)).toEqual({ w: 1000, h: 500 });
  });

  it('keeps a separate box per terminal', () => {
    seed('a', { width: 2530, height: 1250 });     // an unsplit tab
    seed('b', { width: 1260, height: 620 });      // a quarter split
    expect(measureHostBox('a', FALLBACK).w).toBe(2530);
    expect(measureHostBox('b', FALLBACK).w).toBe(1260);
    expect(_hostBoxCount()).toBe(2);
  });

  it('clearHostBoxes drops the session', () => {
    seed('t1', { width: 1000, height: 500 });
    measureHostBox('t1', FALLBACK);
    clearHostBoxes();
    expect(_hostBoxCount()).toBe(0);
  });
});

/**
 * The acceptance test for `plan/017`, run against the REAL `FitAddon`.
 *
 * The whole plan rests on one claim: move a terminal between two containers whose computed box
 * is identical and `fit()` finds the same cols/rows, so it takes its early return and never
 * calls `terminal.resize()` — no SIGWINCH, no TUI repaint, no duplicated content.
 *
 * That claim is about xterm's arithmetic, not ours, so the test uses xterm's own addon and
 * asserts on `resize` being CALLED rather than on the grid that ends up stored. A final-state
 * assertion would pass on a resize that was sent and then reverted, and the SIGWINCH is sent
 * either way — see [[assert-the-maximum-not-the-final-value]].
 */
describe('a host that matches the pane makes the relocation fit a no-op', () => {
  const CELL_W = 8.6015625;
  const CELL_H = 17;

  /** jsdom does no layout, so `getComputedStyle().width` returns whatever is set inline. In a
   *  browser that value is the CONTENT box; the CSS derivation test below is what proves the
   *  canvas replica lands on the same content box as the pane. */
  function container(contentW: number, contentH: number) {
    const el = document.createElement('div');
    el.style.width = `${contentW}px`;
    el.style.height = `${contentH}px`;
    document.body.appendChild(el);
    return el;
  }

  function terminalIn(parent: HTMLElement, cols: number, rows: number) {
    const element = document.createElement('div');
    element.style.padding = '0px';
    parent.appendChild(element);
    return {
      element,
      cols,
      rows,
      options: { scrollback: 1000 },
      resize: jest.fn(),
      _core: { _renderService: { dimensions: { css: { cell: { width: CELL_W, height: CELL_H } } }, clear: jest.fn() } },
    } as any;
  }

  /** Move the element to `to` and fit, exactly as R6 then the observer/settle fit do. */
  function relocateAndFit(term: any, to: HTMLElement) {
    const fit = new FitAddon();
    fit.activate(term);
    const before = fit.proposeDimensions()!;
    to.appendChild(term.element);
    const after = fit.proposeDimensions()!;
    fit.fit();
    return { before, after, resized: term.resize.mock.calls.length };
  }

  it('does not resize when the canvas host is a replica of the pane', () => {
    const paneContent = { w: 1226.53125, h: 609.09375 };
    const pane = container(paneContent.w, paneContent.h);
    const term = terminalIn(pane, 142, 35);
    // Seed the terminal's real grid from the pane it is in, the way a mounted terminal's is.
    const seeded = new FitAddon();
    seeded.activate(term);
    Object.assign(term, seeded.proposeDimensions());

    const canvasHost = container(paneContent.w, paneContent.h);   // the replica
    const r = relocateAndFit(term, canvasHost);

    expect(r.after).toEqual(r.before);
    expect(r.resized).toBe(0);                 // <- the claim: no resize, so no SIGWINCH
  });

  // The positive case's mirror. Without it the test above passes on a `fit()` that is broken
  // outright and resizes nothing ever — see [[test-arrange-right-assert-blind]].
  it('DOES resize when the host is the old session-wide box — the bug being fixed', () => {
    const pane = container(1226.53125, 609.09375);
    const term = terminalIn(pane, 142, 35);
    const seeded = new FitAddon();
    seeded.activate(term);
    Object.assign(term, seeded.proposeDimensions());

    const sessionBox = container(2400, 1021);   // what every node used to get
    const r = relocateAndFit(term, sessionBox);

    expect(r.after).not.toEqual(r.before);
    expect(r.resized).toBe(1);
  });

  it('a one-pixel error in the replica is enough to move a column', () => {
    // Why `measureHostBox` must not round. 1226.53 / 8.6015625 lands mid-cell; the nearest
    // boundary is under a pixel away, so a rounded box crosses it.
    const pane = container(1229.0, 609.0);
    const term = terminalIn(pane, 142, 35);
    const seeded = new FitAddon();
    seeded.activate(term);
    Object.assign(term, seeded.proposeDimensions());

    const offByOne = container(1220.0, 609.0);
    expect(relocateAndFit(term, offByOne).resized).toBe(1);
  });
});

/**
 * The CSS half of the same claim, derived from the real stylesheets.
 *
 * `proposeDimensions` reads `getComputedStyle(parent).width`, which under `box-sizing: border-box`
 * is the CONTENT box. `measureHostBox` captures the pane's BORDER box. Those are different
 * numbers, and the only reason the two agree is this chain:
 *
 *   .canvas-surface        width = --node-host-w  (the pane's border box), NO padding, NO border
 *   > .terminal-display    width = 100%           -> border box = the pane's border box
 *                          box-sizing: border-box -> content box = border box - its own padding
 *   pane .terminal-display same class             -> same padding -> same content box
 *
 * Give `.canvas-surface` a border or a padding and every canvas terminal silently shifts by a
 * column. None of that is executable, so it is derived from the files rather than trusted.
 */
describe('the CSS chain that makes the replica exact', () => {
  const read = (p: string) =>
    fs.readFileSync(path.resolve(__dirname, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const CANVAS = read('../Canvas.css');
  const DISPLAY = read('../../Terminal/TerminalDisplay.css');

  /** The declaration block of a rule, looked up by exact selector. Split-based rather than a
   *  built regex: a mis-escaped dynamic pattern matches nothing and the assertion around it
   *  passes while checking nothing, which has happened three times in this suite's siblings. */
  const rule = (css: string, selector: string): string => {
    for (const chunk of css.split('}')) {
      const i = chunk.indexOf('{');
      if (i < 0) continue;
      const sels = chunk.slice(0, i).split(',').map((s) => s.trim());
      if (sels.includes(selector)) return chunk.slice(i + 1);
    }
    throw new Error(`no rule for \`${selector}\` — it was renamed or removed`);
  };

  const decl = (block: string, prop: string): string | null => {
    for (const d of block.split(';')) {
      const [name, ...rest] = d.split(':');
      if (name.trim() === prop) return rest.join(':').trim();
    }
    return null;
  };

  it('sizes the host from the PER-NODE box, not the session one', () => {
    const surface = rule(CANVAS, '.canvas-surface');
    // The session box survives only as the fallback arm. A bare `var(--canvas-host-w)` here is
    // the pre-017 behaviour and would re-fit every terminal on entry.
    expect(decl(surface, 'width')).toBe('var(--node-host-w, var(--canvas-host-w))');
    expect(decl(surface, 'height')).toBe('var(--node-host-h, var(--canvas-host-h))');
  });

  it('gives the host no box of its own to add', () => {
    const surface = rule(CANVAS, '.canvas-surface');
    // Either one would make the child's border box smaller than the pane's by exactly that
    // amount, and the column count would follow.
    expect(decl(surface, 'padding')).toBeNull();
    expect(decl(surface, 'border')).toBeNull();
    expect(decl(surface, 'border-width')).toBeNull();
  });

  it('fills the host with the terminal display, edge to edge', () => {
    const inner = rule(CANVAS, '.canvas-surface > .terminal-display');
    expect(decl(inner, 'width')).toBe('100%');
    expect(decl(inner, 'height')).toBe('100%');
  });

  it('keeps .terminal-display on border-box, which is what makes the two agree', () => {
    // If this ever became content-box, `width: 100%` would mean 100% PLUS the padding and the
    // canvas terminal would be 8px wider than its pane.
    expect(decl(rule(DISPLAY, '.terminal-display'), 'box-sizing')).toBe('border-box');
  });
});

/**
 * `CanvasMode`'s wiring, derived from its source.
 *
 * It is the last link in the chain and the only one with no runtime coverage: mounting it needs
 * the Redux store, two untransformed CSS imports, `@tauri-apps/api/event` and a real
 * `Terminal.open()` against a canvas 2D context jsdom does not have — the same reason
 * `useSurfaceRelocation` was extracted from `TerminalDisplay`.
 *
 * Every other piece can be perfect and the fix still inert if this one stops passing the box
 * down, so the check is derived from the file rather than assumed. Substring matching, not a
 * built regex: a mis-escaped dynamic pattern matches nothing and passes while checking nothing.
 */
describe('CanvasMode passes each node its own box', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../CanvasMode.tsx'), 'utf8');

  it('measures a box per node', () => {
    expect(SRC).toContain('measureHostBox(n.terminalId');
  });

  it('hands it to the node that owns it', () => {
    // Without this line every node takes `.canvas-surface`'s `var(--canvas-host-w)` fallback
    // arm and the pre-017 re-fit is back, silently.
    expect(SRC).toContain('hostBox={hostBoxes[n.terminalId]}');
  });

  it('sizes the overlay from the overlaid terminal, not the session', () => {
    // Decision C. `overlayGeometry(vp, size.w, size.h, metrics)` is the pre-017 call and would
    // put every overlay back at the one session size regardless of the pane it came from.
    expect(SRC).not.toContain('overlayGeometry(vp, size.w, size.h, metrics)');
    expect(SRC).toContain('hostW: b.w, hostH: b.h');
  });

  it('drops the frozen boxes when the session ends', () => {
    // They are module-level, so without this they outlive the canvas and the next session
    // reuses boxes measured against a window size, split layout and font that may have changed.
    expect(SRC).toContain('clearHostBoxes()');
  });
});
