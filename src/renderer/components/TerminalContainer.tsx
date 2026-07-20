import React, { useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../store';
import { PaneManager } from './Panes/PaneManager';
import { setPaneTree, setActiveTabId, addTabTree, removeTabTree } from '../store/slices/panesSlice';
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
    if (activeTab?.shellType === 'settings') return;

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
      }
    });
  }, [tabs, activeTabId, dispatch]);

  // Ensure all tabs have a pane tree initialized (in the window map AND the
  // authoritative Redux store treesByTabId, which background tabs now render from).
  useEffect(() => {
    tabs.forEach(tab => {
      if (tab.shellType === 'settings') return;
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
        const isSettings = tab.shellType === 'settings';
        // Each tab renders from its OWN authoritative tree (reducers keep it in
        // sync via syncActive). This avoids any dependency on the active-tab
        // paneTree mirror, so switching tabs can't show another tab's content.
        let displayPaneTree = treesByTabId[tab.id] || tabPanes[tab.id];
        // Keep a single-pane tab's pane name in step with the tab title (renames).
        if (
          displayPaneTree &&
          displayPaneTree.type === 'terminal' &&
          displayPaneTree.terminalId === tab.id &&
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
            {isSettings ? (
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