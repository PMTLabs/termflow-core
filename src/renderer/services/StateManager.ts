import { Dispatch } from '@reduxjs/toolkit';
import { RootState } from '../store';
import { addTab, setActiveTab, clearAllTabs } from '../store/slices/tabsSlice';
import { setPaneTree, focusPane } from '../store/slices/panesSlice';
import { setDefaultProfile } from '../store/slices/settingsSlice';
import { clearTabPanes } from '../components/TerminalContainer';
import { restoreTabPanesInPlace } from './tabPanesStore';
import { generateId } from '../utils/id';
import { terminalService } from './TerminalService';
import { pruneCwds, seedRestoredCwds } from './stateManagerCwd';
import { getAllCwdSnapshots } from './cwdSnapshot';
import { reattachPromptGate, markArmProbePending } from './reattachGate';

export interface AppState {
  tabs: any[];
  activeTabId: string | null;
  paneTree: any;
  activePaneId: string | null;
  shellProfiles: any[];
  defaultProfile: string;
  timestamp: number;
  tabPanes?: { [tabId: string]: any };
  /** Spec 045 §3.3: last-known cwd per terminal id, so a restored terminal
   *  resumes where it left off. Optional — state saved by older builds has no
   *  such key and must still load. */
  terminalCwds?: { [terminalId: string]: string };
}

export interface SavedLayout {
  id: string;
  name: string;
  description?: string;
  tabs: any[];
  activeTabId: string | null;
  paneTree: any;
  activePaneId: string | null;
  createdAt: number;
  updatedAt: number;
}

class StateManagerClass {
  private readonly STATE_KEY = 'auto-terminal-state';
  private readonly LAYOUTS_KEY = 'auto-terminal-layouts';

  /** Every terminal id currently present in any tab's pane tree. */
  private collectLiveTerminalIds(state: RootState): Set<string> {
    const keep = new Set<string>();
    const walk = (node: any): void => {
      if (!node) return;
      if (node.terminalId) keep.add(node.terminalId);
      node.children?.forEach(walk);
    };
    Object.values(state.panes.treesByTabId || {}).forEach(walk);
    walk(state.panes.paneTree);
    return keep;
  }

  /**
   * Save current application state to localStorage
   */
  async saveState(): Promise<void> {
    try {
      const store = (window as any).__REDUX_STORE__;
      if (!store) return;

      const state: RootState = store.getState();
      
      // Get the current tab panes mapping from TerminalContainer
      const tabPanes = (window as any).__TAB_PANES__ || {};
      
      const appState: AppState = {
        tabs: state.tabs.tabs,
        activeTabId: state.tabs.activeTabId,
        paneTree: state.panes.paneTree,
        activePaneId: state.panes.activePaneId,
        shellProfiles: state.settings.shellProfiles,
        defaultProfile: state.settings.defaultProfile,
        timestamp: Date.now(),
        // Include tab panes mapping
        tabPanes,
        // Spec 045 §3.3: pruned to the terminals that still exist, so the map
        // cannot grow without bound across sessions. The values were refreshed
        // on the autosave tick — this call must stay synchronous, because
        // saveState also runs from `beforeunload`, where an await would mean
        // localStorage.setItem never runs.
        terminalCwds: pruneCwds(getAllCwdSnapshots(), this.collectLiveTerminalIds(state)),
      };

      localStorage.setItem(this.STATE_KEY, JSON.stringify(appState));
      console.log('State saved successfully:', {
        tabCount: appState.tabs.length,
        tabs: appState.tabs.map(t => ({ id: t.id, title: t.title })),
        activeTab: appState.activeTabId,
        hasPaneTree: !!appState.paneTree,
        tabPanesCount: Object.keys(appState.tabPanes || {}).length,
        timestamp: new Date(appState.timestamp).toLocaleString()
      });
    } catch (error) {
      console.error('Failed to save state:', error);
    }
  }

