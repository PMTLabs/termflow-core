/**
 * @jest-environment jsdom
 *
 * The owning tab's colour, on every canvas surface that names a terminal or its tab.
 *
 * The model hops are pinned elsewhere (`canvasSelectors.test.ts` stamps the colour onto the node
 * and group; `sidebarModel.test.ts` carries it into the row). What is left is the last hop, which
 * no model test can see: whether each rendered title actually WEARS it. There are five such
 * titles across three components, and the whole point of the feature is that they agree — so a
 * suite that covered one of them would be the same partial fix in test form.
 *
 * Every coloured case drives TWO different colours, and every suite has an uncoloured control.
 * One colour is not enough on its own: `style={{ color: '#ff5f56' }}` — a component ignoring its
 * model and painting a constant — satisfies a single-colour assertion completely, and an
 * uncoloured control does not see it either, because such a component is still bare when the
 * model is bare. Only a second, different colour distinguishes "reads the model" from "is red".
 *
 * Drives `react-dom/client` + `React.act` directly; the repo has no `@testing-library/react`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore, EnhancedStore } from '@reduxjs/toolkit';
import canvasReducer from '../../../store/slices/canvasSlice';
import panesReducer, { PaneNode } from '../../../store/slices/panesSlice';
import tabsReducer from '../../../store/slices/tabsSlice';
import settingsReducer from '../../../store/slices/settingsSlice';
import { CanvasNode } from '../CanvasNode';
import { CanvasGroupFrame } from '../CanvasGroupFrame';
import { CanvasSidebar } from '../CanvasSidebar';
import { CanvasMetricsContext } from '../canvasMetricsContext';
import { DEFAULT_METRICS, LodTier, NODE_W, NODE_H, Rect } from '../canvasGeometry';
import type { CanvasModel, CanvasNodeModel, CanvasGroupModel } from '../canvasSelectors';

/** See `canvasNodeOpenAsTab.test.tsx`: the real hook reaches xterm, which throws in jsdom. */
jest.mock('../../Terminal/useDetectedAgent', () => ({
  useDetectedAgent: () => ({ agent: null, icon: null }),
}));
jest.mock('../../../services/cwdSnapshot', () => ({ getAllCwdSnapshots: () => ({}) }));
jest.mock('../../../services/StateManager', () => ({
  StateManager: { saveState: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../../services/TerminalService', () => ({
  terminalService: { getProcessIdForTerminal: (id: string) => `proc-${id}` },
}));

const RED = '#ff5f56';
const GREEN = '#27c93f';

/**
 * The two colours as the DOM will report them.
 *
 * jsdom normalises an inline hex to `rgb(...)`, so the expectation is derived by setting the same
 * value rather than hard-coded — which also keeps the test honest if that normalisation changes.
 */
const asCss = (hex: string) => {
  const probe = document.createElement('div');
  probe.style.color = hex;
  return probe.style.color;
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const colourOf = (sel: string) =>
  (container.querySelector(sel) as HTMLElement | null)?.style.color ?? null;

// ─────────────────────────────────────────────────────────────────────────────
// CanvasNode — the node title and the group chip beside it
// ─────────────────────────────────────────────────────────────────────────────

const rect: Rect = { x: 0, y: 0, w: NODE_W, h: NODE_H };
const nodeModel = (over: Partial<CanvasNodeModel> = {}): CanvasNodeModel => ({
  terminalId: 'tm-1',
  tabId: 'tb-1',
  paneId: 'pn-1',
  title: 'server',
  // Deliberately unequal to `title`, so a chip rendering the wrong field cannot pass.
  groupTitle: 'backend',
  shellType: 'zsh',
  rect,
  isRunning: false,
  hasUnseenOutput: false,
  exited: false,
  hidden: false,
  ...over,
});

const COMBOS = { enlarge: 'Q', openTab: 'G', leaveTerminal: 'Ctrl+Alt+Q', openTabFromOverlay: 'Ctrl+Alt+G' };

function renderNode(node: CanvasNodeModel, tier: LodTier = 'gpu', overlaid = true) {
  act(() => {
    root.render(
      <CanvasMetricsContext.Provider value={DEFAULT_METRICS}>
        <CanvasNode
          node={node}
          tier={tier}
          zoom={1}
          selected={false}
          focused={false}
          dimmed={false}
          hidden={false}
          nodeHidden={false}
          busyCue="sweep"
          overlaid={overlaid}
          combos={COMBOS}
        />
      </CanvasMetricsContext.Provider>,
    );
  });
}

describe('CanvasNode title colour', () => {
  /**
   * TWO colours, not one.
   *
   * A single-colour case is passed by `style={{ color: '#ff5f56' }}` — a component that ignores
   * the model and paints its own constant. That is not a hypothetical: it is the cheapest wrong
   * implementation of this exact feature, and one colour cannot see it.
   */
  it('wears the owning tab colour on both the node title and its group chip, whatever the colour', () => {
    renderNode(nodeModel({ titleColor: RED }));
    expect(colourOf('.canvas-node-title')).toBe(asCss(RED));
    expect(colourOf('.canvas-node-group')).toBe(asCss(RED));
    renderNode(nodeModel({ terminalId: 'tm-2', tabId: 'tb-2', titleColor: GREEN }));
    expect(colourOf('.canvas-node-title')).toBe(asCss(GREEN));
    expect(colourOf('.canvas-node-group')).toBe(asCss(GREEN));
  });

  it('leaves both bare when the tab has no colour, so the stylesheet still decides', () => {
    renderNode(nodeModel());
    expect(colourOf('.canvas-node-title')).toBe('');
    expect(colourOf('.canvas-node-group')).toBe('');
  });

  /**
   * The one place the colour must LOSE, and the reason this rule exists at all:
   * `Canvas.css` mutes an ended node's title with `.canvas-node.ended .canvas-node-title { color:
   * ... }` — a CLASS rule, which an inline colour outranks. Painting a dead terminal in its tab's
   * colour would undo the ended treatment silently, and only for coloured tabs.
   *
   * The chip goes with it: a node whose title is grey-italic while its chip glows is a node that
   * reads half-dead.
   */
  it('yields to the ended treatment, which an inline colour would otherwise outrank', () => {
    renderNode(nodeModel({ titleColor: RED, exited: true }));
    expect(colourOf('.canvas-node-title')).toBe('');
    expect(colourOf('.canvas-node-group')).toBe('');
  });

  // The negative control for the case above: `exited` has to be what suppresses it, not the
  // render path the overlay happens to take. A second colour again, so "suppress unless red"
  // cannot masquerade as "suppress unless ended".
  it('still wears the colour on a live node in the same overlay tier', () => {
    renderNode(nodeModel({ titleColor: RED, exited: false }));
    expect(colourOf('.canvas-node-title')).toBe(asCss(RED));
    renderNode(nodeModel({ terminalId: 'tm-2', titleColor: GREEN, exited: false }));
    expect(colourOf('.canvas-node-title')).toBe(asCss(GREEN));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CanvasGroupFrame — the frame label, and the chip it collapses into
// ─────────────────────────────────────────────────────────────────────────────

const groupModel = (over: Partial<CanvasGroupModel> = {}): CanvasGroupModel => ({
  tabId: 'tb-1',
  title: 'api',
  rect: { x: 0, y: 0, w: 800, h: 500 },
  nodeIds: ['tm-1'],
  anyRunning: false,
  allHidden: false,
  ...over,
});

function renderGroup(group: CanvasGroupModel, collapsed: boolean) {
  act(() => {
    root.render(
      <CanvasMetricsContext.Provider value={DEFAULT_METRICS}>
        <CanvasGroupFrame group={group} zoom={1} collapsed={collapsed} />
      </CanvasMetricsContext.Provider>,
    );
  });
}

describe('CanvasGroupFrame title colour', () => {
  // Both faces, because they are different elements on different branches — a fix applied to the
  // expanded label alone leaves every collapsed workspace uncoloured, which is the zoom level the
  // canvas exists for.
  it('colours the frame label and the collapsed chip alike, whatever the colour', () => {
    renderGroup(groupModel({ titleColor: RED }), false);
    expect(colourOf('.canvas-glabel')).toBe(asCss(RED));
    renderGroup(groupModel({ titleColor: RED }), true);
    expect(colourOf('.canvas-gchip-title')).toBe(asCss(RED));
    // A second colour on both branches: one colour is satisfied by a hard-coded constant.
    renderGroup(groupModel({ tabId: 'tb-2', titleColor: GREEN }), false);
    expect(colourOf('.canvas-glabel')).toBe(asCss(GREEN));
    renderGroup(groupModel({ tabId: 'tb-2', titleColor: GREEN }), true);
    expect(colourOf('.canvas-gchip-title')).toBe(asCss(GREEN));
  });

  it('leaves both bare for an uncoloured tab', () => {
    renderGroup(groupModel(), false);
    expect(colourOf('.canvas-glabel')).toBe('');
    renderGroup(groupModel(), true);
    expect(colourOf('.canvas-gchip-title')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CanvasSidebar — the row titles and the group headings
// ─────────────────────────────────────────────────────────────────────────────

const trees = (): Record<string, PaneNode> => ({
  'tb-a': { id: 'pn-1', type: 'terminal', terminalId: 'tm-1', name: 'zsh' },
  'tb-b': { id: 'pn-2', type: 'terminal', terminalId: 'tm-2', name: 'vite' },
});

const sidebarModel: CanvasModel = {
  nodes: [
    nodeModel({ terminalId: 'tm-1', tabId: 'tb-a', paneId: 'pn-1', title: 'zsh', titleColor: RED }),
    // A DIFFERENT colour, not an absent one: the control that catches a sidebar painting every
    // row from the first group it saw.
    nodeModel({ terminalId: 'tm-2', tabId: 'tb-b', paneId: 'pn-2', title: 'vite', titleColor: GREEN }),
  ],
  groups: [
    groupModel({ tabId: 'tb-a', title: 'api', nodeIds: ['tm-1'], titleColor: RED }),
    groupModel({ tabId: 'tb-b', title: 'web', nodeIds: ['tm-2'], titleColor: GREEN }),
  ],
};

let store: EnhancedStore;

const renderSidebar = (model: CanvasModel) => {
  store = configureStore({
    reducer: { canvas: canvasReducer, panes: panesReducer, tabs: tabsReducer, settings: settingsReducer },
    preloadedState: {
      panes: {
        paneTree: null, activePaneId: null, treesByTabId: trees(),
        activeTabId: 'tb-canvas', activePaneByTabId: {}, maximizedPaneByTabId: {},
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
  act(() => {
    root.render(
      <Provider store={store}>
        <CanvasMetricsContext.Provider value={DEFAULT_METRICS}>
          <CanvasSidebar model={model} vw={900} vh={600} onFlyToNode={jest.fn()} />
        </CanvasMetricsContext.Provider>
      </Provider>,
    );
  });
};

const colours = (sel: string) =>
  Array.from(container.querySelectorAll<HTMLElement>(sel)).map((e) => e.style.color);

/**
 * Scoped to the SECTION carrying a given `data-tab-id`, rather than read off the flat list by
 * position. Position is not identity: a sidebar that painted the first rendered row red and the
 * second green — ignoring both models — satisfies an ordinal oracle exactly.
 */
const inGroup = (tabId: string, sel: string) =>
  colours(`.canvas-sgroup[data-tab-id="${tabId}"] ${sel}`);

describe('CanvasSidebar title colour', () => {
  it('gives every row and heading its OWN tab colour, never a neighbour\'s', () => {
    renderSidebar(sidebarModel);
    expect(inGroup('tb-a', '.canvas-sghead')).toEqual([asCss(RED)]);
    expect(inGroup('tb-a', '.canvas-srow-title')).toEqual([asCss(RED)]);
    expect(inGroup('tb-b', '.canvas-sghead')).toEqual([asCss(GREEN)]);
    expect(inGroup('tb-b', '.canvas-srow-title')).toEqual([asCss(GREEN)]);
  });

  it('leaves rows and headings bare when no tab is coloured', () => {
    renderSidebar({
      nodes: sidebarModel.nodes.map((n) => ({ ...n, titleColor: undefined })),
      groups: sidebarModel.groups.map((g) => ({ ...g, titleColor: undefined })),
    });
    // Cardinality first: `toEqual(['', ''])` on a list that rendered nothing would be a pair of
    // absences agreeing with each other.
    expect(colours('.canvas-sghead')).toHaveLength(2);
    expect(colours('.canvas-srow-title')).toHaveLength(2);
    expect(colours('.canvas-sghead')).toEqual(['', '']);
    expect(colours('.canvas-srow-title')).toEqual(['', '']);
  });
});

describe('CanvasSidebar transient title surfaces', () => {
  /** Double-click a row to swap its title for the rename box. */
  const startRowRename = (tabId = 'tb-a') => {
    const row = container.querySelector(`.canvas-sgroup[data-tab-id="${tabId}"] .canvas-srow`)!;
    act(() => { row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  };

  it('keeps the colour in the rename box that REPLACES a row title', () => {
    renderSidebar(sidebarModel);
    startRowRename();
    expect((container.querySelector('.canvas-srename') as HTMLElement).style.color).toBe(asCss(RED));
  });

  it('keeps a GREEN row colour in the rename box that REPLACES its title', () => {
    renderSidebar(sidebarModel);
    startRowRename('tb-b');
    expect((container.querySelector('.canvas-srename') as HTMLElement).style.color).toBe(asCss(GREEN));
  });

  it('leaves the rename box bare when the tab has no colour', () => {
    renderSidebar({
      nodes: sidebarModel.nodes.map((n) => ({ ...n, titleColor: undefined })),
      groups: sidebarModel.groups.map((g) => ({ ...g, titleColor: undefined })),
    });
    startRowRename();
    expect((container.querySelector('.canvas-srename') as HTMLElement).style.color).toBe('');
  });

  it('keeps the colour in the rename box that REPLACES a GROUP heading', () => {
    renderSidebar(sidebarModel);
    const head = container.querySelector('.canvas-sgroup[data-tab-id="tb-b"] .canvas-sghead')!;
    act(() => { head.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    // tb-b is the GREEN tab — a group rename wired to the first group's colour fails here.
    expect((container.querySelector('.canvas-srename') as HTMLElement).style.color).toBe(asCss(GREEN));
  });

  it('keeps a RED group-heading colour in the rename box that REPLACES it', () => {
    renderSidebar(sidebarModel);
    const head = container.querySelector('.canvas-sgroup[data-tab-id="tb-a"] .canvas-sghead')!;
    act(() => { head.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect((container.querySelector('.canvas-srename') as HTMLElement).style.color).toBe(asCss(RED));
  });

  /**
   * The row drag ghost — the row's title following the cursor. Driven through the real drag hook
   * (pointerdown, then a move past the threshold) rather than by setting state, because the whole
   * question is whether the colour survives the hand-off from the row into the drag state.
   */
  it('carries the row colour onto the drag ghost', () => {
    // jsdom implements neither; the hook uses `elementFromPoint` to find the group under the
    // cursor, which is a DROP-TARGET question and not what this test is about. Returning null
    // means "over no group", leaving the ghost itself the only thing under assertion.
    (document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;
    const dragRow = (tabId: string, model = sidebarModel) => {
      renderSidebar(model);
      const row = container.querySelector(`.canvas-sgroup[data-tab-id="${tabId}"] .canvas-srow`)!;
      act(() => {
        row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
      });
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 60, clientY: 60 }));
      });
      const ghost = container.querySelector('.canvas-sghost') as HTMLElement | null;
      expect(ghost).not.toBeNull();
      return ghost!;
    };
    // GREEN, from tb-b's row — not the first row's RED.
    expect(dragRow('tb-b').style.color).toBe(asCss(GREEN));
    expect(dragRow('tb-a').style.color).toBe(asCss(RED));
    expect(dragRow('tb-a', {
      nodes: sidebarModel.nodes.map((n) => ({ ...n, titleColor: undefined })),
      groups: sidebarModel.groups.map((g) => ({ ...g, titleColor: undefined })),
    }).style.color).toBe('');
  });
});
