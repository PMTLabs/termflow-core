/**
 * @jest-environment jsdom
 *
 * The sidebar's four behaviours — `plan/013` Task 14.
 *
 * The tree itself is pinned in `sidebarModel.test.ts`. What is here is the part with a store
 * behind it: the rename, which is the Task 1 regression check and the one place a wrong argument
 * produces a silent no-op rather than an error.
 *
 * `react-dom/client` + `React.act` directly; the repo has no `@testing-library/react`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore, EnhancedStore } from '@reduxjs/toolkit';
import canvasReducer, { SIDEBAR_MIN, SIDEBAR_MAX } from '../../../store/slices/canvasSlice';
import panesReducer, { PaneNode } from '../../../store/slices/panesSlice';
import tabsReducer from '../../../store/slices/tabsSlice';
import { CanvasSidebar, ROW_FLY_ZOOM } from '../CanvasSidebar';
import { centreOn, FLY_MS } from '../viewportStyles';
import { CanvasMetricsContext } from '../canvasMetricsContext';
import { DEFAULT_METRICS, NODE_W, NODE_H, Rect } from '../canvasGeometry';
import { fitGroupFrame, GAP } from '../canvasLayout';
import { findPaneIdByTerminalId as findLeaf } from '../canvasMutations';
import type { CanvasModel, CanvasNodeModel, CanvasGroupModel } from '../canvasSelectors';

jest.mock('../../../services/cwdSnapshot', () => ({
  getAllCwdSnapshots: () => ({ 'tm-1': '/home/u/termflow-core', 'tm-3': '/home/u/termflow-site' }),
}));

const rect = (x: number, y: number): Rect => ({ x, y, w: NODE_W, h: NODE_H });
const node = (terminalId: string, tabId: string, paneId: string, title: string): CanvasNodeModel => ({
  terminalId, tabId, paneId, title, shellType: 'zsh', rect: rect(0, 0),
  isRunning: false, hasUnseenOutput: false,
});
const group = (tabId: string, title: string, nodeIds: string[]): CanvasGroupModel =>
  ({ tabId, title, rect: rect(0, 0), nodeIds, anyRunning: false });

const model: CanvasModel = {
  nodes: [
    node('tm-1', 'tb-a', 'pn-2', 'zsh'),
    node('tm-2', 'tb-a', 'pn-3', 'server'),
    node('tm-3', 'tb-b', 'pn-4', 'zsh'),
  ],
  groups: [group('tb-a', 'api', ['tm-1', 'tm-2']), group('tb-b', 'web', ['tm-3'])],
};

/** `tb-a` is a split of two panes; `tb-b` is a single terminal — the difference decides whether
 *  a rename also renames the TAB. */
const trees = (): Record<string, PaneNode> => ({
  'tb-a': {
    id: 'pn-1', type: 'split', direction: 'horizontal', size: 50, children: [
      { id: 'pn-2', type: 'terminal', terminalId: 'tm-1', name: 'zsh' },
      { id: 'pn-3', type: 'terminal', terminalId: 'tm-2', name: 'server' },
    ],
  },
  'tb-b': { id: 'pn-4', type: 'terminal', terminalId: 'tm-3', name: 'zsh' },
});