  /**
   * Restore application state from localStorage
   */
  async restoreState(dispatch: Dispatch): Promise<boolean> {
    try {
      const savedState = localStorage.getItem(this.STATE_KEY);
      if (!savedState) {
        console.log('No saved state found');
        return false;
      }

      const rawState = JSON.parse(savedState);
      const appState: AppState = this.sanitizeLayoutData(rawState);
      console.log(`Restoring state from ${new Date(appState.timestamp).toLocaleString()}`);
      
      // Check if state is not too old (24 hours)
      const maxAge = 24 * 60 * 60 * 1000;
      if (Date.now() - appState.timestamp > maxAge) {
        console.log('State is too old, clearing');
        localStorage.removeItem(this.STATE_KEY);
        return false;
      }

      // Don't restore shell profiles - they should always be fresh from the system
      // Only restore the default profile preference
      if (appState.defaultProfile) {
        dispatch(setDefaultProfile(appState.defaultProfile));
      }

      // Spec 045 §3.3: seed saved directories BEFORE any tab/pane is created, so
      // the spawn path (TerminalPane) resolves them for each restored terminal.
      seedRestoredCwds(appState.terminalCwds);

      // Clear any existing state first
      this.clearCurrentState(dispatch);

      // Reattach to any PTYs that survived this reload BEFORE creating tabs/panes.
      // The backend (Rust) keeps PTYs alive across a renderer reload; without this,
      // each restored pane spawns a brand-new PTY and orphans the old one (the
      // backend ends up with 2x the terminals per reload). Registering the live
      // process under its renderer id here makes TerminalPane's mount effect reuse
      // it (terminalService.getProcessId hit at TerminalPane.tsx:95) instead of
      // spawning. Best-effort: any failure falls through to the normal spawn path.
      // Reads appState directly (not the global tabPanes map), so it doesn't need
      // restoreTabPanesInPlace to have run yet.
      await this.reconcileExistingTerminals(appState);

      // Orphan sweep: drop persisted scrollback for any terminal no longer in the
      // restored layout (closed tabs, crashed sessions, force-kills). Uses the same
      // id set the reconcile walks — tab roots plus every terminal node in the saved
      // pane trees. Best-effort; failure never blocks restore.
      // ASSUMES a single persistent state (one STATE_KEY); the `?newWindow=1` path
      // returns before restoreState runs, so no second window prunes with a partial
      // keep-set. If multi-window independent saved layouts are ever added, this must
      // union all windows' live terminals (or move the sweep server-side) first.
      try {
        const keep = new Set<string>();
        (appState.tabs || []).forEach((t: any) => {
          if (t?.id) keep.add(t.id);
        });
        const walkKeep = (node: any): void => {
          if (!node) return;
          if (node.type === 'terminal' && node.terminalId) keep.add(node.terminalId);
          if (Array.isArray(node.children)) node.children.forEach(walkKeep);
        };
        Object.values(appState.tabPanes || {}).forEach(walkKeep);
        await window.electronAPI?.pruneTerminalHistory?.([...keep]);
      } catch (e) {
        console.warn('StateManager: history prune skipped:', e);
      }

      // Restore tabs
      if (appState.tabs?.length > 0) {
        console.log(`Restoring ${appState.tabs.length} tabs`);
        console.log('Tab details:', appState.tabs.map(t => ({
          id: t.id,
          title: t.title,
          shellType: t.shellType,
          processId: t.processId
        })));

        // Restore tab panes mapping IMMEDIATELY before creating tabs (not right after
        // clearCurrentState) — keeps the window where tabPanes has entries for tabIds
        // not yet in Redux's `tabs` at zero, since the very next statement is the
        // addTab loop below. Mutate the existing global object IN PLACE (do NOT
        // reassign window.__TAB_PANES__) — TerminalContainer holds a module-scoped
        // reference to the same object, and replacing it stranded the restored trees
        // so every restored terminal spawned under a fresh id, defeating scrollback
        // restore. See services/tabPanesStore.ts.
        if (appState.tabPanes) {
          console.log('Restoring tab panes mapping for all tabs:', Object.keys(appState.tabPanes));
          restoreTabPanesInPlace(appState.tabPanes);
        }

        // Add all tabs first without making them active
        for (let i = 0; i < appState.tabs.length; i++) {
          const tab = appState.tabs[i];
          console.log(`Restoring tab ${i + 1}/${appState.tabs.length}: ${tab.id} - ${tab.title}`);

          // processId and transient live-status flags are already cleared by
          // sanitizeLayoutData; just ensure the tab isn't marked active here (the
          // active tab is set afterwards via setActiveTab).
          dispatch(addTab({
            ...tab,
            processId: undefined,
            isActive: false
          }));
        }

        // Set active tab after all tabs are added. TerminalContainer's pane-restoration
        // effects are keyed reactively off [activeTabId, tabs, treesByTabId], so they
        // fire correctly off this dispatch without needing to wait for React to "catch up".
        if (appState.activeTabId && appState.tabs.some(tab => tab.id === appState.activeTabId)) {
          console.log(`Setting active tab: ${appState.activeTabId}`);
          dispatch(setActiveTab(appState.activeTabId!));
          // The TerminalContainer will automatically restore the pane tree for the active tab
          // from the tabPanes mapping
        }
      } else if (appState.tabPanes) {
        // No tabs to restore, but still seed the tabPanes mapping in case other
        // restore paths (e.g. a later openFolderTab) consult it.
        console.log('Restoring tab panes mapping (no tabs):', Object.keys(appState.tabPanes));
        restoreTabPanesInPlace(appState.tabPanes);
      }

      console.log('State restored successfully');
      return true;
    } catch (error) {
      console.error('Failed to restore state:', error);
      // Clear corrupted state
      localStorage.removeItem(this.STATE_KEY);
      return false;
    }
  }

