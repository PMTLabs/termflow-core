/**
 * @jest-environment jsdom
 */
/**
 * Plan 048 — the canvas half of Main only: the persisted toggle, the model's `filtered`
 * projection and single paint predicate, and the toolbar/sidebar wiring in `CanvasMode`
 * (which cannot be mounted under the root Jest config, hence the source pins at the end).
 */
// Same idiom as canvasPersistence.test.ts: StateManager pulls in a `.css` import via
// TerminalContainer, which this Jest config has no transform for.
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));

import path from 'path';
import canvasReducer, { hydrateCanvas, setMainOnly, selectNode, focusNode, setOverlayNode } from '../../../store/slices/canvasSlice';
import { sanitizeCanvasState } from '../../../services/StateManager';
import {
  buildCanvasModel, selectCanvasModel, isNodePainted, allCollapsed, snapshotNodeIds, CanvasNodeModel,
} from '../canvasSelectors';
import { NODE_W, NODE_H } from '../canvasGeometry';
import { readSource } from '../../../utils/readSource';

const initCanvas = () => canvasReducer(undefined, { type: '@@INIT' } as any);

describe('canvasSlice.mainOnly', () => {
  it('is off by default', () => {
    expect(initCanvas().mainOnly).toBe(false);
  });

  it('turning it on drops a selection, focus or overlay on a node it is about to filter', () => {
    let s = initCanvas();
    s = canvasReducer(s, selectNode('tm-api'));
    s = canvasReducer(s, focusNode('tm-api'));
    s = canvasReducer(s, setOverlayNode('tm-api'));
    s = canvasReducer(s, setMainOnly({ enabled: true, apiTerminalIds: ['tm-api'] }));
    expect(s.mainOnly).toBe(true);
    expect(s.selectedId).toBeNull();
    expect(s.focusedId).toBeNull();
    expect(s.overlayId).toBeNull();
  });

  it('leaves interaction on a MAIN node alone', () => {
    let s = canvasReducer(initCanvas(), focusNode('tm-user'));
    s = canvasReducer(s, setMainOnly({ enabled: true, apiTerminalIds: ['tm-api'] }));
    expect(s.focusedId).toBe('tm-user');
  });

  it('hydrates a persisted boolean and ignores anything else', () => {
    expect(canvasReducer(initCanvas(), hydrateCanvas({ mainOnly: true })).mainOnly).toBe(true);
    expect(canvasReducer(initCanvas(), hydrateCanvas({ mainOnly: 'yes' as any })).mainOnly).toBe(false);
  });
});

describe('persistence (StateManager)', () => {
  const base = { viewport: { x: 0, y: 0, z: 1 }, nodes: {}, groups: {} };
  it('defaults to off, and restores a persisted true', () => {
    expect(sanitizeCanvasState(base as any)!.mainOnly).toBe(false);
    expect(sanitizeCanvasState({ ...base, mainOnly: true } as any)!.mainOnly).toBe(true);
    expect(sanitizeCanvasState({ ...base, mainOnly: 1 } as any)!.mainOnly).toBe(false);
  });

  it('is written by both save projections', () => {
    const code = (f: string) => readSource(path.resolve(__dirname, f));
    expect(code('../../../services/StateManager.ts')).toContain('mainOnly: state.canvas.mainOnly,');
    expect(code('../../../services/workspaceSnapshot.ts')).toContain('mainOnly: state.canvas.mainOnly,');
  });
});

describe('buildCanvasModel — Main only', () => {
  // tb-mix: one user pane (stored far right) and one API pane (stored at the origin), so a frame
  // fitted over both differs from one fitted over the user pane alone. tb-api: API panes only.
  const state = (canvas: Record<string, unknown> = {}) => ({
    tabs: {
      tabs: [
        { id: 'tb-mix', title: 'mix', shellType: 'zsh' },
        { id: 'tb-api', title: 'agent', shellType: 'zsh' },
      ],
      runningTerminalIds: [],
    },
    panes: {
      treesByTabId: {
        'tb-mix': {
          id: 'pn-1', type: 'split', direction: 'vertical', children: [
            { id: 'pn-2', type: 'terminal', terminalId: 'tm-user' },
            { id: 'pn-3', type: 'terminal', terminalId: 'tm-api1', apiCreated: true },
          ],
        },
        'tb-api': { id: 'pn-4', type: 'terminal', terminalId: 'tm-api2', apiCreated: true },
      },
    },
    sessionExit: { byTerminalId: {} },
    canvas: {
      nodes: {
        'tm-user': { x: 2000, y: 1000, w: NODE_W, h: NODE_H },
        'tm-api1': { x: 0, y: 0, w: NODE_W, h: NODE_H },
      },
      groups: {}, hidden: {}, revealHidden: false, mainOnly: false,
      ...canvas,
    },
  }) as any;
  const node = (m: ReturnType<typeof buildCanvasModel>, id: string) => m.nodes.find((n) => n.terminalId === id)!;
  const group = (m: ReturnType<typeof buildCanvasModel>, id: string) => m.groups.find((g) => g.tabId === id)!;

  it('projects apiCreated always, and filtered only while Main only is on', () => {
    const off = buildCanvasModel(state());
    expect(node(off, 'tm-api1').apiCreated).toBe(true);
    expect(node(off, 'tm-user').apiCreated).toBe(false);
    expect(node(off, 'tm-api1').filtered).toBe(false);

    const on = buildCanvasModel(state({ mainOnly: true }));
    expect(node(on, 'tm-api1').filtered).toBe(true);
    expect(node(on, 'tm-api2').filtered).toBe(true);
    expect(node(on, 'tm-user').filtered).toBe(false);
  });

  it('the MEMOISED selector the component uses recomputes when only mainOnly changes', () => {
    // `selectCanvasModel` is what CanvasMode reads; a missing `mainOnly` input would leave the
    // toggle doing nothing until some unrelated slice changed.
    const s = state();
    const off = selectCanvasModel(s);
    const on = selectCanvasModel({ ...s, canvas: { ...s.canvas, mainOnly: true } });
    expect(node(off, 'tm-api1').filtered).toBe(false);
    expect(node(on, 'tm-api1').filtered).toBe(true);
  });

  it('keeps filtered nodes IN the model — a paint filter, never an unmount', () => {
    expect(buildCanvasModel(state({ mainOnly: true })).nodes.map((n) => n.terminalId).sort())
      .toEqual(['tm-api1', 'tm-api2', 'tm-user']);
  });

  it('shrink-wraps a mixed group around its main nodes only', () => {
    const off = group(buildCanvasModel(state()), 'tb-mix').rect;
    const on = group(buildCanvasModel(state({ mainOnly: true })), 'tb-mix').rect;
    expect(on).not.toEqual(off);
    expect(on.x).toBeGreaterThan(1000); // the API node at x=0 no longer stretches the frame
  });

  it('Reveal Hidden does not bring back a filtered node, and user-hidden stays user-hidden', () => {
    const m = buildCanvasModel(state({ mainOnly: true, revealHidden: true, hidden: { 'tm-user': true } }));
    expect(isNodePainted(node(m, 'tm-api1'), true)).toBe(false);
    expect(isNodePainted(node(m, 'tm-user'), true)).toBe(true);
    expect(isNodePainted(node(m, 'tm-user'), false)).toBe(false);
    // The user's own hidden flag is untouched by the filter.
    expect(node(m, 'tm-user').hidden).toBe(true);
    expect(node(m, 'tm-api1').hidden).toBe(false);
  });
});

