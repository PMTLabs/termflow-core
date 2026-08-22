/**
 * @jest-environment jsdom
 */
// Same idiom as the other StateManager suites: importing the module pulls in
// TerminalContainer → PaneManager → SplitPane → a `.css` import, which this Jest config has
// no transform for.
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));

import { sanitizeCanvasState, restoreZMax } from '../StateManager';
import { Z_MIN, canvasMetrics } from '../../components/Canvas/canvasGeometry';
import {
  SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_ZOOM_MIN, SIDEBAR_ZOOM_MAX,
} from '../../store/slices/canvasSlice';

const rect = { x: 1, y: 2, w: 340, h: 210 };

/**
 * The zoom ceiling is per-display, not a constant.
 *
 * `plan/013` Task 22's tests referenced a `Z_MAX` symbol and called `clampZoom(z)` with one
 * argument. Neither exists any more: the ceiling became display-derived when the host box
 * started being sized for the display, and `clampZoom` made `zMax` REQUIRED specifically so
 * that every call site has to say which display it means. So the tests below derive the
 * ceiling the same way production does rather than naming a number.
 */
const Z_MAX = canvasMetrics(1920, 1040).zMax;
const sanitize = (canvas: unknown, terminals: string[] = [], tabs: string[] = []) =>
  sanitizeCanvasState(canvas, terminals, tabs, Z_MAX);

