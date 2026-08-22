import canvasReducer, {
  setViewport, panViewport, setNodeGeom, setGroupGeom, moveGroupGeom,
  applyArrange, selectNode, selectEdge, focusNode, touchNode, setOverlayNode, setEdges, addEdge,
  removeEdge, updateEdge, setNearestGroup,
  setSidebarOpen, setSidebarWidth, setSidebarZoom, SIDEBAR_ZOOM_MIN, SIDEBAR_ZOOM_MAX,
  pruneCanvasGeometry, hydrateCanvas, CanvasEdge,
} from '../canvasSlice';
import { MAX_INTERACTIVE } from '../../../components/Canvas/canvasGeometry';

const init = () => canvasReducer(undefined, { type: '@@init' });
const edge = (id: string, from: string, to: string): CanvasEdge =>
  ({ id, from, to, label: null, origin: 'user', createdAt: 1 });

describe('canvasSlice', () => {
  it('starts at an identity viewport', () => {
    const s = init();
    expect(s.viewport).toEqual({ x: 0, y: 0, z: 1 });
    expect(s.focusedId).toBeNull();
  });

  // Canvas Mode is a TAB, so whether it is on screen is `activeTab.shellType` and lives in
  // the tabs slice alone. This slice used to carry an `enabled` mirror of that; keeping
  // both would mean every tab switch that does not go through the canvas helpers — a click
  // in the strip, Ctrl+Tab, closing the tab, session restore — is a path that can desync
  // them. Asserted structurally, so re-adding the flag fails here rather than quietly
  // reintroducing the second source of truth.
  it('carries no enabled flag — the tab list is the only source of that truth', () => {
    expect(init()).not.toHaveProperty('enabled');
    expect(Object.keys(canvasReducer(init(), { type: '@@probe' }))).not.toContain('enabled');
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

  /**
   * The arrow keys pan RELATIVELY, which is the point: the handler that dispatches this listens
   * on the window in the capture phase, and one that had to read `viewport` first would be torn
   * down and re-registered on every frame of a mouse pan.
   */
  it('pans the viewport by a screen delta without being told where it was', () => {
    let s = canvasReducer(init(), setViewport({ x: -12, y: 34, z: 0.75 }));
    s = canvasReducer(s, panViewport({ dx: 96, dy: -40 }));
    // Right and up on screen means the world moves the other way — `panBy` owns the inversion,
    // and this asserts the reducer actually goes through it rather than adding.
    expect(s.viewport).toEqual({ x: -12 - 96, y: 34 + 40, z: 0.75 });
  });

  it('accumulates across presses and leaves the zoom alone', () => {
    let s = canvasReducer(init(), setViewport({ x: 0, y: 0, z: 0.4 }));
    for (let i = 0; i < 3; i++) s = canvasReducer(s, panViewport({ dx: 10, dy: 0 }));
    expect(s.viewport).toEqual({ x: -30, y: 0, z: 0.4 });
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

  it('updates an edge in place, preserving order', () => {
    let s = canvasReducer(init(), setEdges([edge('ce-1', 'a', 'b'), edge('ce-2', 'c', 'd')]));
    s = canvasReducer(s, updateEdge({ ...edge('ce-1', 'a', 'b'), label: 'deploys to' }));
    expect(s.edges.map((e) => e.id)).toEqual(['ce-1', 'ce-2']);
    expect(s.edges[0].label).toBe('deploys to');
  });

  it('ignores an update for an edge it does not hold, rather than inserting it', () => {
    // A PATCH response racing a delete would otherwise resurrect the wire: the label edit
    // succeeds server-side, the delete lands first here, and appending on update puts it back
    // with no row behind it.
    let s = canvasReducer(init(), setEdges([edge('ce-1', 'a', 'b')]));
    s = canvasReducer(s, updateEdge({ ...edge('ce-9', 'x', 'y'), label: 'ghost' }));
    expect(s.edges.map((e) => e.id)).toEqual(['ce-1']);
  });

  it('clamps sidebar width', () => {
    expect(canvasReducer(init(), setSidebarWidth(10)).sidebarWidth).toBe(168);
    expect(canvasReducer(init(), setSidebarWidth(9999)).sidebarWidth).toBe(480);
    expect(canvasReducer(init(), setSidebarWidth(300)).sidebarWidth).toBe(300);
  });

  it('clamps sidebar zoom', () => {
    expect(canvasReducer(init(), setSidebarZoom(0.1)).sidebarZoom).toBe(SIDEBAR_ZOOM_MIN);
    expect(canvasReducer(init(), setSidebarZoom(9)).sidebarZoom).toBe(SIDEBAR_ZOOM_MAX);
    expect(canvasReducer(init(), setSidebarZoom(1.25)).sidebarZoom).toBeCloseTo(1.25, 9);
  });

  /**
   * NaN survives `Math.max(min, Math.min(max, v))` — every comparison with NaN is false, so the
   * clamp that looks like it bounds this value does not. Left in, it reaches the stylesheet as
   * `calc(12px * NaN)`, CSS drops the whole declaration, and the panel silently stops responding
   * to the wheel entirely. The wheel handler multiplies the previous value, so ONE bad value
   * poisons every notch after it.
   */
  it.each([NaN, Infinity, -Infinity])('refuses a non-finite sidebar zoom (%p)', (bad) => {
    const z = canvasReducer(init(), setSidebarZoom(bad)).sidebarZoom;
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBe(1);
  });

  it('hydrates a persisted sidebar zoom, clamped', () => {
    expect(canvasReducer(init(), hydrateCanvas({ sidebarZoom: 1.4 })).sidebarZoom).toBeCloseTo(1.4, 9);
    expect(canvasReducer(init(), hydrateCanvas({ sidebarZoom: 99 })).sidebarZoom).toBe(SIDEBAR_ZOOM_MAX);
    // Absent from an older blob: the panel stays at natural size rather than collapsing to 0.
    expect(canvasReducer(init(), hydrateCanvas({})).sidebarZoom).toBe(1);
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

  it('hydrates persisted geometry but never persisted focus state', () => {
    const s = canvasReducer(init(), hydrateCanvas({
      viewport: { x: 5, y: 6, z: 0.5 },
      nodes: { 'tm-1': { x: 1, y: 1, w: 340, h: 210 } },
      groups: {},
      sidebarOpen: false,
      sidebarWidth: 220,
    }));
    expect(s.viewport.z).toBe(0.5);
    expect(s.sidebarWidth).toBe(220);
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

  // `focusedId` is the one piece of canvas state that grants a node an unconditional
  // WebGL context (design 010 D8), and nothing in `hydrateCanvas` should be able to set
  // it: a restored session must not be handing keystrokes to a node before the user has
  // looked at the canvas.
  it('cannot set focus through hydration, even over live focus', () => {
    let s = canvasReducer(init(), focusNode('tm-1'));
    s = canvasReducer(s, hydrateCanvas({ viewport: { x: 1, y: 2, z: 1.5 } } as never));
    expect(s.viewport.z).toBe(1.5);
    expect(s.focusedId).toBe('tm-1'); // untouched either way — hydrate owns geometry only
  });

  /**
   * The full-screen overlay. Kept separate from `focusedId` on purpose: focus is "this node
   * has the keyboard", the overlay is "this node is enlarged", and Esc has to unwind them in
   * that order — close the overlay, then release the keyboard.
   */
  describe('setOverlayNode', () => {
    it('opens the overlay and gives the node the keyboard with it', () => {
      const s = canvasReducer(init(), setOverlayNode('tm-1'));
      expect(s.overlayId).toBe('tm-1');
      // An overlay you cannot type into is a screenshot.
      expect(s.focusedId).toBe('tm-1');
      expect(s.recent[0]).toBe('tm-1');
    });

    /**
     * Closing hands the keyboard back to the canvas.
     *
     * This REVERSES the rule that used to live here ("closes without taking the keyboard
     * away"), and the reversal is the bug fix: every close path -- the backdrop, the header
     * toggle and Ctrl+Shift+E -- has already blurred xterm's textarea in the DOM by the time
     * this reducer runs. A surviving `focusedId` therefore named a terminal that did not have
     * the keyboard, and `CanvasMode`'s `if (focusedId) return` read it as "a terminal is
     * typing" and went deaf to every canvas key: E, Tab, the arrows, Shift+1, Ctrl+-/+.
     *
     * The symptom that reached us was `E` working exactly once per canvas visit. It was never
     * about E -- after one overlay round trip the canvas keyboard was gone entirely, and the
     * only ways back were Esc or a click on empty canvas, neither of which anybody guesses.
     */
    it('closes and hands the keyboard back to the canvas', () => {
      let s = canvasReducer(init(), setOverlayNode('tm-1'));
      s = canvasReducer(s, setOverlayNode(null));
      expect(s.overlayId).toBeNull();
      expect(s.focusedId).toBeNull();
    });

    /**
     * It only takes back the focus it granted.
     *
     * `focusedId === overlayId` rather than an unconditional clear, so a node holding the
     * keyboard for some other reason keeps it. Nothing grants focus that way today -- the
     * overlay is the only door -- but an unconditional clear would make this reducer the thing
     * that silently breaks the first feature that does.
     */
    it('leaves a focus it did not grant alone', () => {
      let s = canvasReducer(init(), setOverlayNode('tm-1'));
      s = canvasReducer(s, focusNode('tm-other'));
      s = canvasReducer(s, setOverlayNode(null));
      expect(s.overlayId).toBeNull();
      expect(s.focusedId).toBe('tm-other');
    });

    it('starts closed', () => {
      expect(init().overlayId).toBeNull();
    });

    // A terminal can close while its node is the overlay — the tab strip is still live on the
    // canvas. Leaving the id set would cover the canvas with an overlay of nothing.
    it('is cleared when its terminal goes away', () => {
      let s = canvasReducer(init(), setOverlayNode('tm-gone'));
      s = canvasReducer(s, pruneCanvasGeometry({ terminalIds: ['tm-other'], tabIds: [] }));
      expect(s.overlayId).toBeNull();
    });

    it('survives a prune that keeps its terminal', () => {
      let s = canvasReducer(init(), setOverlayNode('tm-live'));
      s = canvasReducer(s, pruneCanvasGeometry({ terminalIds: ['tm-live'], tabIds: [] }));
      expect(s.overlayId).toBe('tm-live');
    });
  });
});

describe('nearestGroupId — the tab strip marker (design 010 D9, §5.1)', () => {
  it('holds the group the canvas is looking at, and null clears it', () => {
    let s = canvasReducer(init(), setNearestGroup('tb-a'));
    expect(s.nearestGroupId).toBe('tb-a');
    // What CanvasMode's unmount dispatches. A marker that outlived the canvas would sit on
    // the strip pointing at a group nobody is looking at.
    s = canvasReducer(s, setNearestGroup(null));
    expect(s.nearestGroupId).toBeNull();
  });

  it('is dropped when its tab closes', () => {
    let s = canvasReducer(init(), setNearestGroup('tb-gone'));
    s = canvasReducer(s, pruneCanvasGeometry({ terminalIds: [], tabIds: ['tb-live'] }));
    expect(s.nearestGroupId).toBeNull();
  });

  it('survives a prune that keeps its tab', () => {
    // Paired with the case above so "always null after a prune" cannot pass both.
    let s = canvasReducer(init(), setNearestGroup('tb-live'));
    s = canvasReducer(s, pruneCanvasGeometry({ terminalIds: [], tabIds: ['tb-live'] }));
    expect(s.nearestGroupId).toBe('tb-live');
  });

  it('is checked against TABS, not terminals', () => {
    // The two id spaces overlap without being interchangeable (design 011 D7). Checking this
    // against `terminalIds` would clear the marker for every group whose tab id is not also a
    // live leaf id — i.e. every split tab.
    let s = canvasReducer(init(), setNearestGroup('tb-split'));
    s = canvasReducer(s, pruneCanvasGeometry({ terminalIds: ['tm-1', 'tm-2'], tabIds: ['tb-split'] }));
    expect(s.nearestGroupId).toBe('tb-split');
  });

  it('is never persisted, so a session cannot boot with a stale marker', () => {
    // `hydrateCanvas` takes a Partial<CanvasPersisted>, and `nearestGroupId` is deliberately
    // not one of its fields — this asserts the restore path cannot set it even if a blob
    // written by some future build carried the key.
    let s = canvasReducer(init(), setNearestGroup('tb-a'));
    s = canvasReducer(s, hydrateCanvas({ nearestGroupId: 'tb-b' } as never));
    expect(s.nearestGroupId).toBe('tb-a');
  });
});

/**
 * Selecting a connection — the state behind "click the line, then delete it".
 *
 * The invariant that matters is that a node and a wire are never both selected. It is enforced
 * in the reducers rather than by the callers because <kbd>Delete</kbd> has to mean exactly one
 * thing, and `selectNode` is dispatched from a dozen places on this surface — every one of them
 * a place the rule could be forgotten.
 */
describe('connection selection', () => {
  it('starts with nothing selected', () => {
    expect(init().selectedEdgeId).toBeNull();
  });

  it('selects and clears a connection', () => {
    let s = canvasReducer(init(), selectEdge('ce-1'));
    expect(s.selectedEdgeId).toBe('ce-1');
    s = canvasReducer(s, selectEdge(null));
    expect(s.selectedEdgeId).toBeNull();
  });

  it('takes the selection off a node', () => {
    let s = canvasReducer(init(), selectNode('tm-1'));
    s = canvasReducer(s, selectEdge('ce-1'));
    expect(s.selectedId).toBeNull();
    expect(s.selectedEdgeId).toBe('ce-1');
  });

  it('takes the selection off a connection', () => {
    let s = canvasReducer(init(), selectEdge('ce-1'));
    s = canvasReducer(s, selectNode('tm-1'));
    expect(s.selectedEdgeId).toBeNull();
    expect(s.selectedId).toBe('tm-1');
  });

  /** A press on empty canvas dispatches `selectNode(null)` and nothing else. If that did not
   *  clear the wire too, the canvas would show nothing selected while Delete still removed a
   *  connection. */
  it('clears the connection when the node selection is cleared', () => {
    let s = canvasReducer(init(), selectEdge('ce-1'));
    s = canvasReducer(s, selectNode(null));
    expect(s.selectedEdgeId).toBeNull();
  });

  it('never leaves both selected, whatever the order', () => {
    let s = init();
    for (const action of [
      selectNode('tm-1'), selectEdge('ce-1'), selectEdge('ce-2'), selectNode('tm-2'),
      selectNode(null), selectEdge('ce-3'),
    ]) {
      s = canvasReducer(s, action);
      expect({ node: s.selectedId, edge: s.selectedEdgeId }.node !== null
        && s.selectedEdgeId !== null).toBe(false);
    }
  });

  it('drops a selection whose connection was removed', () => {
    let s = canvasReducer(init(), setEdges([edge('ce-1', 'a', 'b'), edge('ce-2', 'b', 'c')]));
    s = canvasReducer(s, selectEdge('ce-1'));
    s = canvasReducer(s, removeEdge('ce-2'));
    expect(s.selectedEdgeId).toBe('ce-1');          // someone else's removal is not ours
    s = canvasReducer(s, removeEdge('ce-1'));
    expect(s.selectedEdgeId).toBeNull();
  });

  /** The graph is refetched wholesale on every canvas session. A selection that survived would
   *  name a row that no longer exists: the handles have nowhere to draw and Delete aims at
   *  nothing. */
  it('drops a selection the refetched graph no longer contains', () => {
    let s = canvasReducer(init(), setEdges([edge('ce-1', 'a', 'b')]));
    s = canvasReducer(s, selectEdge('ce-1'));
    s = canvasReducer(s, setEdges([edge('ce-1', 'a', 'b'), edge('ce-9', 'c', 'd')]));
    expect(s.selectedEdgeId).toBe('ce-1');          // still there, still selected
    s = canvasReducer(s, setEdges([edge('ce-9', 'c', 'd')]));
    expect(s.selectedEdgeId).toBeNull();
  });
});

/**
 * A group drag used to be one dispatch per member per pointer event — 101 Redux transitions
 * per event for a 100-terminal group, each invalidating the canvas selector and re-running
 * projection while the pointer was still moving.
 */
describe('moveGroupGeom', () => {
  const rect = (x: number, y: number) => ({ x, y, w: 340, h: 210 });

  it('moves the frame and every member in one transition', () => {
    let s = init();
    s = canvasReducer(s, setGroupGeom({ id: 'tb-1', rect: rect(0, 0) }));
    s = canvasReducer(s, setNodeGeom({ id: 'tm-a', rect: rect(10, 10) }));
    s = canvasReducer(s, setNodeGeom({ id: 'tm-b', rect: rect(10, 300) }));

    s = canvasReducer(s, moveGroupGeom({
      tabId: 'tb-1',
      frame: rect(100, 100),
      nodes: { 'tm-a': rect(110, 110), 'tm-b': rect(110, 400) },
    }));

    expect(s.groups['tb-1']).toEqual(rect(100, 100));
    expect(s.nodes['tm-a']).toEqual(rect(110, 110));
    expect(s.nodes['tm-b']).toEqual(rect(110, 400));
  });

  // Only the named members move. A group drag must not disturb a node in another group.
  it('leaves nodes it was not given alone', () => {
    let s = init();
    s = canvasReducer(s, setNodeGeom({ id: 'tm-other', rect: rect(5, 5) }));
    s = canvasReducer(s, moveGroupGeom({
      tabId: 'tb-1', frame: rect(0, 0), nodes: { 'tm-a': rect(1, 1) },
    }));
    expect(s.nodes['tm-other']).toEqual(rect(5, 5));
  });

  // Rects are taken WHOLE, unlike `applyArrange` which merges width/height from the previous
  // entry. The caller derived these from the current rects, so re-reading would only mix a
  // stale size into a fresh position.
  it('takes the rect whole rather than merging the previous size', () => {
    let s = init();
    s = canvasReducer(s, setNodeGeom({ id: 'tm-a', rect: { x: 0, y: 0, w: 999, h: 999 } }));
    s = canvasReducer(s, moveGroupGeom({
      tabId: 'tb-1', frame: rect(0, 0), nodes: { 'tm-a': rect(2, 2) },
    }));
    expect(s.nodes['tm-a']).toEqual(rect(2, 2));
  });
});

/**
 * The prune now runs on every pane close, not only when a tab disappears, so a run that
 * finds nothing stale has to be a real no-op. `recent` was the one field that failed that:
 * `filter` always returns a NEW array, and Immer reads the assignment as a change — handing
 * every subscriber a fresh state object for a prune that pruned nothing.
 */
describe('pruneCanvasGeometry is inert when nothing is stale', () => {
  it('returns the identical state object', () => {
    let s = init();
    s = canvasReducer(s, setNodeGeom({ id: 'tm-live', rect: { x: 0, y: 0, w: 1, h: 1 } }));
    s = canvasReducer(s, touchNode('tm-live'));
    const before = s;
    const after = canvasReducer(s, pruneCanvasGeometry({
      terminalIds: ['tm-live'], tabIds: [],
    }));
    expect(after).toBe(before);
  });

  // ...and it still prunes when there IS something to prune, or the test above would pass
  // on a reducer that had stopped working entirely.
  it('still drops a dead id from recent', () => {
    let s = init();
    s = canvasReducer(s, touchNode('tm-gone'));
    s = canvasReducer(s, touchNode('tm-live'));
    s = canvasReducer(s, pruneCanvasGeometry({ terminalIds: ['tm-live'], tabIds: [] }));
    expect(s.recent).toEqual(['tm-live']);
  });
});
