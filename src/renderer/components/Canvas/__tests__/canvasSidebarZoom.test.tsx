/**
 * @jest-environment jsdom
 *
 * Ctrl+wheel scales the canvas sidebar's own text (Tam, 2026-08-21).
 *
 * A setting is a chain, and every link in this one fails SILENTLY: a reducer nobody dispatches,
 * a value nobody persists, a persisted value nobody reads back, a variable no rule consumes.
 * Each is covered here or in `canvasSlice.test.ts` / `stateManager.test.ts`, because a green
 * suite that only exercises the reducer is exactly how a dead slider ships.
 *
 * The gesture half is the part with a real trap in it: React attaches wheel listeners at the
 * ROOT and PASSIVELY, so a handler bound with `onWheel` cannot `preventDefault()` and the
 * WebView applies its own page zoom on top of ours. Nothing in the JSX looks wrong when that
 * happens, so the listener's registration is asserted, not just its effect.
 */
jest.mock('../../../services/cwdSnapshot', () => ({ getAllCwdSnapshots: () => ({}) }));
jest.mock('../../../store', () => ({ get store() { return store; } }));
jest.mock('../../../services/StateManager', () => ({
  StateManager: { saveState: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../../services/TerminalService', () => ({
  terminalService: { getProcessIdForTerminal: (terminalId: string) => `proc-${terminalId}` },
}));

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore, EnhancedStore } from '@reduxjs/toolkit';
// eslint-disable-next-line import/first
import canvasReducer, {
  SIDEBAR_ZOOM_MIN, SIDEBAR_ZOOM_MAX, setSidebarZoom,
} from '../../../store/slices/canvasSlice';
import panesReducer from '../../../store/slices/panesSlice';
import tabsReducer from '../../../store/slices/tabsSlice';
import settingsReducer from '../../../store/slices/settingsSlice';
import { CanvasSidebar, SIDEBAR_ZOOM_STEP } from '../CanvasSidebar';
import { CanvasMetricsContext } from '../canvasMetricsContext';
import { DEFAULT_METRICS, NODE_W, NODE_H } from '../canvasGeometry';
import type { CanvasModel, CanvasNodeModel, CanvasGroupModel } from '../canvasSelectors';

const rect = { x: 0, y: 0, w: NODE_W, h: NODE_H };
const node = (terminalId: string, tabId: string, title: string): CanvasNodeModel => ({
  terminalId, tabId, paneId: `pn-${terminalId}`, title, shellType: 'zsh', rect,
  isRunning: false, hasUnseenOutput: false, groupTitle: 'Group', exited: false,
});
const group = (tabId: string, title: string, nodeIds: string[]): CanvasGroupModel =>
  ({ tabId, title, rect, nodeIds, anyRunning: false });

const model: CanvasModel = {
  nodes: [node('tm-1', 'tb-a', 'zsh'), node('tm-2', 'tb-a', 'server')],
  groups: [group('tb-a', 'api', ['tm-1', 'tm-2'])],
};

let container: HTMLDivElement;
let root: Root;
let store: EnhancedStore;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  store = configureStore({
    reducer: { canvas: canvasReducer, panes: panesReducer, tabs: tabsReducer, settings: settingsReducer },
    preloadedState: {
      panes: {
        paneTree: null, activePaneId: null, treesByTabId: {},
        activeTabId: 'tb-canvas', activePaneByTabId: {}, maximizedPaneByTabId: {},
      },
      tabs: {
        tabs: [{ id: 'tb-a', title: 'api', shellType: 'zsh', isActive: false }],
        activeTabId: 'tb-canvas',
      },
    } as never,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () => {
  act(() => {
    root.render(
      <Provider store={store}>
        <CanvasMetricsContext.Provider value={DEFAULT_METRICS}>
          <CanvasSidebar model={model} vw={900} vh={600} />
        </CanvasMetricsContext.Provider>
      </Provider>,
    );
  });
};

const panel = () => container.querySelector<HTMLElement>('.canvas-sidebar')!;
const zoom = () => (store.getState() as { canvas: { sidebarZoom: number } }).canvas.sidebarZoom;

/**
 * A real `WheelEvent` on the panel, with `cancelable` so `preventDefault()` is observable.
 *
 * jsdom does not implement `WheelEvent` deltas from the constructor in every version, so the
 * delta is assigned explicitly rather than trusted to the init dict.
 */
const wheel = (deltaY: number, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...mods });
  Object.defineProperty(e, 'deltaY', { value: deltaY });
  act(() => { panel().dispatchEvent(e); });
  return e;
};

