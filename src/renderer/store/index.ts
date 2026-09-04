import { configureStore } from '@reduxjs/toolkit';
import tabsReducer from './slices/tabsSlice';
import panesReducer from './slices/panesSlice';
import settingsReducer from './slices/settingsSlice';
import layoutsReducer from './slices/layoutsSlice';
import uiReducer from './slices/uiSlice';
import zoomReducer from './slices/zoomSlice';
import peersReducer from './slices/peersSlice';
import canvasReducer from './slices/canvasSlice';
import sessionExitReducer from './slices/sessionExitSlice';
import { attachPaneOwnershipSync } from '../services/paneOwnership';
import { attachTerminalLabelSync } from '../services/terminalLabelSync';

// Simple logging middleware for debugging
const loggingMiddleware = (storeAPI: any) => (next: any) => (action: any) => {
  if (action.type && action.type.includes('pane')) {
    console.log('Redux Action:', action.type, action.payload);
  }
  const result = next(action);
  if (action.type && action.type.includes('pane')) {
    const state = storeAPI.getState();
    console.log('Redux State After:', { paneTree: state.panes.paneTree });
  }
  return result;
};

export const store = configureStore({
  reducer: {
    tabs: tabsReducer,
    panes: panesReducer,
    settings: settingsReducer,
    layouts: layoutsReducer,
    ui: uiReducer,
    zoom: zoomReducer,
    peers: peersReducer,
    canvas: canvasReducer,
    sessionExit: sessionExitReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(loggingMiddleware),
});

// Make store accessible globally for debugging and menu handlers
if (typeof window !== 'undefined') {
  (window as any).__REDUX_STORE__ = store;

  // Mirror the authoritative per-tab pane trees into window.tabPanes (upsert-only)
  // so the developer API, StateManager persistence, and tab-close logic keep reading
  // a single, current source. Deletions stay in the existing TerminalContainer cleanup
  // path (which also dispatches removeTabTree), so this never clobbers external writes.
  let lastTrees: any = null;
  store.subscribe(() => {
    const trees = store.getState().panes.treesByTabId;
    if (trees === lastTrees) return;
    lastTrees = trees;
    const w = window as any;
    if (!w.tabPanes) w.tabPanes = {};
    for (const tabId of Object.keys(trees)) {
      w.tabPanes[tabId] = trees[tabId];
    }
    w.__TAB_PANES__ = w.tabPanes;
  });

  // Tell the backend when a pane changes tab (review 099 T2-F2). Driven off the
  // pane tree rather than off the individual move/attach dispatch sites, so no
  // reparent path can be added later that forgets to report itself — see
  // services/paneOwnership.ts.
  attachPaneOwnershipSync(store);

  // And what the tab strip CALLS each terminal (plan 028 §4.2). Driven off the same two pieces of
  // store state for the same reason — a moved pane never re-binds, so a spawn hook misses it — and
  // through the same differ, so the two syncs cannot drift apart. Without this the Automations
  // picker and every activity-log line show a bare `tm-…` id.
  attachTerminalLabelSync(store);
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;