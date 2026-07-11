import { configureStore } from '@reduxjs/toolkit';
import tabsReducer from './slices/tabsSlice';
import panesReducer from './slices/panesSlice';
import settingsReducer from './slices/settingsSlice';
import layoutsReducer from './slices/layoutsSlice';
import uiReducer from './slices/uiSlice';
import zoomReducer from './slices/zoomSlice';
import peersReducer from './slices/peersSlice';

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
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;