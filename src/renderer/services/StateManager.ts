import { Dispatch } from '@reduxjs/toolkit';
import { RootState } from '../store';
import { addTab, setActiveTab, clearAllTabs } from '../store/slices/tabsSlice';
import { addTabTree, focusPane, setActiveTabId, resetPanes } from '../store/slices/panesSlice';
import { setDefaultProfile } from '../store/slices/settingsSlice';
import { clearTabPanes } from '../components/TerminalContainer';
import { restoreTabPanesInPlace } from './tabPanesStore';
import { generateId } from '../utils/id';
import { terminalService } from './TerminalService';
import { pruneCwds, seedRestoredCwds, remapCwds } from './stateManagerCwd';
import { groupLiveTerminalsByLeaf } from './reconcileTerminals';
import { getAllCwdSnapshots } from './cwdSnapshot';
import { reattachPromptGate, markArmProbePending } from './reattachGate';
import { stateKey, layoutsKey, apiTokenKey, currentProfile, isForeignInstance } from './profileScope';

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
  /** Per-tab tree map (review 109 H2). `saveLayout` writes this for EVERY tab,
   *  not just the active one, so a background tab's tree — and an API-created
   *  tab's real `tm-` root leaf — survive a save/load round-trip. `paneTree`
   *  above is kept only for backward compatibility with layouts written before
   *  this field existed; `loadLayout` prefers `treesByTabId` when present and
   *  falls back to the old single-tree behavior per tab when it is missing
   *  (an old-format layout, or one saved before this field was introduced). */
  treesByTabId?: Record<string, any>;
}

class StateManagerClass {
  // Getters, not fields: the profile is resolved during bootstrap and this
  // singleton may be constructed either side of that. The default profile keeps
  // the original key names, so existing saved state loads untouched.
  private get STATE_KEY(): string { return stateKey(); }
  private get LAYOUTS_KEY(): string { return layoutsKey(); }