  /**
   * Reattach restored panes to PTYs that are still alive in the backend, instead
   * of spawning fresh ones (which orphans the survivors). The backend tags every
   * terminal with the renderer terminalId that created it (its `tabId` field), so
   * we can map each saved pane back to its live process. Best-effort: any failure
   * (API unreachable, exposed-mode 401, prod mixed-content) is swallowed and the
   * normal spawn path runs — no regression.
   */
  private async reconcileExistingTerminals(appState: AppState): Promise<void> {
    try {
      // Every terminalId the restore will otherwise spawn: each tab root (tb-)
      // plus every terminal node in the saved pane trees (splits are tm-).
      const wanted = new Set<string>();
      (appState.tabs || []).forEach((t: any) => {
        if (t?.id) wanted.add(t.id);
      });
      const walk = (node: any): void => {
        if (!node) return;
        if (node.type === 'terminal' && node.terminalId) wanted.add(node.terminalId);
        if (Array.isArray(node.children)) node.children.forEach(walk);
      };
      Object.values(appState.tabPanes || {}).forEach(walk);
      if (wanted.size === 0) return;

      // Resolve the ACTUAL API port — the user may have changed it in Settings, so
      // hardcoding the dev/prod default would make this reconcile hit the wrong port
      // and silently fall back to spawning duplicates (re-orphaning PTYs). Read it
      // from the network config like the rest of the renderer; the dev/prod default
      // is only a fallback if that call is unavailable.
      let port = process.env.NODE_ENV === 'development' ? 42051 : 42031;
      try {
        const cfg = await window.electronAPI?.getNetworkConfig?.();
        if (cfg?.apiPort) port = cfg.apiPort;
      } catch {
        // keep the dev/prod default
      }
      const token = localStorage.getItem('api_token');
      const res = await fetch(`http://localhost:${port}/api/terminals`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;

      const data = await res.json();
      const list: any[] = Array.isArray(data) ? data : data?.terminals ?? [];

      // Group every live PTY by the renderer id that spawned it (its `tabId`),
      // restricted to ids the restore is about to recreate. We only consider these
      // "wanted" ids so API-created terminals (mode "api", no UI tab) and other
      // windows' terminals are never touched.
      const byRenderer = new Map<
        string,
        Array<{ processId: string; createdAt: number; promptHook: unknown }>
      >();
      for (const term of list) {
        const rendererId: string | undefined = term?.tabId; // id that spawned it
        const processId: string | undefined = term?.id ?? term?.processId;
        if (!rendererId || !processId || !wanted.has(rendererId)) continue;
        const createdAt = Date.parse(term?.createdAt ?? '') || 0;
        const arr = byRenderer.get(rendererId) ?? [];
        // promptHook re-arms command-suggest's prompt gate on reattach (see
        // reattachPromptGate) — a reload wipes the in-memory gate, so without it
        // an agent CLI running across the reload leaks input into the popup.
        arr.push({ processId, createdAt, promptHook: term?.promptHook });
        byRenderer.set(rendererId, arr);
      }

      // Reattach to the NEWEST PTY per id, and REAP the older duplicates: a prior
      // reload that failed to reattach leaves several live PTYs sharing one tabId,
      // and the backend keeps them all running forever. Closing the stale ones here
      // self-heals the leak on the next load instead of letting orphans accumulate.
      const orphansToClose: string[] = [];
      for (const [rendererId, candidates] of byRenderer) {
        candidates.sort((a, b) => b.createdAt - a.createdAt); // newest first
        const [keep, ...stale] = candidates;
        // Registers id→process AND seeds the init guards so the mount effect
        // reuses the live PTY (covers tab-root and split panes). The prompt-gate
        // seed re-arms command-suggest suppression the in-memory cache lost on
        // this reload — otherwise the popup leaks into a still-running agent CLI.
        // Seed the safe DISARMED baseline here; the ARMED decision is sampled
        // by the pane's pre-mount probe (review 008 M-1) — a fetch-time answer
        // would be stale by the time the engine mounts.
        terminalService.attachExistingTerminal(
          rendererId,
          keep.processId,
          reattachPromptGate(keep.promptHook, false),
        );
        if (keep.promptHook === true) markArmProbePending(rendererId);
        for (const dup of stale) orphansToClose.push(dup.processId);
      }

      for (const processId of orphansToClose) {
        try {
          // electronAPI.closeTerminal takes the backend processId directly — the
          // orphans were never in this renderer's terminalId→process map.
          await window.electronAPI?.closeTerminal?.(processId);
        } catch (e) {
          console.warn(`StateManager: failed to reap orphaned PTY ${processId}:`, e);
        }
      }

      console.log(
        `StateManager: reattached ${byRenderer.size}/${wanted.size} restored terminals to live backend PTYs` +
          (orphansToClose.length ? `; reaped ${orphansToClose.length} orphaned duplicate PTY(s)` : '')
      );
    } catch (e) {
      console.warn('StateManager: terminal reconciliation skipped (spawning fresh):', e);
    }
  }

  /**
   * Update existing layout with current state
   */
  async updateLayout(layoutId: string): Promise<boolean> {
    try {
      const store = (window as any).__REDUX_STORE__;
      if (!store) throw new Error('Store not available');

      const state: RootState = store.getState();
      const layouts = this.getSavedLayouts();
      const layoutIndex = layouts.findIndex(l => l.id === layoutId);
      
      if (layoutIndex === -1) {
        throw new Error('Layout not found');
      }
      
      // Update the layout with current state
      layouts[layoutIndex] = {
        ...layouts[layoutIndex],
        tabs: state.tabs.tabs,
        activeTabId: state.tabs.activeTabId,
        paneTree: state.panes.paneTree,
        activePaneId: state.panes.activePaneId,
        updatedAt: Date.now(),
      };
      
      localStorage.setItem(this.LAYOUTS_KEY, JSON.stringify(layouts));
      console.log(`Layout "${layouts[layoutIndex].name}" updated successfully`);
      return true;
    } catch (error) {
      console.error('Failed to update layout:', error);
      throw error;
    }
  }

  /**
   * Save current layout with a name
   */
  async saveLayout(name: string, description?: string): Promise<string> {
    try {
      const store = (window as any).__REDUX_STORE__;
      if (!store) throw new Error('Store not available');

      const state: RootState = store.getState();
      const layoutId = `layout-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const layout: SavedLayout = {
        id: layoutId,
        name,
        description,
        tabs: state.tabs.tabs,
        activeTabId: state.tabs.activeTabId,
        paneTree: state.panes.paneTree,
        activePaneId: state.panes.activePaneId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const existingLayouts = this.getSavedLayouts();
      existingLayouts.push(layout);
      
      localStorage.setItem(this.LAYOUTS_KEY, JSON.stringify(existingLayouts));
      console.log(`Layout "${name}" saved successfully`);
      return layoutId;
    } catch (error) {
      console.error('Failed to save layout:', error);
      throw error;
    }
  }

  /**
   * Load a saved layout
   */
  async loadLayout(layoutId: string, dispatch: Dispatch): Promise<boolean> {
    try {
      console.log(`Loading layout with ID: ${layoutId}`);
      const layouts = this.getSavedLayouts();
      const layout = layouts.find(l => l.id === layoutId);
      
      if (!layout) {
        console.error(`Layout not found with ID: ${layoutId}`);
        throw new Error('Layout not found');
      }

      const sanitizedLayout = this.sanitizeLayoutData(layout);
      console.log(`Found layout: ${sanitizedLayout.name} with ${sanitizedLayout.tabs?.length || 0} tabs`);

      // Clear current state first
      this.clearCurrentState(dispatch);

      // Wait a bit for the clear to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Load layout tabs
      if (sanitizedLayout.tabs?.length > 0) {
        console.log(`Loading ${sanitizedLayout.tabs.length} tabs`);
        for (const tab of sanitizedLayout.tabs) {
          dispatch(addTab({
            ...tab,
            isActive: false // Ensure tabs are not active initially
          }));
        }
        
        // Set active tab after all tabs are added
        if (sanitizedLayout.activeTabId) {
          console.log(`Setting active tab: ${sanitizedLayout.activeTabId}`);
          setTimeout(() => {
            dispatch(setActiveTab(sanitizedLayout.activeTabId!));
          }, 100);
        }
      }

      // Load layout pane tree after tabs
      if (sanitizedLayout.paneTree) {
        console.log(`Loading pane tree`);
        setTimeout(() => {
          dispatch(setPaneTree(sanitizedLayout.paneTree));
          
          if (sanitizedLayout.activePaneId) {
            dispatch(focusPane(sanitizedLayout.activePaneId));
          }
        }, 200);
      }

      // Update the layout's last used timestamp
      sanitizedLayout.updatedAt = Date.now();
      const updatedLayouts = layouts.map(l => l.id === layoutId ? sanitizedLayout : l);
      localStorage.setItem(this.LAYOUTS_KEY, JSON.stringify(updatedLayouts));

      console.log(`Layout "${sanitizedLayout.name}" loaded successfully`);
      return true;
    } catch (error) {
      console.error('Failed to load layout:', error);
      throw error;
    }
  }

  /**
   * Get all saved layouts
   */
  getSavedLayouts(): SavedLayout[] {
    try {
      const savedLayouts = localStorage.getItem(this.LAYOUTS_KEY);
      return savedLayouts ? JSON.parse(savedLayouts) : [];
    } catch (error) {
      console.error('Failed to get saved layouts:', error);
      return [];
    }
  }

  /**
   * Delete a saved layout
   */
  deleteLayout(layoutId: string): boolean {
    try {
      const layouts = this.getSavedLayouts();
      const filteredLayouts = layouts.filter(l => l.id !== layoutId);
      
      localStorage.setItem(this.LAYOUTS_KEY, JSON.stringify(filteredLayouts));
      console.log(`Layout deleted successfully`);
      return true;
    } catch (error) {
      console.error('Failed to delete layout:', error);
      return false;
    }
  }

  /**
   * Rename a saved layout
   */
  renameLayout(layoutId: string, newName: string, newDescription?: string): boolean {
    try {
      const layouts = this.getSavedLayouts();
      const layoutIndex = layouts.findIndex(l => l.id === layoutId);
      
      if (layoutIndex === -1) {
        throw new Error('Layout not found');
      }

      layouts[layoutIndex].name = newName;
      if (newDescription !== undefined) {
        layouts[layoutIndex].description = newDescription;
      }
      layouts[layoutIndex].updatedAt = Date.now();
      
      localStorage.setItem(this.LAYOUTS_KEY, JSON.stringify(layouts));
      console.log(`Layout renamed successfully`);
      return true;
    } catch (error) {
      console.error('Failed to rename layout:', error);
      return false;
    }
  }

  /**
   * Reset to default layout (single tab with default shell)
   */
  resetToDefaultLayout(dispatch: Dispatch): void {
    try {
      // Clear current state
      this.clearCurrentState(dispatch);
      
      // Create a single tab with default shell
      const newTabId = generateId('tb');
      dispatch(addTab({
        id: newTabId,
        title: 'Terminal',
        shellType: 'default',
        icon: '🖥️'
      }));
      
      console.log('Reset to default layout');
    } catch (error) {
      console.error('Failed to reset layout:', error);
    }
  }

  /**
   * Clear current state (used before loading a layout)
   */
  private clearCurrentState(dispatch: Dispatch): void {
    // Clear the local tab panes mapping
    clearTabPanes();
    // Clear all tabs first
    dispatch(clearAllTabs());
    // Clear pane tree
    dispatch(setPaneTree(null));
  }

  /**
   * Export layouts to file
   */
  exportLayouts(): string {
    const layouts = this.getSavedLayouts();
    return JSON.stringify(layouts, null, 2);
  }

  /**
   * Import layouts from file
   */
  importLayouts(layoutsJson: string): number {
    try {
      const importedLayouts: SavedLayout[] = JSON.parse(layoutsJson);
      const existingLayouts = this.getSavedLayouts();
      
      // Validate imported layouts
      const validLayouts = importedLayouts.filter(layout => 
        layout.id && layout.name && layout.tabs && layout.createdAt
      );

      // Merge with existing layouts (avoid duplicates by ID)
      const existingIds = new Set(existingLayouts.map(l => l.id));
      const newLayouts = validLayouts.filter(l => !existingIds.has(l.id));
      
      const allLayouts = [...existingLayouts, ...newLayouts];
      localStorage.setItem(this.LAYOUTS_KEY, JSON.stringify(allLayouts));
      
      return newLayouts.length;
    } catch (error) {
      console.error('Failed to import layouts:', error);
      throw error;
    }
  }

  /**
   * Helper to sanitize state and layouts to ensure they use correct prefixed IDs and avoid GUIDs.
   */
  private sanitizeLayoutData<T extends { 
    tabs: any[]; 
    activeTabId: string | null; 
    paneTree: any; 
    activePaneId: string | null; 
    tabPanes?: { [tabId: string]: any } 
  }>(data: T): T {
    const tabIdMap = new Map<string, string>();
    const paneIdMap = new Map<string, string>();

    // 1. Map old tab IDs to new tab IDs
    const sanitizedTabs = (data.tabs || []).map(tab => {
      let newId = tab.id;
      if (!tab.id || (!tab.id.startsWith('tb-') && !tab.id.startsWith('tab-settings-'))) {
        newId = generateId('tb');
        tabIdMap.set(tab.id, newId);
      }
      return {
        ...tab,
        id: newId,
        processId: undefined, // Clear processId anyway as it's a new session
        // A restored/loaded session always spawns a fresh process (or reattaches
        // to a live one), so the old "exited" mark is stale — clear it, otherwise
        // the tab keeps showing the ⊘ exited icon over a perfectly alive shell.
        exited: false,
        // Transient live-status flags are recomputed at runtime (RunningActivityTracker
        // for isRunning; MCP/API activity for the dot). Never restore them, or a
        // restored state / loaded layout would show a stale sweep or activity dot.
        // Sanitizing here covers BOTH restoreState and loadLayout.
        isRunning: undefined,
        hasBackgroundActivity: undefined,
        activityTick: undefined,
        // Unseen-output bell is transient (recomputed at runtime from live output);
        // never restore it, or a loaded layout / restored session shows a stale bell.
        hasUnseenOutput: undefined,
      };
    });

    const sanitizedActiveTabId = data.activeTabId && tabIdMap.has(data.activeTabId)
      ? tabIdMap.get(data.activeTabId)!
      : data.activeTabId;

    // Helper to recursively sanitize pane tree
    const sanitizeNode = (node: any, tabId: string): any => {
      if (!node) return null;
      const newNode = { ...node };

      // Map Pane ID
      if (newNode.id) {
        if (!newNode.id.startsWith('pn-')) {
          const newPaneId = generateId('pn');
          paneIdMap.set(newNode.id, newPaneId);
          newNode.id = newPaneId;
        }
      }

      if (newNode.type === 'terminal') {
        if (newNode.terminalId) {
          // If it was matching the old tab ID (main terminal of that tab)
          if (tabIdMap.has(newNode.terminalId)) {
            newNode.terminalId = tabIdMap.get(newNode.terminalId)!;
          } else if (newNode.terminalId === tabId) {
            // Keep it if it matches the new tab ID
          } else if (!newNode.terminalId.startsWith('tm-') && !newNode.terminalId.startsWith('tb-')) {
            // Split terminal ID that is not tb- or tm-
            newNode.terminalId = generateId('tm');
          }
        }
      } else if (newNode.type === 'split' && newNode.children) {
        newNode.children = newNode.children.map((child: any) => sanitizeNode(child, tabId));
      }

      return newNode;
    };

    // 2. Sanitize tabPanes if present
    const sanitizedTabPanes: { [tabId: string]: any } = {};
    if (data.tabPanes) {
      Object.entries(data.tabPanes).forEach(([oldTabId, tree]) => {
        const newTabId = tabIdMap.has(oldTabId) ? tabIdMap.get(oldTabId)! : oldTabId;
        sanitizedTabPanes[newTabId] = sanitizeNode(tree, newTabId);
      });
    }

    // 3. Sanitize active paneTree
    const sanitizedPaneTree = data.paneTree 
      ? sanitizeNode(data.paneTree, sanitizedActiveTabId || '')
      : null;

    const sanitizedActivePaneId = data.activePaneId && paneIdMap.has(data.activePaneId)
      ? paneIdMap.get(data.activePaneId)!
      : data.activePaneId;

    const result = {
      ...data,
      tabs: sanitizedTabs,
      activeTabId: sanitizedActiveTabId,
      paneTree: sanitizedPaneTree,
      activePaneId: sanitizedActivePaneId,
    };

    if (data.tabPanes) {
      (result as any).tabPanes = sanitizedTabPanes;
    }

    return result;
  }
}

export const StateManager = new StateManagerClass();