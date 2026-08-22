import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Rect, Viewport, panBy, MAX_INTERACTIVE, NODE_W, NODE_H } from '../../components/Canvas/canvasGeometry';
import { ArrangeResult } from '../../components/Canvas/canvasLayout';

/** A relationship between two terminals. Untyped by design — see design 010 §7.1. */
export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  label: string | null;
  origin: 'user' | 'agent';
  createdAt: number;
}

export interface CanvasPersisted {
  viewport: Viewport;
  nodes: Record<string, Rect>;
  groups: Record<string, Rect>;
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarZoom: number;
}

/**
 * Note what is NOT here: an `enabled` flag.
 *
 * Canvas Mode is a tab (`shellType === 'canvas'`, see `services/openCanvas.ts`), so
 * "is the canvas showing" is already a fact of `tabs` — `activeTab.shellType`. Keeping a
 * second copy of it here would be two sources of truth for one boolean, and every path
 * that switches tabs without going through the canvas helpers (a click in the strip,
 * Ctrl+Tab, closing the tab, session restore) would be a path that could desync them.
 */
export interface CanvasState extends CanvasPersisted {
  /** Mirror of the backend edge table; never persisted renderer-side. */
  edges: CanvasEdge[];
  selectedId: string | null;
  /**
   * The selected CONNECTION, or null.
   *
   * Mutually exclusive with `selectedId` and enforced in the reducers rather than by the
   * callers: <kbd>Delete</kbd> has to mean exactly one thing, and every one of the many
   * `selectNode` dispatches scattered through the canvas would otherwise be a place the
   * invariant could be forgotten. Selecting either clears the other.
   */
  selectedEdgeId: string | null;
  /** The node receiving keystrokes. Always granted a live terminal (design 010 D8). */
  focusedId: string | null;
  /** The node shown as a near-full-screen overlay on the canvas, or null.
   *
   *  Deliberately separate from `focusedId` even though opening an overlay also focuses:
   *  focus is "this node has the keyboard" and survives closing the overlay onto the same
   *  node, while this is "this node is enlarged". Folding them together would make Esc
   *  ambiguous — it has to close the overlay first and release the keyboard second. */
  overlayId: string | null;
  /** Most-recently-touched first; drives LOD budget priority. */
  recent: string[];
  /** The tab whose group sits nearest the viewport centre — the tab strip's "you are here"
   *  marker (design 010 D9, §5.1).
   *
   *  **Live-only, and NOT in `CanvasPersisted`.** It is derived from the viewport, so persisting
   *  it would store an answer to a question the next session re-asks on its first frame. It is
   *  also cleared on `CanvasMode`'s unmount: the marker means "the group you are looking at",
   *  and there is no such group once the canvas is not on screen.
   *
   *  This is a SECOND marker, never a replacement for the active-tab highlight. Under D1a the
   *  active tab genuinely is the canvas; moving the highlight off it would render the one tab
   *  filling the screen as inactive. */
  nearestGroupId: string | null;
}

export const SIDEBAR_MIN = 168;
export const SIDEBAR_MAX = 480;

/**
 * How far Ctrl+wheel may scale the sidebar's own text (Tam, 2026-08-21).
 *
 * Both ends are chosen against what the panel still has to DO rather than against what is
 * readable in isolation. Below ~0.7 a row's profile icon and its unseen-output bell stop being
 * distinguishable from each other, and the list stops working as the thing it exists for — a
 * scannable index of the workspace. Above ~1.8 a row is taller than the group heading it sits
 * under, and at the default 250px width almost every title ellipsises, so zooming in to read a
 * name is precisely what stops you reading it.
 *
 * Exported so the tests assert the real limits rather than a copy of these numbers, and so a
 * future settings control cannot invent a second pair.
 */
export const SIDEBAR_ZOOM_MIN = 0.7;
export const SIDEBAR_ZOOM_MAX = 1.8;

