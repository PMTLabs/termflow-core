import React, { useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../store';
import { PaneManager } from './Panes/PaneManager';
import { setPaneTree, setActiveTabId, addTabTree, removeTabTree } from '../store/slices/panesSlice';
import { pruneCanvasGeometry } from '../store/slices/canvasSlice';
import './TerminalContainer.css';
import { generateId } from '../utils/id';
import { clearTabPanesInPlace } from '../services/tabPanesStore';

interface TabPaneMapping {
  [tabId: string]: any; // Store pane tree for each tab
}

// Store pane trees for each tab
let tabPanes: TabPaneMapping = {};

// Export function to clear tab panes when loading layouts. Clears IN PLACE (does not
// reassign `tabPanes`) so the shared reference held by window.__TAB_PANES__ /
// window.tabpanes and the session-restore path never diverges — see
// services/tabPanesStore.ts. Reassigning here was half of the "scrollback never
// recovers after restart" bug.
export const clearTabPanes = () => {
  clearTabPanesInPlace();
};

// Expose tabPanes to window for state saving and API access
if (typeof window !== 'undefined') {
  (window as any).__TAB_PANES__ = tabPanes;  // For backward compatibility with StateManager
  (window as any).tabPanes = tabPanes;        // For API and other uses
}

import { SettingsPage } from './Settings/SettingsPage';
import { CanvasMode } from './Canvas/CanvasMode';
import { isVirtualTab, SETTINGS_SHELL_TYPE, CANVAS_SHELL_TYPE } from '../services/tabKinds';

export const TerminalContainer: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { tabs, activeTabId } = useSelector((state: RootState) => state.tabs);
  const treesByTabId = useSelector((state: RootState) => state.panes.treesByTabId);
  const activePaneId = useSelector((state: RootState) => state.panes.activePaneId);
  const maximizedPaneByTabId = useSelector((state: RootState) => state.panes.maximizedPaneByTabId);

  // When the active tab changes: tell the panes slice (mirrors the active tree
  // into paneTree for InputHandler/API), and make sure the active tab has an
  // authoritative tree. Rendering reads treesByTabId directly, so we never write
  // a stale tree back here.
  useEffect(() => {
    if (!activeTabId) return;
    dispatch(setActiveTabId(activeTabId));

    const activeTab = tabs.find(t => t.id === activeTabId);
    if (isVirtualTab(activeTab?.shellType)) return;

    if (!treesByTabId[activeTabId]) {
      const seed = tabPanes[activeTabId] || {
        id: generateId('pn'),
        type: 'terminal' as const,
        terminalId: activeTabId,
        name: activeTab?.title || 'Terminal',
        shellType: activeTab?.shellType,
      };
      tabPanes[activeTabId] = seed;
      dispatch(addTabTree({ tabId: activeTabId, tree: seed }));
    }
  }, [activeTabId, tabs, treesByTabId, dispatch]);

  // NOTE: There is intentionally no "save paneTree -> tabPanes" effect here.
  // Persisting the active tree is handled synchronously inside the reducers
  // (syncActive writes treesByTabId, the store subscription mirrors it to
  // window.tabPanes). The old effect ran with a stale paneTree closure on tab
  // switch and corrupted the new tab's tree (empty/duplicated terminal).

  // Clean up closed tabs
  useEffect(() => {
    const currentTabIds = new Set(tabs.map(tab => tab.id));
    let closed = false;
    Object.keys(tabPanes).forEach(tabId => {
      if (!currentTabIds.has(tabId)) {
        console.log(`TerminalContainer: Cleaning up pane tree for closed tab ${tabId}`);
        delete tabPanes[tabId];
        dispatch(removeTabTree(tabId));

        // Also clean up from terminal init map
        if ((window as any).terminalInitMap) {
          (window as any).terminalInitMap.delete(tabId);
        }
        if ((window as any).terminalInitPromises) {
          (window as any).terminalInitPromises.delete(tabId);
        }
        if ((window as any).terminalInitLock) {
          (window as any).terminalInitLock.delete(tabId);
        }

        // If the closed tab was active, clear the pane tree from Redux
        if (activeTabId === tabId) {
          console.log(`TerminalContainer: Closed tab was active, clearing pane tree`);
          dispatch(setPaneTree(null));
        }
        closed = true;
      }
    });

    // Canvas geometry for the terminals that just went away (`plan/013` Task 22). Without
    // this it accumulates for the life of the profile, and a reused id would inherit a
    // stranger's position. `pruneCanvasGeometry` also clears selection/focus/overlay pointing
    // at a dead node, so this is not only housekeeping.
    //
    // The two id sets are built from their OWN sources and are not interchangeable even
    // though they overlap: leaves from the pane trees, tabs from the tab list (design 011 D7).
    // Read AFTER the deletions above so a tab closed in this same pass is already gone.
    if (closed) {
      const leafIds = new Set<string>();
      const walk = (node: any): void => {
        if (!node) return;
        if (node.type === 'terminal' && node.terminalId) leafIds.add(node.terminalId);
        if (Array.isArray(node.children)) node.children.forEach(walk);
      };
      Object.values(tabPanes).forEach(walk);
      dispatch(pruneCanvasGeometry({
        terminalIds: [...leafIds],
        tabIds: tabs.map((tab) => tab.id),
      }));
    }
  }, [tabs, activeTabId, dispatch]);

  // Ensure all tabs have a pane tree initialized (in the window map AND the
  // authoritative Redux store treesByTabId, which background tabs now render from).
  useEffect(() => {
    tabs.forEach(tab => {
      if (isVirtualTab(tab.shellType)) return;
      if (!tabPanes[tab.id]) {
        console.log('TerminalContainer: Pre-initializing pane tree for tab', tab.id);
        const newPaneId = generateId('pn');
        tabPanes[tab.id] = {
          id: newPaneId,
          type: 'terminal' as const,
          terminalId: tab.id,
          name: tab.title || 'Terminal',
          shellType: tab.shellType,
        };
      }
      // Seed Redux from the window map (covers API-/restore-created tabs).
      if (!treesByTabId[tab.id]) {
        dispatch(addTabTree({ tabId: tab.id, tree: tabPanes[tab.id] }));
      }
    });
  }, [tabs, treesByTabId, dispatch]);

  if (tabs.length === 0) {
    return (
      <div className="terminal-container empty">
        <div className="empty-state">
          <h2>Welcome to TermFlow</h2>
          <p>Click the + button to create a new terminal</p>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-container">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isSettings = tab.shellType === SETTINGS_SHELL_TYPE;
        const isCanvas = tab.shellType === CANVAS_SHELL_TYPE;
        // Each tab renders from its OWN authoritative tree (reducers keep it in
        // sync via syncActive). This avoids any dependency on the active-tab
        // paneTree mirror, so switching tabs can't show another tab's content.
        let displayPaneTree = treesByTabId[tab.id] || tabPanes[tab.id];
        // Keep a single-pane tab's pane name in step with the tab title (renames).
        // `type === 'terminal'` alone already scopes this to the solo/root pane
        // (a split tab's tree is a 'split' node here, never 'terminal') — an
        // additional `terminalId === tab.id` check is over-narrow now that an
        // API-created tab's root pane carries a `tm-` leaf, not the tab's own id.
        if (
          displayPaneTree &&
          displayPaneTree.type === 'terminal' &&
          displayPaneTree.name !== tab.title
        ) {
          displayPaneTree = { ...displayPaneTree, name: tab.title };
        }

        return (
          <div
            key={tab.id}
            className={`tab-content ${isActive ? 'active' : ''}`}
            data-tab-id={tab.id}
          >
            {isCanvas ? (
              // Mounted ONLY while its tab is active, unlike every other tab here.
              //
              // That is the whole relocation contract, not a rendering preference:
              // mounting CanvasMode moves every terminal's `term.element` out of its pane
              // and into a node host, and unmounting hands them back. A background canvas
              // tab would hold the entire workspace's terminals inside a `visibility:
              // hidden`, `opacity: 0` subtree while the user was reading a different tab —
              // every pane would render empty. Gating on `isActive` keeps the mount edge
              // exactly where the old full-screen overlay had it, which is why `012`
              // §6.5 RC1-RC5 survive this change untouched.
              isActive ? <CanvasMode /> : null
            ) : isSettings ? (
              <SettingsPage isActive={isActive} />
            ) : displayPaneTree ? (
              <PaneManager
                paneTree={displayPaneTree}
                activePaneId={isActive ? activePaneId : undefined}
                isTabActive={isActive}
                tabId={tab.id}
                maximizedPaneId={maximizedPaneByTabId[tab.id] ?? null}
              />
            ) : (
              <div className="loading-state">
                Initializing background terminal...
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};