describe('sanitizeCanvasState', () => {
  it('returns undefined for absent or malformed input', () => {
    expect(sanitize(undefined)).toBeUndefined();
    expect(sanitize(null)).toBeUndefined();
    expect(sanitize('nonsense')).toBeUndefined();
    expect(sanitize(42)).toBeUndefined();
  });

  it('drops geometry for terminals that did not survive restore', () => {
    const out = sanitize(
      { viewport: { x: 0, y: 0, z: 1 }, nodes: { 'tm-live': rect, 'tm-dead': rect }, groups: {} },
      ['tm-live'],
    )!;
    expect(Object.keys(out.nodes)).toEqual(['tm-live']);
  });

  it('drops geometry for tabs that did not survive restore', () => {
    const out = sanitize(
      { viewport: { x: 0, y: 0, z: 1 }, nodes: {}, groups: { 'tb-live': rect, 'tb-dead': rect } },
      [], ['tb-live'],
    )!;
    expect(Object.keys(out.groups)).toEqual(['tb-live']);
  });

  it('keeps a root pane whose leaf id IS its tab id, in both maps', () => {
    // The overlap the two arrays are warned about. A tab's first pane uses the tab's own id as
    // its leaf (design 011 D7), so `tb-alpha` is legitimately both a node key and a group key.
    // Deriving one list from the other drops one of these two entries — and which one it drops
    // depends on which direction you derived, so the symptom is either a vanishing root pane
    // or a phantom frame.
    const out = sanitize(
      { viewport: { x: 0, y: 0, z: 1 }, nodes: { 'tb-alpha': rect }, groups: { 'tb-alpha': rect } },
      ['tb-alpha'], ['tb-alpha'],
    )!;
    expect(out.nodes['tb-alpha']).toEqual(rect);
    expect(out.groups['tb-alpha']).toEqual(rect);
  });

  it('repairs a corrupt viewport instead of restoring an unusable one', () => {
    const out = sanitize({ viewport: { x: NaN, y: 0, z: 0 }, nodes: {}, groups: {} })!;
    expect(Number.isFinite(out.viewport.x)).toBe(true);
    expect(out.viewport.z).toBeGreaterThanOrEqual(Z_MIN);
  });

  it('clamps a persisted zoom outside the legal range', () => {
    expect(sanitize({ viewport: { x: 0, y: 0, z: 9999 }, nodes: {}, groups: {} })!.viewport.z).toBe(Z_MAX);
    expect(sanitize({ viewport: { x: 0, y: 0, z: 0.0001 }, nodes: {}, groups: {} })!.viewport.z).toBe(Z_MIN);
  });

  it('clamps to the ceiling it was GIVEN, not to a built-in one', () => {
    // The reason `zMax` is a parameter. A build that quietly used some other display's
    // ceiling would show up as a canvas that stops zooming early on a 4K panel — which reads
    // as a preference rather than a bug, and so never gets reported.
    const small = sanitizeCanvasState({ viewport: { x: 0, y: 0, z: 99 }, nodes: {}, groups: {} }, [], [], 1.5)!;
    const large = sanitizeCanvasState({ viewport: { x: 0, y: 0, z: 99 }, nodes: {}, groups: {} }, [], [], 2.8)!;
    expect(small.viewport.z).toBe(1.5);
    expect(large.viewport.z).toBe(2.8);
  });

  it('rejects a rect with zero or negative dimensions', () => {
    const out = sanitize(
      { viewport: { x: 0, y: 0, z: 1 }, nodes: { 'tm-1': { x: 0, y: 0, w: 0, h: 210 } }, groups: {} },
      ['tm-1'],
    )!;
    expect(out.nodes['tm-1']).toBeUndefined();
  });

  it('rejects rects with non-finite fields', () => {
    const out = sanitize(
      { viewport: { x: 0, y: 0, z: 1 }, nodes: { 'tm-1': { x: NaN, y: 0, w: 340, h: 210 } }, groups: {} },
      ['tm-1'],
    )!;
    expect(out.nodes['tm-1']).toBeUndefined();
  });

  it('rejects a rect placed absurdly far from the origin', () => {
    const out = sanitize(
      { viewport: { x: 0, y: 0, z: 1 }, nodes: { 'tm-1': { x: 1e9, y: 0, w: 340, h: 210 } }, groups: {} },
      ['tm-1'],
    )!;
    expect(out.nodes['tm-1']).toBeUndefined();
  });

  it('clamps a persisted sidebar width into range', () => {
    expect(sanitize({ viewport: { x: 0, y: 0, z: 1 }, nodes: {}, groups: {}, sidebarWidth: 9999 })!.sidebarWidth)
      .toBe(SIDEBAR_MAX);
    expect(sanitize({ viewport: { x: 0, y: 0, z: 1 }, nodes: {}, groups: {}, sidebarWidth: 2 })!.sidebarWidth)
      .toBe(SIDEBAR_MIN);
  });

  /**
   * The sidebar's Ctrl+wheel zoom (Tam, 2026-08-21) — the READ half of its persistence.
   *
   * Worth its own case rather than folding into the width one above: a value that is written on
   * save and never read back looks exactly like a working feature until the app is restarted,
   * which is the one thing nobody does while testing the gesture.
   */
  it('carries a persisted sidebar zoom back, clamped into range', () => {
    const base = { viewport: { x: 0, y: 0, z: 1 }, nodes: {}, groups: {} };
    expect(sanitize({ ...base, sidebarZoom: 1.25 })!.sidebarZoom).toBeCloseTo(1.25, 9);
    expect(sanitize({ ...base, sidebarZoom: 99 })!.sidebarZoom).toBe(SIDEBAR_ZOOM_MAX);
    expect(sanitize({ ...base, sidebarZoom: 0.01 })!.sidebarZoom).toBe(SIDEBAR_ZOOM_MIN);
  });

  /**
   * NaN survives a bare `Math.max(min, Math.min(max, v))` — every comparison with NaN is false,
   * so the clamp that looks like it bounds the value does not. A NaN reaching the stylesheet
   * makes `calc(12px * var(--sidebar-k))` invalid, CSS drops the declaration, and the panel
   * renders at its inherited size: the zoom simply appears to have stopped working.
   */
  it.each([NaN, Infinity, -Infinity, 'big', null])('refuses a non-finite sidebar zoom (%p)', (bad) => {
    const out = sanitize({ viewport: { x: 0, y: 0, z: 1 }, nodes: {}, groups: {}, sidebarZoom: bad })!;
    expect(Number.isFinite(out.sidebarZoom)).toBe(true);
    expect(out.sidebarZoom).toBe(1);
  });

  it('never carries `enabled` through, so the app always boots in tab mode', () => {
    // Canvas Mode is a TAB, so "is the canvas showing" is a fact of `tabs`. A persisted copy
    // would be a second source of truth that desyncs on every path that switches tabs without
    // going through the canvas helpers.
    const out = sanitize(
      { viewport: { x: 0, y: 0, z: 1 }, nodes: {}, groups: {}, enabled: true },
    )!;
    expect((out as any).enabled).toBeUndefined();
  });

  it('never carries a focused terminal through', () => {
    // The app must not boot with a terminal silently holding the keyboard, on a canvas the
    // user has not even opened.
    const out = sanitize(
      { viewport: { x: 0, y: 0, z: 1 }, nodes: {}, groups: {}, focusedId: 'tm-1', overlayId: 'tm-1' },
    )!;
    expect((out as any).focusedId).toBeUndefined();
    expect((out as any).overlayId).toBeUndefined();
  });

  it('survives a blob written before canvas geometry existed', () => {
    // Every field optional: state saved by an earlier build has no canvas key at all, and a
    // partial one must still load rather than throwing during restore.
    const out = sanitize({})!;
    expect(out.viewport).toEqual({ x: 0, y: 0, z: 1 });
    expect(out.nodes).toEqual({});
    expect(out.groups).toEqual({});
    expect(out.sidebarOpen).toBe(true);
    // Added after the field existed, so a blob written before it must still restore at natural
    // size rather than at 0 — which would render the panel as an invisible sliver.
    expect(out.sidebarZoom).toBe(1);
  });
});