describe('Ctrl+wheel zooms the sidebar', () => {
  it('starts at natural size', () => {
    render();
    expect(zoom()).toBe(1);
    expect(panel().style.getPropertyValue('--sidebar-k')).toBe('1');
  });

  it('scales up on wheel-up with the chord, and down on wheel-down', () => {
    render();
    wheel(-100, { ctrlKey: true });
    expect(zoom()).toBeCloseTo(SIDEBAR_ZOOM_STEP, 9);
    wheel(100, { ctrlKey: true });
    expect(zoom()).toBeCloseTo(1, 9);
  });

  it('accepts Cmd as well as Ctrl, for macOS', () => {
    render();
    wheel(-100, { metaKey: true });
    expect(zoom()).toBeCloseTo(SIDEBAR_ZOOM_STEP, 9);
  });

  /**
   * The negative that makes the chord mean something. A bare wheel over a list must SCROLL it —
   * a sidebar that zoomed on every wheel would be unusable the moment it had more rows than fit.
   */
  it('leaves a bare wheel alone', () => {
    render();
    const e = wheel(-100);
    expect(zoom()).toBe(1);
    expect(e.defaultPrevented).toBe(false);
  });

  /**
   * The WebView applies its own page zoom to Ctrl+wheel. Without `preventDefault` the whole app
   * scales alongside the sidebar — and this only works because the listener is registered
   * NON-PASSIVELY, which React's `onWheel` prop cannot do.
   */
  it('claims the chord so the WebView does not also page-zoom', () => {
    render();
    expect(wheel(-100, { ctrlKey: true }).defaultPrevented).toBe(true);
  });

  /**
   * Sign only, never magnitude. A trackpad reports fractional deltas in the hundreds where a
   * mouse reports 100 per notch; scaling BY the delta makes one gesture behave completely
   * differently on the two devices.
   */
  it('steps by the same amount whatever the device reports', () => {
    render();
    wheel(-3, { ctrlKey: true });
    const small = zoom();
    act(() => { store.dispatch(setSidebarZoom(1)); });
    wheel(-240, { ctrlKey: true });
    expect(zoom()).toBeCloseTo(small, 9);
  });

  it('publishes the factor as a custom property the stylesheet can read', () => {
    render();
    wheel(-100, { ctrlKey: true });
    expect(Number(panel().style.getPropertyValue('--sidebar-k'))).toBeCloseTo(SIDEBAR_ZOOM_STEP, 9);
  });

  /** Width is the user's own drag. A zoom that moved it would fight them. */
  it('does not touch the panel width', () => {
    render();
    const before = panel().style.width;
    wheel(-100, { ctrlKey: true });
    wheel(-100, { ctrlKey: true });
    expect(panel().style.width).toBe(before);
  });
});

describe('the zoom stays inside its range', () => {
  // Enough notches to overshoot either clamp several times over, so the test measures the CLAMP
  // rather than the step count.
  const SPINS = 40;

  it('cannot be zoomed past the ceiling', () => {
    render();
    for (let i = 0; i < SPINS; i += 1) wheel(-100, { ctrlKey: true });
    expect(zoom()).toBe(SIDEBAR_ZOOM_MAX);
  });

  it('cannot be zoomed past the floor', () => {
    render();
    for (let i = 0; i < SPINS; i += 1) wheel(100, { ctrlKey: true });
    expect(zoom()).toBe(SIDEBAR_ZOOM_MIN);
  });

  // Guard on the guard: a clamp that pinned everything to one value would satisfy both cases
  // above. The two ends must differ, and the range must be usable.
  it('and the two ends are actually different', () => {
    expect(SIDEBAR_ZOOM_MIN).toBeLessThan(1);
    expect(SIDEBAR_ZOOM_MAX).toBeGreaterThan(1);
  });
});