describe('the shared predicate reaches the pure consumers', () => {
  const n = (id: string, over: Partial<CanvasNodeModel> = {}): CanvasNodeModel => ({
    terminalId: id, tabId: 'tb', paneId: `pn-${id}`, title: id, groupTitle: 'g', shellType: 'zsh',
    rect: { x: 0, y: 0, w: NODE_W, h: NODE_H },
    isRunning: false, hasUnseenOutput: false, exited: false, hidden: false, ...over,
  });

  it('snapshotNodeIds skips a filtered node', () => {
    const ids = snapshotNodeIds(
      [n('a'), n('b', { filtered: true })],
      { a: 'snapshot', b: 'snapshot' }, new Set(['a', 'b']), false, false,
    );
    expect([...ids]).toEqual(['a']);
  });

  it('allCollapsed ignores a filtered node when deciding the workspace is all chips', () => {
    // The only painted node is at the group tier; the filtered one at gpu must not veto collapse.
    expect(allCollapsed([n('a'), n('b', { filtered: true })], { a: 'group', b: 'gpu' }, 1)).toBe(true);
    expect(allCollapsed([n('a'), n('b')], { a: 'group', b: 'gpu' }, 1)).toBe(false);
  });
});

/** Comments stripped, so a pin cannot be satisfied by the prose explaining it. */
function code(file: string): string {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\}/g, '{}')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('CanvasMode wiring', () => {
  const MODE = code(path.resolve(__dirname, '../CanvasMode.tsx'));
  const MINIMAP = code(path.resolve(__dirname, '../CanvasMinimap.tsx'));
  const ARRANGE = code(path.resolve(__dirname, '../useArrange.ts'));
  const SIDEBAR_DRAG = code(path.resolve(__dirname, '../useSidebarDrag.ts'));
  const FLY_TO_NODE = (() => {
    const start = MODE.indexOf('const flyToNode = useCallback(');
    return start < 0 ? '' : MODE.slice(start, MODE.indexOf('\n  }, [', start));
  })();

  it('renders a Main only toggle that passes the nodes it will filter', () => {
    expect(MODE).toContain('aria-pressed={mainOnly}');
    expect(MODE).toContain('onClick={() => dispatch(setMainOnly({ enabled: !mainOnly, apiTerminalIds: apiNodeIds }))}');
    expect(MODE).toContain("Main only{apiCount > 0 ? ` (${apiCount})` : ''}");
    // Disabled with nothing to filter — but never while ON, or it could not be switched off.
    expect(MODE).toContain('disabled={apiCount === 0 && !mainOnly}');
  });

  it('paints, wires and frames through the one predicate', () => {
    expect(MODE).toContain('model.nodes.filter((n) => isNodePainted(n, revealHidden))');
    expect(MODE).toContain('g.nodeIds.length === 0 || g.nodeIds.some((id) => !unpaintedNodeIds.has(id))');
    expect(MODE).toContain('edges={edges.filter((e) => !userHidden(e.from) && !userHidden(e.to))}');
    expect(MINIMAP).toContain('model.nodes.filter((n) => isNodePainted(n, revealHidden))');
  });

  it('Arrange and a sidebar regroup leave filtered nodes where they are', () => {
    expect(ARRANGE.match(/!n\.hidden && !n\.filtered/g)?.length).toBe(2);
    expect(SIDEBAR_DRAG).toContain('return !n?.hidden && !n?.filtered;');
  });

  it('a sidebar pick of a filtered node turns Main only off before flying to it', () => {
    expect(FLY_TO_NODE).toContain('if (liftsFilter) dispatch(setMainOnly({ enabled: false }));');
    expect(FLY_TO_NODE).toContain('const liftsFilter = !!n.filtered;');
  });
});