let container: HTMLDivElement;
let root: Root;
let store: EnhancedStore;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  store = configureStore({
    reducer: { canvas: canvasReducer, panes: panesReducer, tabs: tabsReducer },
    preloadedState: {
      panes: {
        paneTree: null,
        activePaneId: null,
        treesByTabId: trees(),
        // The canvas tab is active while the canvas is on screen, and it owns no pane tree.
        // That is exactly why `renamePanes` must be given an explicit tabId.
        activeTabId: 'tb-canvas',
        activePaneByTabId: {},
        maximizedPaneByTabId: {},
      },
      tabs: {
        tabs: [
          { id: 'tb-a', title: 'api', shellType: 'zsh', isActive: false },
          { id: 'tb-b', title: 'web', shellType: 'zsh', isActive: false },
        ],
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

const render = (m: CanvasModel = model) => {
  act(() => {
    root.render(
      <Provider store={store}>
        <CanvasMetricsContext.Provider value={DEFAULT_METRICS}>
          <CanvasSidebar model={m} vw={900} vh={600} />
        </CanvasMetricsContext.Provider>
      </Provider>,
    );
  });
};

const rows = () => Array.from(container.querySelectorAll('.canvas-srow'));
const groupHeads = () => Array.from(container.querySelectorAll('.canvas-sghead')).map((e) => e.textContent);
const search = () => container.querySelector('.canvas-ssearch') as HTMLInputElement;
const type = (value: string) => {
  const input = search();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const paneName = (tabId: string, paneId: string): string | undefined => {
  const walk = (n: PaneNode | undefined | null): PaneNode | null => {
    if (!n) return null;
    if (n.id === paneId) return n;
    for (const c of n.children ?? []) { const hit = walk(c); if (hit) return hit; }
    return null;
  };
  const s = store.getState() as { panes: { treesByTabId: Record<string, PaneNode> } };
  return walk(s.panes.treesByTabId[tabId])?.name;
};

describe('CanvasSidebar — the tree', () => {
  it('renders every group and its terminals', () => {
    render();
    expect(groupHeads()).toEqual(['api', 'web']);
    expect(rows().map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('server')]),
    );
  });

  it('shows a disambiguator only on the colliding titles', () => {
    render();
    const text = rows().map((r) => r.textContent ?? '');
    expect(text.filter((t) => t.includes('termflow-core'))).toHaveLength(1);
    expect(text.filter((t) => t.includes('termflow-site'))).toHaveLength(1);
    // `server` is unique, so it must carry nothing extra.
    expect(text.find((t) => t.startsWith('server'))).toBe('server');
  });

  it('filters as you type and highlights the match', () => {
    render();
    type('erv');
    expect(rows()).toHaveLength(1);
    expect(container.querySelector('.canvas-srow-title mark')?.textContent).toBe('erv');
  });

  it('names the query in the empty state', () => {
    render();
    type('zzzz');
    expect(rows()).toHaveLength(0);
    expect(container.querySelector('.canvas-sempty')?.textContent).toContain('zzzz');
  });
});

describe('CanvasSidebar — rename', () => {
  const startEditing = (index: number) => {
    act(() => { rows()[index].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    return container.querySelector('.canvas-srename') as HTMLInputElement;
  };
  const commit = (input: HTMLInputElement, value: string) => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  };

  /**
   * **The Task 1 regression check.** `renamePanes` falls back to `state.activeTabId` when no
   * tabId is given — and the active tab in Canvas Mode is the CANVAS tab, which owns no pane
   * tree, so the reducer would return early and the rename would vanish without an error.
   * `tb-a` is deliberately not the active tab here.
   */
  it('renames a pane in a NON-ACTIVE tab', () => {
    render();
    commit(startEditing(1), 'build');
    expect(paneName('tb-a', 'pn-3')).toBe('build');
  });

  it('leaves the other panes in that tab alone', () => {
    render();
    commit(startEditing(1), 'build');
    expect(paneName('tb-a', 'pn-2')).toBe('zsh');
  });

  it('renames the TAB too when the terminal is the only one in it', () => {
    render();
    // Row index 2 is `tm-3`, the sole terminal of `tb-b`.
    commit(startEditing(2), 'frontend');
    const s = store.getState() as { tabs: { tabs: { id: string; title: string }[] } };
    expect(s.tabs.tabs.find((t) => t.id === 'tb-b')!.title).toBe('frontend');
  });

  // ...and NOT when it is one of several. The tab is the group; renaming one member must not
  // rename the group (design 010 §2.1 keeps `PaneNode.name` and `Tab.title` distinct).
  it('leaves the tab title alone when the group has more than one terminal', () => {
    render();
    commit(startEditing(1), 'build');
    const s = store.getState() as { tabs: { tabs: { id: string; title: string }[] } };
    expect(s.tabs.tabs.find((t) => t.id === 'tb-a')!.title).toBe('api');
  });

  it('cancels on Escape without writing anything', () => {
    render();
    const input = startEditing(1);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'discarded');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(paneName('tb-a', 'pn-3')).toBe('server');
    expect(container.querySelector('.canvas-srename')).toBeNull();
  });

  // A cancelled edit used to leave its draft behind on the row, so reopening it showed the
  // discarded text already typed in — see `RenameInput`'s note.
  it('a second edit starts clean after a cancelled one', () => {
    render();
    const first = startEditing(1);
    act(() => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    const second = startEditing(1);
    expect(second.value).toBe('server');
    // `focusout`, not `blur`: React maps its `onBlur` onto the bubbling event, and a raw `blur`
    // dispatched at the element never reaches the root where the listener lives.
    act(() => { second.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(container.querySelector('.canvas-srename')).toBeNull();
  });

  it('refuses an empty name rather than blanking the row', () => {
    render();
    commit(startEditing(1), '   ');
    expect(paneName('tb-a', 'pn-3')).toBe('server');
  });
});

describe('CanvasSidebar — selection', () => {
  it('selects the node a row click names', () => {
    render();
    act(() => { rows()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const s = store.getState() as { canvas: { selectedId: string | null } };
    expect(s.canvas.selectedId).toBe('tm-2');
  });

  /**
   * Design §10: this is the answer to "the terminal is in a group but off-screen", so the click
   * has to MOVE the viewport — and it has to fly rather than jump, since a jump at canvas
   * altitude arrives with no sense of where it came from.
   *
   * The frame queue is driven by hand: `useFlyTo` dispatches from inside a rAF callback, which
   * under jsdom's real timer lands outside `act` and makes the assertion a race.
   */
  it('flies to the node, centred, at the zoom floor', () => {
    const realRaf = window.requestAnimationFrame;
    const queued: ((t: number) => void)[] = [];
    window.requestAnimationFrame = ((cb: (t: number) => void) => { queued.push(cb); return queued.length; }) as typeof window.requestAnimationFrame;
    try {
      const target = rect(4000, 3000);
      const far: CanvasModel = {
        ...model,
        nodes: model.nodes.map((n) => (n.terminalId === 'tm-2' ? { ...n, rect: target } : n)),
      };
      render(far);
      const vp = () => (store.getState() as { canvas: { viewport: { x: number; y: number; z: number } } }).canvas.viewport;
      const before = vp();

      act(() => { rows()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      // A frame was asked for and nothing has moved yet — the flight is animated, not a jump.
      expect(queued).toHaveLength(1);
      expect(vp()).toEqual(before);

      // A timestamp past FLY_MS, so the flight lands in one frame and the destination can be
      // asserted exactly rather than as "something changed". A timestamp BELOW the start would
      // extrapolate backwards, which is why it is derived from the clock rather than written as 0.
      act(() => { queued.shift()!(performance.now() + FLY_MS * 2); });
      // The floor is a FLOOR: the viewport starts at z = 1, which is already closer, so the
      // flight must keep it rather than zooming back out to 0.85.
      expect(vp()).toEqual(centreOn(target, 900, 600, Math.max(before.z, ROW_FLY_ZOOM), DEFAULT_METRICS.zMax));
      expect(vp().z).toBe(before.z);
    } finally {
      window.requestAnimationFrame = realRaf;
    }
  });
});

/**
 * Drag-to-regroup and the width handle — `plan/013` Task 15.
 *
 * The pointer sequence is driven directly: jsdom has no `PointerEvent`, and `elementFromPoint`
 * is unimplemented, so the drop target is stubbed. What is being pinned is the wiring between
 * the gesture and `planRegroup`/`regridGroup`, both of which are tested as pure functions in
 * `canvasMutations.test.ts`.
 */
describe('CanvasSidebar — drag and resize', () => {
  const pointer = (target: EventTarget, type: string, x: number, y: number) => {
    act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })); });
  };
  const sectionFor = (tabId: string) =>
    container.querySelector(`.canvas-sgroup[data-tab-id="${tabId}"]`) as HTMLElement;
  const overGroup = (tabId: string | null) => {
    document.elementFromPoint = (() => (tabId ? sectionFor(tabId) : null)) as typeof document.elementFromPoint;
  };
  const canvas = () => (store.getState() as {
    canvas: { nodes: Record<string, Rect>; groups: Record<string, Rect>; sidebarWidth: number; selectedId: string | null };
  }).canvas;
  const panes = () => (store.getState() as { panes: { treesByTabId: Record<string, PaneNode> } }).panes;

  /** Drag row `index` and release it over `tabId` (null = over nothing). */
  const dragRowTo = (index: number, tabId: string | null, dx = 40) => {
    const row = rows()[index];
    pointer(row, 'pointerdown', 100, 100);
    overGroup(tabId);
    pointer(window, 'pointermove', 100 + dx, 100 + dx);
    pointer(window, 'pointerup', 100 + dx, 100 + dx);
  };

  it('moves the terminal into the group it was dropped on', () => {
    render();
    // Row 1 is `tm-2`, which lives in `tb-a`.
    dragRowTo(1, 'tb-b');
    expect(findLeaf(panes().treesByTabId['tb-a'], 'tm-2')).toBeNull();
    expect(findLeaf(panes().treesByTabId['tb-b'], 'tm-2')).not.toBeNull();
  });

  /**
   * The destination is RE-GRIDDED, which is the one real difference from a canvas drop: a list
   * drag carries no position, so there is nothing to honour and the arrival is slotted into the
   * grid instead (design 010 §6.3).
   */
  it('re-grids the destination rather than leaving the arrival where the cursor was', () => {
    render();
    dragRowTo(1, 'tb-b');
    const placed = ['tm-3', 'tm-2'].map((id) => canvas().nodes[id]);
    expect(placed.every(Boolean)).toBe(true);
    // Side by side on one row, at the frame's own padding — a grid, not two coincidences.
    expect(placed[0].y).toBe(placed[1].y);
    expect(Math.abs(placed[1].x - placed[0].x)).toBe(NODE_W + GAP);
    expect(canvas().groups['tb-b']).toEqual(fitGroupFrame(placed));
  });

  /**
   * The source only SHRINK-WRAPS around what is left; it is not re-gridded, because that would
   * rearrange terminals the user never touched.
   *
   * Compared against the surviving node's MODEL rect rather than a slice entry, and the
   * difference is the point: nothing dispatched a position for `tm-1`, so the slice has no entry
   * for it at all. Only the destination's members are repositioned.
   */
  it('shrink-wraps the source without moving what stayed behind', () => {
    render();
    const stayed = model.nodes.find((n) => n.terminalId === 'tm-1')!.rect;
    dragRowTo(1, 'tb-b');
    expect(canvas().groups['tb-a']).toEqual(fitGroupFrame([stayed]));
    expect(canvas().nodes['tm-1']).toBeUndefined();
  });

  it('does nothing when the row is dropped on its own group', () => {
    render();
    const before = JSON.stringify(panes().treesByTabId);
    dragRowTo(1, 'tb-a');
    expect(JSON.stringify(panes().treesByTabId)).toBe(before);
  });

  /**
   * ...and does not HIGHLIGHT it either, which is a separate claim from the one above.
   *
   * Two guards stop a same-group drop: the highlight refuses its own group, and the drop refuses
   * a target equal to the source. Only the second is exercised by "nothing changed", so removing
   * the first leaves every test passing while the frame under the cursor lights up promising a
   * move that will not happen.
   */
  it('does not highlight the row\'s own group as a target', () => {
    render();
    const row = rows()[1];
    pointer(row, 'pointerdown', 100, 100);
    overGroup('tb-a');
    pointer(window, 'pointermove', 140, 140);
    expect(container.querySelector('.canvas-sgroup.drop')).toBeNull();
    pointer(window, 'pointerup', 140, 140);
  });

  it('does nothing when the row is dropped on empty space', () => {
    render();
    const before = JSON.stringify(panes().treesByTabId);
    dragRowTo(1, null);
    expect(JSON.stringify(panes().treesByTabId)).toBe(before);
  });

  // Below the slop it is a press, not a drag — and the row's click and double-click both have
  // to survive it.
  it('a 2px wobble is still a click, not a drag', () => {
    render();
    const before = JSON.stringify(panes().treesByTabId);
    const row = rows()[1];
    pointer(row, 'pointerdown', 100, 100);
    overGroup('tb-b');
    pointer(window, 'pointermove', 102, 100);
    pointer(window, 'pointerup', 102, 100);
    expect(JSON.stringify(panes().treesByTabId)).toBe(before);
    expect(container.querySelector('.canvas-sghost')).toBeNull();
  });

  /**
   * `click` fires after `pointerup`, so a completed drag would otherwise ALSO fly the viewport
   * to the terminal that just changed groups — which reads as the drop having gone somewhere
   * unintended.
   */
  it('swallows the click that follows a completed drag, but only one', () => {
    render();
    dragRowTo(1, 'tb-b');
    act(() => { rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(canvas().selectedId).toBeNull();
    act(() => { rows()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(canvas().selectedId).not.toBeNull();
  });

  it('lifts the row and shows a ghost while dragging', () => {
    render();
    const row = rows()[1];
    pointer(row, 'pointerdown', 100, 100);
    overGroup('tb-b');
    pointer(window, 'pointermove', 140, 140);
    expect(container.querySelector('.canvas-srow.lifting')).not.toBeNull();
    expect(container.querySelector('.canvas-sghost')?.textContent).toBe('server');
    expect(sectionFor('tb-b').className).toContain('drop');
    // Its own group is never a target.
    expect(sectionFor('tb-a').className).not.toContain('drop');
    pointer(window, 'pointerup', 140, 140);
    expect(container.querySelector('.canvas-sghost')).toBeNull();
  });

  it('resizes by the pointer delta', () => {
    render();
    const before = canvas().sidebarWidth;
    const handle = container.querySelector('.canvas-sresize') as HTMLElement;
    pointer(handle, 'pointerdown', 300, 40);
    pointer(window, 'pointermove', 340, 40);
    expect(canvas().sidebarWidth).toBe(before + 40);
    pointer(window, 'pointerup', 340, 40);
  });

  it('stops at both ends rather than following the pointer off the scale', () => {
    render();
    const handle = container.querySelector('.canvas-sresize') as HTMLElement;
    pointer(handle, 'pointerdown', 300, 40);
    pointer(window, 'pointermove', 5000, 40);
    expect(canvas().sidebarWidth).toBe(SIDEBAR_MAX);
    pointer(window, 'pointermove', -5000, 40);
    expect(canvas().sidebarWidth).toBe(SIDEBAR_MIN);
    pointer(window, 'pointerup', 0, 40);
  });

  it('stops resizing on pointerup', () => {
    render();
    const handle = container.querySelector('.canvas-sresize') as HTMLElement;
    pointer(handle, 'pointerdown', 300, 40);
    pointer(window, 'pointermove', 340, 40);
    pointer(window, 'pointerup', 340, 40);
    const settled = canvas().sidebarWidth;
    pointer(window, 'pointermove', 600, 40);
    expect(canvas().sidebarWidth).toBe(settled);
  });
});