/**
 * The CONSUMER link. `--sidebar-k` is only worth setting if a rule reads it, and only worth
 * reading if the sizes inside the panel are relative to the element that carries it.
 *
 * Derived from the stylesheet because jsdom applies none: every render test above passes just
 * as happily against a panel whose font sizes are all still hard-coded px.
 */
describe('the stylesheet actually scales from it', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const CSS: string = require('fs').readFileSync(
    require('path').resolve(__dirname, '../Canvas.css'), 'utf-8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  const ruleFor = (selector: string): string => {
    for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const head = m[1].trim();
      if (head.startsWith('@')) continue;
      if (head.split(',').some((s) => s.trim() === selector)) return m[2];
    }
    throw new Error(`no rule for ${selector} — its subject moved or was renamed`);
  };

  it('drives the panel font-size from the variable, with a fallback', () => {
    const body = ruleFor('.canvas-sidebar');
    expect(body).toMatch(/font-size:\s*calc\([^;]*var\(--sidebar-k,\s*1\)[^;]*\)/);
  });

  /**
   * Every text size inside the panel must be RELATIVE, or it stays put while its neighbours
   * scale. Checked as a sweep over the sidebar's own rules rather than as a list of the ones
   * that exist today — the failure here is additive, exactly as `canvasNodeChrome` argues for
   * the node's counter-scale: the next rule someone adds will use a bare `px`.
   */
  it('leaves no bare pixel font-size inside the panel', () => {
    const offenders: string[] = [];
    for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const head = m[1].trim();
      if (head.startsWith('@')) continue;
      for (const sel of head.split(',').map((s) => s.trim())) {
        // The panel's own rules, and the tab-strip classes it re-scopes inside a row. The
        // `.canvas-sidebar` rule itself is the one place a px is REQUIRED — it is the base.
        if (!/^\.canvas-s(?!idebar\b)/.test(sel) && !/^\.canvas-srow /.test(sel)) continue;
        // The drag ghost is `position: fixed` on the BODY and deliberately outside the panel,
        // so it inherits nothing from it and must keep an absolute size.
        if (sel.startsWith('.canvas-sghost')) continue;
        const fs = /font-size:\s*([^;]+)/.exec(m[2])?.[1];
        if (fs && /\dpx/.test(fs)) offenders.push(`${sel} { font-size: ${fs.trim()} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Guard on the guard: the sweep above is satisfied by a filter that matches nothing at all.
  it('the sweep really inspects the panel\'s rules', () => {
    const seen: string[] = [];
    for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const sel of m[1].trim().split(',').map((s) => s.trim())) {
        if (/^\.canvas-s(?!idebar\b)/.test(sel) && /font-size:/.test(m[2])) seen.push(sel);
      }
    }
    expect(seen.length).toBeGreaterThan(3);
  });

  /**
   * The two glyphs a row borrows from the tab strip. They are sized in fixed px by
   * `TabManager.css`, so without a sidebar-scoped override they stay put while the text around
   * them scales — a zoomed-in row becomes text with two specks in it.
   */
  it.each(['.canvas-srow .tab-icon', '.canvas-srow .tab-icon-img'])(
    '%s is sized relatively so it scales with the row',
    (selector) => {
      const body = ruleFor(selector);
      expect(body).toMatch(/em/);
      expect(body).not.toMatch(/\dpx/);
    },
  );
});

/**
 * At zoom 1 the panel must render EXACTLY the pixel sizes it did before the zoom existed.
 *
 * The conversion from px to `em` is where this feature can silently change the look of a panel
 * nobody asked to restyle, and it has one trap that is invisible on inspection:
 *
 *   **`em` in a padding resolves against the element's OWN font-size, not its parent's.**
 *
 * So a rule that also sets `font-size: .92em` computes its paddings against 11.04px while a
 * sibling row computes the same numbers against 12px. Copying a row's `1.58em` indent into
 * `.canvas-sgempty` looks right, reviews as right, and renders 17.4px where 19px was intended.
 * That is exactly the mistake this block was written after catching.
 *
 * So the check is ARITHMETIC over the real stylesheet rather than a spot check of the rules
 * anyone thought to look at: every length is converted back to pixels using the font-size that
 * CSS would actually resolve it against, and compared with the pre-change value. The expected
 * numbers come from `git show develop:src/renderer/components/Canvas/Canvas.css`.
 */
describe('at zoom 1 the panel renders exactly as it did before', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const CSS: string = require('fs').readFileSync(
    require('path').resolve(__dirname, '../Canvas.css'), 'utf-8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  const BASE = 12;

  const bodyOf = (selector: string): string => {
    for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const head = m[1].trim();
      if (head.startsWith('@')) continue;
      if (head.split(',').some((s) => s.trim() === selector)) return m[2];
    }
    throw new Error(`no rule for ${selector} — its subject moved or was renamed`);
  };

  const decl = (selector: string, prop: string): string | null => {
    const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`);
    return re.exec(bodyOf(selector))?.[1].trim() ?? null;
  };

  /**
   * Each row: the selector, the font-size CSS resolves its own `em` lengths against, and the
   * pixel sizes the panel had on `develop`.
   *
   * `fontEm` is stated per row rather than derived, because it is not always the rule's own
   * declaration — `.canvas-sghead.editing` sets no font-size and inherits `.canvas-sghead`'s
   * `.84em`, which is precisely the kind of thing a parser would get wrong in the same direction
   * as the bug.
   */
  const TABLE: Array<{ selector: string; fontEm: number; want: Record<string, number[]> }> = [
    { selector: '.canvas-ssearch', fontEm: 1, want: { margin: [9, 9, 7], padding: [5, 8] } },
    { selector: '.canvas-sempty', fontEm: 1, want: { padding: [14, 11] } },
    { selector: '.canvas-sghead', fontEm: 0.84, want: { padding: [5, 11, 3] } },
    { selector: '.canvas-sghead.editing', fontEm: 0.84, want: { padding: [3, 9, 2] } },
    { selector: '.canvas-sgempty', fontEm: 0.92, want: { padding: [2, 11, 4, 19] } },
    { selector: '.canvas-srow', fontEm: 1, want: { padding: [4, 11, 4, 19], gap: [6] } },
    { selector: '.canvas-srow.editing', fontEm: 1, want: { padding: [2, 9, 2, 17] } },
    { selector: '.canvas-srename', fontEm: 1, want: { padding: [2, 5] } },
  ];

  /** Every length in a shorthand, in px, resolved against this element's own font-size. */
  const pixels = (value: string, fontPx: number): number[] =>
    [...value.matchAll(/(-?\d*\.?\d+)(em|px)/g)]
      .map((m) => (m[2] === 'em' ? Number(m[1]) * fontPx : Number(m[1])));

  for (const { selector, fontEm, want } of TABLE) {
    for (const [prop, expected] of Object.entries(want)) {
      it(`${selector} { ${prop} } still renders ${expected.join('/')}px`, () => {
        const raw = decl(selector, prop);
        expect(raw).not.toBeNull();
        const got = pixels(raw!, BASE * fontEm);
        expect(got).toHaveLength(expected.length);
        // Sub-pixel tolerance: two decimal places of `em` cannot hit every integer exactly, and
        // a tenth of a pixel is not a visual change. Half a pixel is, which is why it is 0.5 and
        // not "close enough".
        got.forEach((px, i) => expect(Math.abs(px - expected[i])).toBeLessThan(0.5));
      });
    }
  }

  /** The rule that set the font-size the rest are relative to. */
  it('the panel base really is 12px at zoom 1', () => {
    const fs = decl('.canvas-sidebar', 'font-size')!;
    expect(pixels(fs, BASE)[0]).toBe(BASE);
  });

  /**
   * The `fontEm` column is an input to every case above, so a wrong value there would make the
   * whole table agree with a wrong stylesheet. These pin it against the CSS itself for the two
   * rules that actually declare one.
   */
  it('the font-size column matches the stylesheet', () => {
    expect(pixels(decl('.canvas-sghead', 'font-size')!, BASE)[0]).toBeCloseTo(0.84 * BASE, 6);
    expect(pixels(decl('.canvas-sgempty', 'font-size')!, BASE)[0]).toBeCloseTo(0.92 * BASE, 6);
    // ...and `.canvas-sghead.editing` genuinely declares none, which is why it inherits .84.
    expect(decl('.canvas-sghead.editing', 'font-size')).toBeNull();
  });
});
