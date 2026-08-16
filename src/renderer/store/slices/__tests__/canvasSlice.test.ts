import canvasReducer, {
  setCanvasEnabled, toggleCanvasMode, setViewport, setNodeGeom, setGroupGeom,
  applyArrange, selectNode, focusNode, touchNode, setEdges, addEdge, removeEdge,
  setSidebarOpen, setSidebarWidth, pruneCanvasGeometry, hydrateCanvas, CanvasEdge,
} from '../canvasSlice';
import { MAX_INTERACTIVE } from '../../../components/Canvas/canvasGeometry';

const init = () => canvasReducer(undefined, { type: '@@init' });
const edge = (id: string, from: string, to: string): CanvasEdge =>
  ({ id, from, to, label: null, origin: 'user', createdAt: 1 });

describe('canvasSlice', () => {
  it('starts disabled with an identity viewport', () => {
    const s = init();
    expect(s.enabled).toBe(false);
    expect(s.viewport).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('toggles and sets mode', () => {
    let s = canvasReducer(init(), toggleCanvasMode());
    expect(s.enabled).toBe(true);
    s = canvasReducer(s, toggleCanvasMode());
    expect(s.enabled).toBe(false);
    s = canvasReducer(s, setCanvasEnabled(true));
    expect(s.enabled).toBe(true);
  });

  it('clears focus when leaving canvas mode', () => {
    let s = canvasReducer(init(), setCanvasEnabled(true));
    s = canvasReducer(s, focusNode('tm-1'));
    expect(s.focusedId).toBe('tm-1');
    s = canvasReducer(s, setCanvasEnabled(false));
    expect(s.focusedId).toBeNull();
  });

  // Both exits from canvas mode must hand input back, not just the explicit one.
  it('clears focus when TOGGLING out of canvas mode too', () => {
    let s = canvasReducer(init(), setCanvasEnabled(true));
    s = canvasReducer(s, focusNode('tm-1'));
    s = canvasReducer(s, toggleCanvasMode());
    expect(s.enabled).toBe(false);
    expect(s.focusedId).toBeNull();
  });

  it('stores node and group geometry', () => {
    let s = canvasReducer(init(), setNodeGeom({ id: 'tm-1', rect: { x: 1, y: 2, w: 340, h: 210 } }));
    s = canvasReducer(s, setGroupGeom({ id: 'tb-1', rect: { x: 0, y: 0, w: 400, h: 300 } }));
    expect(s.nodes['tm-1'].x).toBe(1);
    expect(s.groups['tb-1'].w).toBe(400);
  });

  it('stores the viewport', () => {
    const s = canvasReducer(init(), setViewport({ x: -12, y: 34, z: 0.75 }));
    expect(s.viewport).toEqual({ x: -12, y: 34, z: 0.75 });
  });

  it('applies an arrange result wholesale, preserving node size', () => {
    let s = canvasReducer(init(), setNodeGeom({ id: 'n1', rect: { x: 0, y: 0, w: 340, h: 210 } }));
    s = canvasReducer(s, applyArrange({
      groups: { 'tb-a': { x: 10, y: 20, w: 500, h: 400 } },
      nodes: { n1: { x: 40, y: 66 } },
    }));
    expect(s.nodes['n1']).toEqual({ x: 40, y: 66, w: 340, h: 210 });
    expect(s.groups['tb-a']).toEqual({ x: 10, y: 20, w: 500, h: 400 });
  });

  // A node arranged before it ever had geometry must still get a usable size.
  it('gives an unknown node the default size when arranging it', () => {
    const s = canvasReducer(init(), applyArrange({
      groups: {}, nodes: { fresh: { x: 5, y: 7 } },
    }));
    expect(s.nodes['fresh']).toEqual({ x: 5, y: 7, w: 340, h: 210 });
  });

  it('keeps `recent` most-recent-first, deduped and bounded', () => {
    let s = init();
    s = canvasReducer(s, touchNode('a'));
    s = canvasReducer(s, touchNode('b'));
    s = canvasReducer(s, touchNode('a'));
    expect(s.recent.slice(0, 2)).toEqual(['a', 'b']);
    expect(s.recent.filter((x) => x === 'a')).toHaveLength(1);
    for (let i = 0; i < MAX_INTERACTIVE + 20; i++) s = canvasReducer(s, touchNode(`n${i}`));
    expect(s.recent.length).toBeLessThanOrEqual(MAX_INTERACTIVE);
  });

  it('selecting a node also touches it', () => {
    const s = canvasReducer(init(), selectNode('tm-9'));
    expect(s.selectedId).toBe('tm-9');
    expect(s.recent[0]).toBe('tm-9');
  });

  it('focusing a node also touches it, and clearing selection touches nothing', () => {
    let s = canvasReducer(init(), focusNode('tm-4'));
    expect(s.recent[0]).toBe('tm-4');
    s = canvasReducer(s, selectNode(null));
    expect(s.selectedId).toBeNull();
    expect(s.recent[0]).toBe('tm-4');
  });

  it('manages edges without duplicating a directed pair', () => {
    let s = canvasReducer(init(), setEdges([edge('ce-1', 'a', 'b')]));
    s = canvasReducer(s, addEdge(edge('ce-2', 'a', 'b')));
    expect(s.edges).toHaveLength(1);
    s = canvasReducer(s, addEdge(edge('ce-3', 'b', 'a')));
    expect(s.edges).toHaveLength(2); // reverse direction is a distinct edge
    s = canvasReducer(s, removeEdge('ce-1'));
    expect(s.edges.map((e) => e.id)).toEqual(['ce-3']);
  });

  it('clamps sidebar width', () => {
    expect(canvasReducer(init(), setSidebarWidth(10)).sidebarWidth).toBe(168);
    expect(canvasReducer(init(), setSidebarWidth(9999)).sidebarWidth).toBe(480);
    expect(canvasReducer(init(), setSidebarWidth(300)).sidebarWidth).toBe(300);
  });

  it('opens and closes the sidebar', () => {
    expect(canvasReducer(init(), setSidebarOpen(false)).sidebarOpen).toBe(false);
  });

  it('prunes geometry for terminals and tabs that no longer exist', () => {
    let s = init();
    s = canvasReducer(s, setNodeGeom({ id: 'tm-live', rect: { x: 0, y: 0, w: 340, h: 210 } }));
    s = canvasReducer(s, setNodeGeom({ id: 'tm-dead', rect: { x: 0, y: 0, w: 340, h: 210 } }));
    s = canvasReducer(s, setGroupGeom({ id: 'tb-live', rect: { x: 0, y: 0, w: 1, h: 1 } }));
    s = canvasReducer(s, setGroupGeom({ id: 'tb-dead', rect: { x: 0, y: 0, w: 1, h: 1 } }));
    s = canvasReducer(s, pruneCanvasGeometry({ terminalIds: ['tm-live'], tabIds: ['tb-live'] }));
    expect(Object.keys(s.nodes)).toEqual(['tm-live']);
    expect(Object.keys(s.groups)).toEqual(['tb-live']);
  });

  // Pruning also has to clear the three references INTO the node set. Without
  // this the geometry is gone but `recent` still nominates a dead id for the
  // GPU budget, and `focusedId` still points at a node nothing will render.
  it('prunes recent, selection and focus along with the geometry', () => {
    let s = init();
    s = canvasReducer(s, setNodeGeom({ id: 'tm-live', rect: { x: 0, y: 0, w: 340, h: 210 } }));
    s = canvasReducer(s, setNodeGeom({ id: 'tm-dead', rect: { x: 0, y: 0, w: 340, h: 210 } }));
    s = canvasReducer(s, touchNode('tm-live'));
    s = canvasReducer(s, selectNode('tm-dead'));
    s = canvasReducer(s, focusNode('tm-dead'));
    s = canvasReducer(s, pruneCanvasGeometry({ terminalIds: ['tm-live'], tabIds: [] }));
    expect(s.recent).toEqual(['tm-live']);
    expect(s.selectedId).toBeNull();
    expect(s.focusedId).toBeNull();
  });

  it('leaves a live selection and focus alone when pruning', () => {
    let s = canvasReducer(init(), setNodeGeom({ id: 'tm-live', rect: { x: 0, y: 0, w: 340, h: 210 } }));
    s = canvasReducer(s, selectNode('tm-live'));
    s = canvasReducer(s, focusNode('tm-live'));
    s = canvasReducer(s, pruneCanvasGeometry({ terminalIds: ['tm-live'], tabIds: [] }));
    expect(s.selectedId).toBe('tm-live');
    expect(s.focusedId).toBe('tm-live');
  });

  it('hydrates persisted geometry but never persisted enabled/focus state', () => {
    const s = canvasReducer(init(), hydrateCanvas({
      viewport: { x: 5, y: 6, z: 0.5 },
      nodes: { 'tm-1': { x: 1, y: 1, w: 340, h: 210 } },
      groups: {},
      sidebarOpen: false,
      sidebarWidth: 220,
    }));
    expect(s.viewport.z).toBe(0.5);
    expect(s.sidebarWidth).toBe(220);
    expect(s.enabled).toBe(false);
    expect(s.focusedId).toBeNull();
  });

  // Persisted state is read from disk and can be old, partial, or out of range.
  it('clamps a persisted sidebar width and ignores absent fields', () => {
    let s = canvasReducer(init(), setSidebarOpen(false));
    s = canvasReducer(s, hydrateCanvas({ sidebarWidth: 9999 }));
    expect(s.sidebarWidth).toBe(480);
    expect(s.sidebarOpen).toBe(false); // not in the payload — must be left alone
    expect(s.viewport).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('hydrating over a live canvas does not re-enable it', () => {
    let s = canvasReducer(init(), setCanvasEnabled(true));
    s = canvasReducer(s, hydrateCanvas({ viewport: { x: 1, y: 2, z: 1.5 } }));
    expect(s.enabled).toBe(true); // hydrate must not touch the flag either way
    expect(s.viewport.z).toBe(1.5);
  });
});
