import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { Rect, Viewport, MAX_INTERACTIVE, NODE_W, NODE_H } from '../../components/Canvas/canvasGeometry';
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
}

export const SIDEBAR_MIN = 168;
export const SIDEBAR_MAX = 480;

const initialState: CanvasState = {
  viewport: { x: 0, y: 0, z: 1 },
  nodes: {},
  groups: {},
  edges: [],
  sidebarOpen: true,
  sidebarWidth: 250,
  selectedId: null,
  focusedId: null,
  overlayId: null,
  recent: [],
};

const touch = (state: CanvasState, id: string) => {
  state.recent = [id, ...state.recent.filter((r) => r !== id)].slice(0, MAX_INTERACTIVE);
};

const clampWidth = (w: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));

const canvasSlice = createSlice({
  name: 'canvas',
  initialState,
  reducers: {
    setViewport: (state, action: PayloadAction<Viewport>) => {
      state.viewport = action.payload;
    },
    setNodeGeom: (state, action: PayloadAction<{ id: string; rect: Rect }>) => {
      state.nodes[action.payload.id] = action.payload.rect;
    },
    setGroupGeom: (state, action: PayloadAction<{ id: string; rect: Rect }>) => {
      state.groups[action.payload.id] = action.payload.rect;
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
      if (action.payload) touch(state, action.payload);
    },
    focusNode: (state, action: PayloadAction<string | null>) => {
      state.focusedId = action.payload;
      if (action.payload) touch(state, action.payload);
    },
    touchNode: (state, action: PayloadAction<string>) => { touch(state, action.payload); },
    /** Open the full-screen overlay on a node, or close it with `null`.
     *
     *  Opening also focuses: an overlay you cannot type into is a screenshot. Closing does
     *  NOT blur — you were working in that terminal a moment ago, and yanking the keyboard
     *  away as the node shrinks back is not what anyone means by "close". */
    setOverlayNode: (state, action: PayloadAction<string | null>) => {
      state.overlayId = action.payload;
      if (action.payload) {
        state.focusedId = action.payload;
        touch(state, action.payload);
      }
    },
    setEdges: (state, action: PayloadAction<CanvasEdge[]>) => {
      state.edges = action.payload;
    },
    addEdge: (state, action: PayloadAction<CanvasEdge>) => {
      const e = action.payload;
      // Ordered pair: A→B and B→A are distinct and both meaningful.
      if (state.edges.some((x) => x.from === e.from && x.to === e.to)) return;
      state.edges.push(e);
    },
    removeEdge: (state, action: PayloadAction<string>) => {
      state.edges = state.edges.filter((e) => e.id !== action.payload);
    },
    setSidebarOpen: (state, action: PayloadAction<boolean>) => {
      state.sidebarOpen = action.payload;
    },
    setSidebarWidth: (state, action: PayloadAction<number>) => {
      state.sidebarWidth = clampWidth(action.payload);
    },
    pruneCanvasGeometry: (
      state,
      action: PayloadAction<{ terminalIds: string[]; tabIds: string[] }>
    ) => {
      const liveNodes = new Set(action.payload.terminalIds);
      const liveGroups = new Set(action.payload.tabIds);
      for (const id of Object.keys(state.nodes)) if (!liveNodes.has(id)) delete state.nodes[id];
      for (const id of Object.keys(state.groups)) if (!liveGroups.has(id)) delete state.groups[id];
      state.recent = state.recent.filter((id) => liveNodes.has(id));
      if (state.selectedId && !liveNodes.has(state.selectedId)) state.selectedId = null;
      if (state.focusedId && !liveNodes.has(state.focusedId)) state.focusedId = null;
      // A closed terminal must not leave the canvas covered by an overlay of nothing.
      if (state.overlayId && !liveNodes.has(state.overlayId)) state.overlayId = null;
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
    },
  },
});

export const {
  setViewport, setNodeGeom, setGroupGeom,
  applyArrange, selectNode, focusNode, touchNode, setOverlayNode, setEdges, addEdge, removeEdge,
  setSidebarOpen, setSidebarWidth, pruneCanvasGeometry, hydrateCanvas,
} = canvasSlice.actions;

export default canvasSlice.reducer;