  /**
   * Monotonic token identifying the newest `loadLayout` call. `loadLayout`
   * clears the current state and then yields before populating; anything that
   * resumes after that yield with a stale token must not commit. See
   * `loadLayout`.
   */
  private loadGeneration = 0;

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
   * terminal with the renderer terminalId that created it (its `terminalId`
   * field — the `tb-*`/`tm-*` leaf; `tabId` is a deprecated alias and two splits
   * in one tab share an `owningTabId`, so grouping by either would reap a live
   * PTY), so we can map each saved pane back to its live process. Best-effort:
   * any failure (API unreachable, exposed-mode 401, prod mixed-content) is
   * swallowed and the normal spawn path runs — no regression.
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
      const token = localStorage.getItem(apiTokenKey());
      const res = await fetch(`http://localhost:${port}/api/terminals`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;

      const data = await res.json();

      // Owner check. Reattaching to — or worse, REAPING — another instance's
      // PTYs would kill live shells in someone else's window. The configured
      // port can belong to a sibling profile that bound it first, so prove the
      // answer came from OUR backend before touching anything it lists.
      const owner: string | undefined = data?.instance;
      const mine = currentProfile().key;
      if (isForeignInstance(owner, mine)) {
        console.warn(
          `StateManager: /api/terminals answered by instance '${owner}', not '${mine}' — ` +
            'skipping reattach/reap and spawning fresh'
        );
        return;
      }

      const list: any[] = Array.isArray(data) ? data : data?.terminals ?? [];

      // Group every live PTY by the renderer LEAF that spawned it (its
      // `terminalId` field — the `tb-*`/`tm-*` leaf; `tabId` is a deprecated
      // alias and two splits in one tab share an `owningTabId`, so grouping by
      // either would reap a live PTY), restricted to ids the restore is about
      // to recreate. We only consider these "wanted" ids so API-created
      // terminals (mode "api", no UI tab) and other windows' terminals are
      // never touched.
      const byRenderer = groupLiveTerminalsByLeaf(list, wanted);

      // Reattach to the NEWEST PTY per id, and REAP the older duplicates: a prior
      // reload that failed to reattach leaves several live PTYs sharing one tabId,
      // and the backend keeps them all running forever. Closing the stale ones here
      // self-heals the leak on the next load instead of letting orphans accumulate.
      const orphansToClose: string[] = [];
      for (const [rendererId, candidates] of byRenderer) {
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
        // This PTY predates the current renderer, so its one-shot ?9001h is gone
        // from every stream we can still read — re-seed Win32-Input-Mode for the
        // pane's mount, or Escape dies in whatever is running in it. Unlike the
        // gate above this is NOT hook-dependent: ConPTY asserts the mode for every
        // Windows session, hookless shells (cmd, ssh) included.
        terminalService.markReattachedSession(rendererId);
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
        // Must mirror saveLayout: a layout updated in place has to carry the
        // per-tab trees too. Without this the spread above preserves the OLD
        // treesByTabId (or `undefined`, for a layout saved before the field
        // existed), so a tab added since the last save has no entry. loadLayout
        // then skips its addTabTree, TerminalContainer's default seed effect
        // fires, and an API tab's `tm-*` root leaf is replaced by `tb-*` —
        // orphaning its PTY. Same bug H2 fixed on the save path.
        treesByTabId: { ...state.panes.treesByTabId },
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
        // Per-tab, not just the active tab's tree — a background tab (e.g. an
        // API-created one) would otherwise have no saved tree at all and would
        // be restored as a `tb-` seed permanently (review 109 H2).
        treesByTabId: { ...state.panes.treesByTabId },
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
   * Load a saved layout.
   *
   * Returns `true` when this call committed the layout, `false` when a NEWER
   * `loadLayout` started before this one reached its populate phase and this
   * call therefore abandoned without touching Redux or localStorage.
   */
  async loadLayout(layoutId: string, dispatch: Dispatch): Promise<boolean> {
    // Round-6 HIGH (report 114). Everything below the `await` must be guarded:
    // two loads entering during the yield below BOTH clear the current state,
    // then the later one appends its tabs/trees on top of the earlier one's
    // freshly populated state (duplicate tabs when the layouts share tab ids,
    // and a stale localStorage write). Only the newest generation may commit.
    const generation = ++this.loadGeneration;

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

      // Wait a bit for the clear to complete — this yield lets React unmount
      // the previous layout's terminals before new ones mount, so it must NOT
      // be removed just because the dispatches around it are synchronous.
      await new Promise(resolve => setTimeout(resolve, 100));

      // A newer load started during that yield. It has already re-cleared the
      // state and will populate itself; committing now would append this
      // layout on top of (or underneath) the newer one. Abandon: no populate,
      // no localStorage write, no last-used timestamp bump. The clear this
      // call performed is harmless — the winner cleared again after it.
      if (generation !== this.loadGeneration) {
        console.log(`Layout load superseded, abandoning: ${layoutId}`);
        return false;
      }

      // Load layout tabs. Review 109 H2: a tab must never be renderable without
      // its authoritative tree, or TerminalContainer's seed effects manufacture
      // a `terminalId: tab.id` root and can spawn a PTY the real tree later
      // orphans. So each tab's tree — when the layout carries one — is
      // dispatched in the SAME synchronous block as its `addTab`, with no
      // `await`/timeout between them.
      //
      // Re-review 111 finding 2: a tree is NEVER restored through the
      // active-tab mirror (`setPaneTree`). That reducer runs `syncActive`,
      // which writes its payload into `treesByTabId[activeTabId]` as of
      // DISPATCH time — so a deferred `setPaneTree` could land after the user
      // had switched tabs, writing tab A's tree into tab B and orphaning B's
      // PTYs. Every write here is keyed by its real owner via `addTabTree`,
      // and the activation is synchronous.
      //
      // Scope of that guarantee: keying by owner removes the MIS-TARGETING of
      // a tree write. It does NOT by itself make two overlapping layout loads
      // safe — that is what the `loadGeneration` check above provides, by
      // letting only the newest load reach this block at all.
      if (sanitizedLayout.tabs?.length > 0) {
        console.log(`Loading ${sanitizedLayout.tabs.length} tabs`);
        for (const tab of sanitizedLayout.tabs) {
          dispatch(addTab({
            ...tab,
            isActive: false // Ensure tabs are not active initially
          }));
          const tabTree = sanitizedLayout.treesByTabId?.[tab.id];
          if (tabTree) {
            dispatch(addTabTree({ tabId: tab.id, tree: tabTree }));
          }
        }

        // OLD-format layout (saved before `treesByTabId` existed): its single
        // `paneTree` belongs to the SAVED active tab. Install it explicitly
        // under that owner. Other tabs of such a layout keep today's behavior
        // (seeded by TerminalContainer).
        if (
          sanitizedLayout.paneTree &&
          sanitizedLayout.activeTabId &&
          !sanitizedLayout.treesByTabId?.[sanitizedLayout.activeTabId]
        ) {
          dispatch(addTabTree({
            tabId: sanitizedLayout.activeTabId,
            tree: sanitizedLayout.paneTree,
          }));
        }

        // Activate synchronously, in the same pass as the keyed tree writes.
        if (sanitizedLayout.activeTabId) {
          console.log(`Setting active tab: ${sanitizedLayout.activeTabId}`);
          dispatch(setActiveTab(sanitizedLayout.activeTabId));
          dispatch(setActiveTabId(sanitizedLayout.activeTabId));

          if (sanitizedLayout.activePaneId) {
            dispatch(focusPane(sanitizedLayout.activePaneId));
          }
        }
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
    // Clear EVERY tab's tree, not just the active one's. `setPaneTree(null)`
    // only deleted `treesByTabId[activeTabId]` (via syncActive) and left every
    // background tab's tree live in Redux with no tab able to render or close
    // it — re-review 111 finding 4.
    dispatch(resetPanes());
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
    tabPanes?: { [tabId: string]: any };
    terminalCwds?: { [terminalId: string]: string };
    treesByTabId?: { [tabId: string]: any };
  }>(data: T): T {
    const tabIdMap = new Map<string, string>();
    const paneIdMap = new Map<string, string>();
    const terminalIdMap = new Map<string, string>();

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
          const oldTerminalId = newNode.terminalId;
          // If it was matching the old tab ID (main terminal of that tab)
          if (tabIdMap.has(newNode.terminalId)) {
            newNode.terminalId = tabIdMap.get(newNode.terminalId)!;
          } else if (newNode.terminalId === tabId) {
            // Keep it if it matches the new tab ID
          } else if (!newNode.terminalId.startsWith('tm-') && !newNode.terminalId.startsWith('tb-')) {
            // Split terminal ID that is not tb- or tm-
            newNode.terminalId = generateId('tm');
          }
          // GUARD (blast-radius review 092 B1): `sanitizeNode` runs TWICE over
          // the same logical tree — once inside the `tabPanes` loop below
          // (whose output IS what `restoreTabPanesInPlace` actually restores)
          // and once standalone over `paneTree` (whose output `restoreState`
          // never dispatches — no `setPaneTree` call exists there). For a
          // legacy leaf id that needs regeneration, each pass independently
          // calls the non-deterministic `generateId('tm')` and gets a
          // DIFFERENT id. The tabPanes pass runs first (it is physically
          // earlier in this function), so its id is the one that ends up on
          // screen — the FIRST mapping must therefore win. Without this guard
          // the second (discarded) id silently overwrites the first, and
          // `remapCwds` re-keys the cwd onto an id no restored pane carries —
          // reproducing the exact bug this task exists to fix.
          if (newNode.terminalId !== oldTerminalId && !terminalIdMap.has(oldTerminalId)) {
            terminalIdMap.set(oldTerminalId, newNode.terminalId);
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

    // 2b. Sanitize the per-tab tree map (review 109 H2), same remapping as
    // tabPanes above — each tab's tree is sanitized under its (possibly
    // remapped) tab id so a saved API tab's `tm-` leaf survives intact.
    const sanitizedTreesByTabId: { [tabId: string]: any } = {};
    if (data.treesByTabId) {
      Object.entries(data.treesByTabId).forEach(([oldTabId, tree]) => {
        const newTabId = tabIdMap.has(oldTabId) ? tabIdMap.get(oldTabId)! : oldTabId;
        sanitizedTreesByTabId[newTabId] = sanitizeNode(tree, newTabId);
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
      terminalCwds: remapCwds(data.terminalCwds || {}, terminalIdMap),
    };

    if (data.tabPanes) {
      (result as any).tabPanes = sanitizedTabPanes;
    }

    if (data.treesByTabId) {
      (result as any).treesByTabId = sanitizedTreesByTabId;
    }

    return result;
  }
}

export const StateManager = new StateManagerClass();