/**
 * The WRITE half, which had no coverage at all — and is the link a new field is most often
 * dropped from.
 *
 * `sanitizeCanvasState` above is the reader. `StateManager.saveState` is the writer, and it
 * builds its `canvas:` blob as a hand-written object literal naming each field. Add a field to
 * `CanvasPersisted`, wire the reducer, wire the hydrate, wire the consumer, forget this one
 * literal, and the feature works perfectly for the whole session and is gone after a restart —
 * with a green suite, because every other link is genuinely correct.
 *
 * So the expected list is DERIVED from the interface rather than restated here. A list typed out
 * by hand would need updating by exactly the person who just forgot to update the writer.
 */
describe('saveState writes every persisted canvas field', () => {
  const read = (rel: string) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    require('fs').readFileSync(require('path').resolve(__dirname, rel), 'utf-8');

  /** The field names declared by `CanvasPersisted`, straight out of the slice. */
  const persistedFields = (): string[] => {
    const src = read('../../store/slices/canvasSlice.ts');
    const body = /export interface CanvasPersisted \{([\s\S]*?)\n\}/.exec(src);
    expect(body).not.toBeNull();
    return [...body![1].matchAll(/^\s*(\w+)\s*\??:/gm)].map((m) => m[1]);
  };

  /** The object literal `saveState` assigns to `canvas:`. */
  const writerLiteral = (): string => {
    const src = read('../StateManager.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const m = /\n\s*canvas: \{([\s\S]*?)\n\s*\},/.exec(src);
    expect(m).not.toBeNull();
    return m![1];
  };

  it('names every CanvasPersisted field in the saved blob', () => {
    const missing = persistedFields().filter((f) => !new RegExp(`\\b${f}:`).test(writerLiteral()));
    expect(missing).toEqual([]);
  });

  // Guard on the guard: both parsers must actually find something. An interface rename or a
  // reshaped literal would otherwise leave this suite comparing two empty lists and passing.
  it('actually parsed both sides', () => {
    expect(persistedFields()).toEqual(
      expect.arrayContaining(['viewport', 'nodes', 'groups', 'sidebarOpen', 'sidebarWidth', 'sidebarZoom']),
    );
    expect(writerLiteral()).toContain('state.canvas.');
  });

  /**
   * The negative half. `edges` is deliberately NOT persisted — the backend owns the edge table
   * and the renderer refetches it on entering Canvas Mode — so it must be absent from BOTH the
   * interface and the writer. Without this, "write every field" could be satisfied by writing
   * the whole slice.
   */
  it('still refuses to persist the backend-owned fields', () => {
    expect(persistedFields()).not.toContain('edges');
    for (const f of ['edges', 'focusedId', 'overlayId', 'selectedId']) {
      expect(writerLiteral()).not.toMatch(new RegExp(`\\b${f}:`));
    }
  });
});

describe('restoreZMax', () => {
  it('derives the ceiling the same way CanvasMode freezes it for the session', () => {
    expect(restoreZMax()).toBe(canvasMetrics(window.innerWidth, window.innerHeight).zMax);
  });
});