const initialState: CanvasState = {
  viewport: { x: 0, y: 0, z: 1 },
  nodes: {},
  groups: {},
  edges: [],
  sidebarOpen: true,
  sidebarWidth: 250,
  sidebarZoom: 1,
  selectedId: null,
  selectedEdgeId: null,
  focusedId: null,
  overlayId: null,
  recent: [],
  nearestGroupId: null,
};

const touch = (state: CanvasState, id: string) => {
  state.recent = [id, ...state.recent.filter((r) => r !== id)].slice(0, MAX_INTERACTIVE);
};

const clampWidth = (w: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));

/**
 * Clamp a sidebar zoom, rejecting NaN/Infinity rather than letting one through.
 *
 * `Math.max(min, Math.min(max, NaN))` is NaN — every comparison with NaN is false, so the
 * clamp that looks like it bounds this value silently does not. A NaN reaching the stylesheet
 * makes `calc(12px * var(--sidebar-k))` invalid, which drops the declaration and leaves the
 * panel at its inherited size, looking like the zoom simply stopped responding.
 */
const clampZoom = (z: number) =>
  (Number.isFinite(z) ? Math.max(SIDEBAR_ZOOM_MIN, Math.min(SIDEBAR_ZOOM_MAX, z)) : 1);

const canvasSlice = createSlice({
  name: 'canvas',
  initialState,
  reducers: {
    setViewport: (state, action: PayloadAction<Viewport>) => {
      state.viewport = action.payload;
    },
    /**
     * Slide the view by a screen-space delta — the arrow keys (Tam's item 3).
     *
     * RELATIVE rather than an absolute `setViewport`, so the caller never has to read the
     * viewport. That is what keeps the arrow handler a stable callback: the canvas listens for
     * arrows in the capture phase on `window`, and a handler that closed over `vp` would tear
     * that listener down and re-register it on every frame of a pan.
     */
    panViewport: (state, action: PayloadAction<{ dx: number; dy: number }>) => {
      state.viewport = panBy(state.viewport, action.payload.dx, action.payload.dy);
    },
    setNodeGeom: (state, action: PayloadAction<{ id: string; rect: Rect }>) => {
      state.nodes[action.payload.id] = action.payload.rect;
    },
    setGroupGeom: (state, action: PayloadAction<{ id: string; rect: Rect }>) => {
      state.groups[action.payload.id] = action.payload.rect;
    },
    /**
     * A group and every one of its members, in ONE transition.
     *
     * Dragging a group moved its frame and each member with a dispatch apiece, so a group
     * of 100 terminals produced 101 Redux transitions per `pointermove` — around 6,000
     * actions a second at a normal event rate, each one invalidating the canvas selector
     * and re-running projection and reconciliation WHILE the pointer was still moving.
     * The work is O(members × events), which is exactly the shape that misses a frame
     * budget on the workspaces big enough to want group drags.
     *
     * Rects are taken whole rather than merged with `prev` like `applyArrange` does: the
     * caller computed these FROM the current rects (`moveGroupBy`), so width and height
     * are already the live ones and re-reading them would only invite a stale mix.
     */
    moveGroupGeom: (
      state,
      action: PayloadAction<{ tabId: string; frame: Rect; nodes: Record<string, Rect> }>,
    ) => {
      state.groups[action.payload.tabId] = action.payload.frame;
      for (const [id, rect] of Object.entries(action.payload.nodes)) state.nodes[id] = rect;
    },
    applyArrange: (state, action: PayloadAction<ArrangeResult>) => {
      for (const [id, rect] of Object.entries(action.payload.groups)) state.groups[id] = rect;
      for (const [id, pos] of Object.entries(action.payload.nodes)) {
        const prev = state.nodes[id];
        state.nodes[id] = { x: pos.x, y: pos.y, w: prev?.w ?? NODE_W, h: prev?.h ?? NODE_H };
      }
    },
    selectNode: (state, action: PayloadAction<string | null>) => {
      state.selectedId = action.payload;
      // Unconditionally, including for `null`: clearing the selection means clearing it. The
      // background pointerdown dispatches exactly that and would otherwise leave a wire
      // selected — and armed for Delete — on a canvas showing nothing selected.
      state.selectedEdgeId = null;
      if (action.payload) touch(state, action.payload);
    },
    /** Select a connection, or clear with `null`. Takes the selection off any node — see
     *  `selectedEdgeId`. */
    selectEdge: (state, action: PayloadAction<string | null>) => {
      state.selectedEdgeId = action.payload;
      if (action.payload) state.selectedId = null;
    },
    focusNode: (state, action: PayloadAction<string | null>) => {
      state.focusedId = action.payload;
      if (action.payload) touch(state, action.payload);
    },
    touchNode: (state, action: PayloadAction<string>) => { touch(state, action.payload); },
    /** Open the full-screen overlay on a node, or close it with `null`.
     *
     *  Opening also focuses: an overlay you cannot type into is a screenshot. Closing hands
     *  the keyboard BACK, and that is a reversal of what this comment used to claim — that
     *  "you were working in that terminal a moment ago" and so should keep it.
     *
     *  It was wrong because the DOM had already decided otherwise. Every close path blurs
     *  xterm's textarea before this reducer runs: the backdrop and the header toggle because a
     *  pointerdown elsewhere moves focus off it, `Ctrl+Shift+E` because it blurs by hand. So a
     *  surviving `focusedId` named a terminal that did not have the keyboard — and
     *  `CanvasMode` opens its canvas-key listener with `if (focusedId) return`, reading that
     *  stale id as "a terminal is typing". One overlay round trip and the canvas went deaf to
     *  every key it owns: E, Tab, the arrows, Shift+1, Ctrl+-/+.
     *
     *  Guarded on `focusedId === overlayId` rather than clearing unconditionally, so this only
     *  ever takes back the focus it granted. Nothing else grants focus today, but an
     *  unconditional clear would make this the line that silently breaks the first thing that
     *  does. */
    setOverlayNode: (state, action: PayloadAction<string | null>) => {
      if (action.payload === null && state.focusedId === state.overlayId) {
        state.focusedId = null;
      }
      state.overlayId = action.payload;
      if (action.payload) {
        state.focusedId = action.payload;
        touch(state, action.payload);
      }
    },
    setEdges: (state, action: PayloadAction<CanvasEdge[]>) => {
      state.edges = action.payload;
      // A selection that survived a wholesale replacement would name an edge that is no longer
      // there: the handles have nowhere to draw and Delete aims at a row the server has already
      // forgotten. Selection follows existence.
      if (state.selectedEdgeId && !action.payload.some((e) => e.id === state.selectedEdgeId)) {
        state.selectedEdgeId = null;
      }
    },
    addEdge: (state, action: PayloadAction<CanvasEdge>) => {
      const e = action.payload;
      // Ordered pair: A→B and B→A are distinct and both meaningful.
      if (state.edges.some((x) => x.from === e.from && x.to === e.to)) return;
      state.edges.push(e);
    },
    removeEdge: (state, action: PayloadAction<string>) => {
      state.edges = state.edges.filter((e) => e.id !== action.payload);
      if (state.selectedEdgeId === action.payload) state.selectedEdgeId = null;
    },
    /** Replace one edge with the row the server stored — the label edit path (Task 18).
     *  Ignores an id it does not hold rather than inserting: an edge this window has never
     *  seen arrives through `setEdges`/`addEdge`, and appending here would let a PATCH
     *  response resurrect an edge deleted in the meantime. */
    updateEdge: (state, action: PayloadAction<CanvasEdge>) => {
      const i = state.edges.findIndex((e) => e.id === action.payload.id);
      if (i >= 0) state.edges[i] = action.payload;
    },
    /** The group nearest the viewport centre, for the tab strip's marker. `null` clears it —
     *  which is what leaving the canvas does. */
    setNearestGroup: (state, action: PayloadAction<string | null>) => {
      state.nearestGroupId = action.payload;
    },
    setSidebarOpen: (state, action: PayloadAction<boolean>) => {
      state.sidebarOpen = action.payload;
    },
    setSidebarWidth: (state, action: PayloadAction<number>) => {
      state.sidebarWidth = clampWidth(action.payload);
    },
    /** Ctrl/Cmd+wheel over the sidebar. An absolute factor, not a delta: the caller already
     *  holds the current value, and a reducer that accumulated would drift under the two
     *  wheel events a trackpad sends per notch. */
    setSidebarZoom: (state, action: PayloadAction<number>) => {
      state.sidebarZoom = clampZoom(action.payload);
    },
    pruneCanvasGeometry: (
      state,
      action: PayloadAction<{ terminalIds: string[]; tabIds: string[] }>
    ) => {
      const liveNodes = new Set(action.payload.terminalIds);
      const liveGroups = new Set(action.payload.tabIds);
      for (const id of Object.keys(state.nodes)) if (!liveNodes.has(id)) delete state.nodes[id];
      for (const id of Object.keys(state.groups)) if (!liveGroups.has(id)) delete state.groups[id];
      // Assigned only when it actually shrank. `filter` always returns a NEW array, and
      // Immer treats that assignment as a change — which would hand every subscriber a new
      // state object on a prune that pruned nothing. That was harmless while this ran only
      // on tab close; it runs on every pane close now, so the no-op has to be a real no-op.
      const liveRecent = state.recent.filter((id) => liveNodes.has(id));
      if (liveRecent.length !== state.recent.length) state.recent = liveRecent;
      if (state.selectedId && !liveNodes.has(state.selectedId)) state.selectedId = null;
      if (state.focusedId && !liveNodes.has(state.focusedId)) state.focusedId = null;
      // A closed terminal must not leave the canvas covered by an overlay of nothing.
      if (state.overlayId && !liveNodes.has(state.overlayId)) state.overlayId = null;
      // Same reasoning one level up: a marker on a tab that has been closed points at a group
      // the canvas no longer draws. Checked against `liveGroups`, not `liveNodes` — this one
      // names a TAB, and the two id spaces overlap without being interchangeable (design 011 D7).
      if (state.nearestGroupId && !liveGroups.has(state.nearestGroupId)) state.nearestGroupId = null;
    },
    /** Restore persisted geometry. Deliberately does NOT restore `focusedId`: whether the
     *  canvas is on screen at boot is decided by the restored TAB list, and a node that
     *  was holding keystrokes in the last session must not silently hold them again
     *  before the user has looked at it. */
    hydrateCanvas: (state, action: PayloadAction<Partial<CanvasPersisted>>) => {
      const p = action.payload;
      if (p.viewport) state.viewport = p.viewport;
      if (p.nodes) state.nodes = p.nodes;
      if (p.groups) state.groups = p.groups;
      if (typeof p.sidebarOpen === 'boolean') state.sidebarOpen = p.sidebarOpen;
      if (typeof p.sidebarWidth === 'number') state.sidebarWidth = clampWidth(p.sidebarWidth);
      if (typeof p.sidebarZoom === 'number') state.sidebarZoom = clampZoom(p.sidebarZoom);
    },
  },
});

export const {
  setViewport, panViewport, setNodeGeom, setGroupGeom, moveGroupGeom,
  applyArrange, selectNode, selectEdge, focusNode, touchNode, setOverlayNode, setEdges, addEdge,
  removeEdge, updateEdge, setNearestGroup,
  setSidebarOpen, setSidebarWidth, setSidebarZoom, pruneCanvasGeometry, hydrateCanvas,
} = canvasSlice.actions;

export default canvasSlice.reducer;
