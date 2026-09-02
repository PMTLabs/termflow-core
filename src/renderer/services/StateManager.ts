import { Dispatch } from '@reduxjs/toolkit';
import { RootState } from '../store';
import { addTab, setActiveTab, clearAllTabs, updateTabMeta } from '../store/slices/tabsSlice';
import {
  addTabTree, focusPane, focusPaneInTab, setActiveTabId, resetPanes, setMaximizedPane,
} from '../store/slices/panesSlice';
import { findTabIdByTerminalId, getAllTerminalIds, findLeaf } from '../store/slices/paneTreeOps';
import { setDefaultProfile } from '../store/slices/settingsSlice';
import { clearTabPanes } from '../components/TerminalContainer';
import { restoreTabPanesInPlace } from './tabPanesStore';
import { generateId } from '../utils/id';
import { terminalService } from './TerminalService';
import { pruneCwds, seedRestoredCwds, remapCwds } from './stateManagerCwd';
import { groupLiveTerminalsByLeaf } from './reconcileTerminals';
import { getAllCwdSnapshots } from './cwdSnapshot';
import { reattachPromptGate, markArmProbePending } from './reattachGate';
import { layoutsKey, apiTokenKey, currentProfile, isForeignInstance } from './profileScope';
import { apiBase } from '../api/apiBase';
// `stateKey` is deliberately NOT imported: the session key is per WINDOW now
// (plan 018), and the profile-only key would put every window back on one blob.
import { sessionStateKey, isSlotZero } from './windowScope';
import { unionKeepSet } from './sessionKeepSet';
import { sweepOrphanSessions } from './sessionOrphans';
import {
  CanvasPersisted, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_ZOOM_MIN, SIDEBAR_ZOOM_MAX, hydrateCanvas,
} from '../store/slices/canvasSlice';
import { canvasTabFirst } from './tabKinds';
import { clearAllSessionClosed } from '../store/slices/sessionExitSlice';
import { clampZoom, canvasMetrics } from '../components/Canvas/canvasGeometry';
// plan/025 §2.2/§2.3: the one-deep workspace undo slot and the superset
// snapshot it holds — see workspaceSnapshot.ts / layoutUndo.ts for why a
// SavedLayout (below) is not enough to revert into.
import { captureWorkspaceSnapshot, workspaceIdentity, isWorkspaceEmpty } from './workspaceSnapshot';
import { pushUndo, peekUndo, takeUndo, clearUndo } from './layoutUndo';
import { setLayoutBaseline, clearLayoutBaseline } from './layoutBaseline';

/** Beyond this the fit/minimap maths degenerates; finite is not the same as sane. */
const WORLD_LIMIT = 1e6;

const isRect = (r: any): boolean =>
  !!r
  && ['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))
  // A zero or negative box is unusable, and unbounded coordinates make the
  // minimap and fit maths degenerate.
  && r.w > 0 && r.h > 0
  && Math.abs(r.x) < WORLD_LIMIT && Math.abs(r.y) < WORLD_LIMIT
  && r.w < WORLD_LIMIT && r.h < WORLD_LIMIT;

/**
 * Validate persisted canvas geometry and prune anything whose terminal or tab did not survive
 * restore — a stale blob must not resurrect a phantom node.
 *
 * `enabled` and `focusedId` are deliberately never carried through: Canvas Mode is a TAB
 * (`shellType === 'canvas'`), so "is the canvas showing" is a fact of `tabs` and a persisted
 * copy of it would be a second source of truth; and the app must never boot with a terminal
 * silently holding the keyboard.
 *
 * **`zMax` is a required parameter for the same reason `clampZoom` made it one.** The zoom
 * ceiling stopped being a module constant when the host box started being sized for the
 * display — `plan/013` Task 22 was written against the old `clampZoom(z)` and does not compile.
 * A default here would clamp a restored viewport to some other display's ceiling, which shows
 * up as a canvas that stops zooming early on a 4K panel: a preference, not a bug, to anyone
 * looking at it. The caller passes the ceiling for the display the app actually opened on.
 *
 * The two id arrays are different identities and they OVERLAP (design 011): `terminalIds` are
 * renderer leaves, `tabIds` are owning tabs, and a tab's first pane uses the tab's own id as
 * its leaf — so `tb-alpha` legitimately appears in both. Each must be built from its own
 * source; deriving one from the other keeps a phantom group alive for every solo tab, or drops
 * the node geometry of every root pane.
 */
export function sanitizeCanvasState(
  canvas: unknown,
  terminalIds: string[],
  tabIds: string[],
  zMax: number,
): CanvasPersisted | undefined {
  if (!canvas || typeof canvas !== 'object') return undefined;
  const c = canvas as any;

  const vpRaw = c.viewport ?? {};
  const finite = (v: any, fallback: number) =>
    (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  // The shared clamp, not `z > 0`: a persisted z of 9999 is finite and positive but far
  // outside the legal range, and would restore a canvas the user cannot see anything on.
  const viewport = {
    x: finite(vpRaw.x, 0),
    y: finite(vpRaw.y, 0),
    z: clampZoom(finite(vpRaw.z, 1), zMax),
  };

  const liveNodes = new Set(terminalIds);
  const liveTabs = new Set(tabIds);
  const nodes: Record<string, any> = {};
  const groups: Record<string, any> = {};
  for (const [id, r] of Object.entries(c.nodes ?? {})) {
    if (liveNodes.has(id) && isRect(r)) nodes[id] = r;
  }
  for (const [id, r] of Object.entries(c.groups ?? {})) {
    if (liveTabs.has(id) && isRect(r)) groups[id] = r;
  }

  return {
    viewport,
    nodes,
    groups,
    sidebarOpen: typeof c.sidebarOpen === 'boolean' ? c.sidebarOpen : true,
    sidebarWidth: Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, finite(c.sidebarWidth, 250))),
    // `finite` first, then the clamp — see `clampZoom` in `canvasSlice`: NaN survives a bare
    // Math.max/Math.min pair, and a NaN here reaches the stylesheet as an invalid calc().
    sidebarZoom: Math.max(SIDEBAR_ZOOM_MIN, Math.min(SIDEBAR_ZOOM_MAX, finite(c.sidebarZoom, 1))),
  };
}

/** The zoom ceiling for the display this window opened on — the same derivation
 *  `CanvasMode` freezes for the session. */
export function restoreZMax(): number {
  return canvasMetrics(
    typeof window === 'undefined' ? 1920 : window.innerWidth,
    typeof window === 'undefined' ? 1040 : window.innerHeight,
  ).zMax;
}

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
  /** Canvas Mode geometry (`plan/013` Task 22). Optional — state written by any
   *  earlier build has no such key and must still load. Deliberately excludes
   *  `edges`, which the backend owns and the renderer refetches. */
  canvas?: CanvasPersisted;
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
  /** plan/025 §2.4. Absent means 'workspace' — every layout saved before this
   *  field existed, and every ordinary (whole-workspace) save going forward,
   *  loads exactly as it always has. */
  scope?: 'workspace' | 'tab';
  /** The tab this layout captures, when `scope === 'tab'`. */
  scopedTabId?: string;
  /** Present ONLY on a tab-scoped save — that one tab's entries from the
   *  matching `panesSlice` maps, so `loadTabScopedLayout` can restore its
   *  focus/maximize/cwd exactly as they were (plan/025 §2.4 step 4). A
   *  workspace-scope save leaves these undefined, exactly like every layout
   *  saved before this field existed — §0.2 already covers that lossiness for
   *  the WHOLE-workspace case with `WorkspaceSnapshot`; fixing it here too
   *  would duplicate that superset for a format this plan does not ask to
   *  make lossless. */
  activePaneByTabId?: Record<string, string>;
  maximizedPaneByTabId?: Record<string, string>;
  terminalCwds?: Record<string, string>;
}

class StateManagerClass {
  // Getters, not fields: the profile is resolved during bootstrap and this
  // singleton may be constructed either side of that. The default profile keeps
  // the original key names, so existing saved state loads untouched.
  // Per WINDOW, not just per instance (plan 018). Every window of one instance
  // shares a WebView2 origin and therefore one localStorage; a single key meant
  // each window's save blindly overwrote every other window's tabs, and only one
  // window ever read it back. Slot 0 keeps the original bare key, so an existing
  // single-window session still loads untouched.
  private get STATE_KEY(): string { return sessionStateKey(); }
  private get LAYOUTS_KEY(): string { return layoutsKey(); }

  /**
   * True from the moment a REPLACEMENT transaction clears the workspace until it
   * has finished populating (or abandoned).
   *
   * The `loadGeneration` token below settles which of two overlapping
   * REPLACEMENTS wins — it is a last-writer-wins rule between peers that both
   * clear and both populate. It says nothing about a non-replacement mutation
   * landing in the window where the workspace is legitimately EMPTY. A
   * tab-scoped load is exactly that: it never clears, so it never takes the
   * token, and dispatched during a replacement's yield its tab would be
   * installed into the empty store and then have the replacement's own tabs
   * appended on top — a workspace that is neither of the two things the user
   * asked for.
   *
   * Bumping the token from the tab load instead would be worse, not better: the
   * workspace has already been cleared by then, so invalidating the replacement
   * would strand the single tab-scoped fragment as the entire workspace.
   *
   * So the rule is refusal, not arbitration: while a replacement owns the
   * workspace, a non-replacement mutation of it does not run. The three ASYNC
   * clearing paths — `restoreState`, `loadLayout`, `revertWorkspace` — take
   * ownership through `asReplacement`. `resetToDefaultLayout` clears too, but
   * synchronously: it has no yield for anything to land in, so it only READS
   * the guard. (An earlier version of this comment said reset took the guard
   * "via an `asReplacement` wrapper"; it does not, and never did.) This is NOT
   * backlog 006's arbiter (which would serialise the replacements against each
   * OTHER); it is the narrower interaction rule the tab-scoped path needs.
   *
   * A DEPTH, not a boolean. Replacements are explicitly allowed to overlap —
   * arbitrating between them is exactly what `loadGeneration` is for — so the
   * workspace can be owned by an unknown NUMBER of them at once. A boolean
   * records only that at least one arrived, and is cleared by the first to
   * LEAVE: `loadLayout(A)`, then `loadLayout(B)`; A wakes to a stale
   * generation, abandons, and its `finally` hands the workspace away while B
   * is still yielded and still owns it. A tab-scoped load landing in that gap
   * layers into the empty store exactly as it did before this guard existed.
   * The property being tracked is "how many", not "whether", and only a count
   * survives an overlap.
   */
  private replacementDepth = 0;

  /** True while ANY replacement transaction owns the workspace. */
  private get replacementInFlight(): boolean {
    return this.replacementDepth > 0;
  }

  /** Run `body` as a replacement transaction. `finally`, so an abandoned or
   *  throwing replacement can never leave the workspace permanently barred. */
  private async asReplacement<T>(body: () => Promise<T>): Promise<T> {
    this.replacementDepth++;
    try {
      return await body();
    } finally {
      this.replacementDepth--;
    }
  }

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

      // A replacement (load / revert / restore) clears the workspace, yields,
      // and only then repopulates. For the length of that yield `state.tabs` is
      // EMPTY — and this method is called from a 30s autosave tick, a pane
      // teardown, a visibility change and `beforeunload`, none of which know a
      // swap is underway. Persisting from inside the window writes `tabs: []`
      // over the user's real session, so the next launch restores nothing.
      //
      // Skipping is always the safe direction: the previous write still
      // describes a real workspace, and the next autosave tick (or the next
      // teardown/unload) writes the post-replacement one. This window predates
      // the branch that added the guard — `loadLayout` has cleared-then-yielded
      // since long before — but `revertWorkspace` adds a third path through it.
      if (this.replacementInFlight) return;

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
        // Only the CanvasPersisted fields — never `edges`, which the backend owns and the
        // renderer refetches on entering Canvas Mode, and never `enabled`/`focusedId`.
        canvas: {
          viewport: state.canvas.viewport,
          nodes: state.canvas.nodes,
          groups: state.canvas.groups,
          sidebarOpen: state.canvas.sidebarOpen,
          sidebarWidth: state.canvas.sidebarWidth,
          sidebarZoom: state.canvas.sidebarZoom,
        },
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
    return this.asReplacement(() => this.restoreStateInner(dispatch));
  }

  private async restoreStateInner(dispatch: Dispatch): Promise<boolean> {
    try {
      const savedState = localStorage.getItem(this.STATE_KEY);
      if (!savedState) {
        console.log('No saved state found');
        return false;
      }

      const rawState = JSON.parse(savedState);
      // Leaf renames performed by sanitisation — chiefly the design-014
      // migration of a pre-014 `tb-` root leaf to a minted `tm-`.
      const leafRenames = new Map<string, string>();
      const appState: AppState = this.sanitizeLayoutData(rawState, leafRenames);
      // Move the persisted scrollback to follow the renamed leaves, BEFORE any
      // tab, pane or reattach exists. `terminal_history` is keyed by the leaf,
      // so a pane whose leaf moved would otherwise come back blank — silently,
      // because a missing row reads as "nothing saved yet", not as an error.
      //
      // Awaited, not fired-and-forgotten: a reattach that wins the race reads
      // the OLD key and restores nothing. Failures are logged and swallowed —
      // losing one pane's scrollback is bad, but aborting restore over it would
      // leave the session unopened, which is worse.
      await this.migrateHistoryForRenamedLeaves(leafRenames);
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

      // Orphan sweep: drop persisted scrollback for any terminal no longer in a
      // saved layout (closed tabs, crashed sessions, force-kills).
      //
      // The keep-set is the UNION over EVERY window's session, not just this
      // one's (plan 018 Task 7). Sessions are per-window now, and N windows boot
      // concurrently — a sweep keyed on one window's layout would delete every
      // other window's scrollback before those windows had read their own
      // session. This is what the previous comment here required if per-window
      // layouts were ever added.
      //
      // Only slot 0 sweeps: a correct union run N times is merely wasteful, but
      // it is still N round-trips for no gain.
      //
      // Best-effort; failure never blocks restore.
      if (isSlotZero()) {
        // Drop session blobs for windows that no longer exist FIRST, so their
        // terminals fall out of the union below and their scrollback is
        // actually reclaimed rather than kept alive by a dead window's blob.
        // Skips itself if the backend cannot say which windows are live.
        try {
          const liveIds = (await window.electronAPI?.listWindowSessionIds?.()) ?? [];
          sweepOrphanSessions(localStorage, liveIds);
        } catch (e) {
          console.warn('StateManager: orphan session sweep skipped:', e);
        }

        try {
          const keep = unionKeepSet(localStorage);
          if (!keep.complete) {
            // A window whose session would not parse is a window whose terminals
            // we cannot name. Sweeping on a partial union deletes scrollback
            // that cannot be recovered, so skip it entirely this time.
            console.warn(
              'StateManager: history prune skipped — at least one window session was unreadable',
            );
          } else {
            await window.electronAPI?.pruneTerminalHistory?.([...keep.ids]);
          }
        } catch (e) {
          console.warn('StateManager: history prune skipped:', e);
        }
      }

      // Canvas geometry (`plan/013` Task 22), before the tabs it describes exist — the
      // reducer only stores rects, and `buildCanvasModel` reads them when it projects.
      //
      // The two id lists come from their OWN sources and are not interchangeable, even
      // though they overlap: leaves from the restored pane trees, tabs from the restored
      // tab list. Deriving one from the other keeps a phantom group alive for every solo
      // tab, or drops the node geometry of every root pane (design 011 D7).
      if (appState.canvas) {
        const leafIds = new Set<string>();
        const walkLeaves = (node: any): void => {
          if (!node) return;
          if (node.type === 'terminal' && node.terminalId) leafIds.add(node.terminalId);
          if (Array.isArray(node.children)) node.children.forEach(walkLeaves);
        };
        Object.values(appState.tabPanes || {}).forEach(walkLeaves);
        walkLeaves(appState.paneTree);
        const tabIds = (appState.tabs || []).map((t: any) => t?.id).filter(Boolean);
        const canvas = sanitizeCanvasState(appState.canvas, [...leafIds], tabIds, restoreZMax());
        if (canvas) dispatch(hydrateCanvas(canvas));
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

        // The canvas tab restores FIRST, wherever it was persisted (`plan/024` Req 3).
        //
        // `openCanvasTab` puts it at the front on every open, and a restore that replayed the
        // saved order would be the one path that quietly disagrees — the position is only worth
        // having if it survives a restart, which is exactly when a workspace tab is looked for.
        // The rule itself is in `tabKinds`, with `openCanvasTab`'s.
        const restoreOrder = canvasTabFirst(appState.tabs);

        // Add all tabs first without making them active
        for (let i = 0; i < restoreOrder.length; i++) {
          const tab = restoreOrder[i];
          console.log(`Restoring tab ${i + 1}/${restoreOrder.length}: ${tab.id} - ${tab.title}`);

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
  // Typed as a PICK, not the full `AppState`, because `revertWorkspace` calls
  // this too (plan/025 §2.2 "Risks" — a persisted undo snapshot revived after a
  // reload needs the exact same reattach-or-reap treatment `restoreState`
  // already gets) and a `WorkspaceSnapshot` has no `shellProfiles` /
  // `defaultProfile` / `timestamp` to offer. The body below only ever reads
  // `.tabs` and `.tabPanes`.
  private async reconcileExistingTerminals(appState: Pick<AppState, 'tabs' | 'tabPanes'>): Promise<void> {
    try {
      // Every terminalId the restore will otherwise spawn: each tab id plus
      // every terminal node in the saved pane trees. Leaf ids come in two FORMS
      // that name who minted them, NOT the pane's shape — `tb-*` for a
      // renderer-created tab root, `tm-*` for split panes AND for every
      // API-created terminal, including a solo root — so this walks the tree
      // rather than filtering on a prefix.
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

      // Resolve the ACTUAL API port. This used to read the CONFIGURED one and fall back
      // to the dev/prod default, and both are the same wrong answer under a second
      // instance: every release profile is configured for 42031, only one of them owns
      // it, and the reconcile would then read a SIBLING's terminal list. The owner check
      // below caught that and bailed — safe, but it meant this reconcile never ran at all
      // for a non-primary instance. `apiBase()` addresses the port we actually bound, and
      // throws rather than guessing when there isn't one.
      let base: string;
      try {
        base = await apiBase();
      } catch {
        return; // no API of our own to reconcile against
      }
      const token = localStorage.getItem(apiTokenKey());
      const res = await fetch(`${base}/terminals`, {
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
      
      // An update re-captures the CURRENT state in the layout's OWN scope.
      //
      // Re-capturing as a workspace regardless (which is what this did before
      // scopes existed) would leave a layout whose `scope: 'tab'` survives the
      // spread while its `tabs`/`treesByTabId` hold the entire workspace — a
      // layout that claims to be one tab and carries every tab. The one shared
      // builder is what keeps this branch and `saveLayout` from drifting; see
      // `buildLayoutBody` for the drift that already happened once here.
      const existing = layouts[layoutIndex];
      const scope = existing.scope ?? 'workspace';
      // A tab-scoped layout re-captures the tab it has always described, NOT
      // whatever tab happens to be active now — "Update" means "re-capture what
      // this layout is", not "re-point it at something else". If that tab is
      // gone, there is nothing to re-capture and the caller is told so rather
      // than being handed a silent re-target to an unrelated tab.
      const scopedTabId = existing.scopedTabId ?? existing.tabs?.[0]?.id;
      if (scope === 'tab' && !state.tabs.tabs.some(t => t.id === scopedTabId)) {
        throw new Error(
          `Cannot update "${existing.name}": the tab it saved is no longer open.`,
        );
      }

      layouts[layoutIndex] = {
        ...existing,
        ...this.buildLayoutBody(state, scope, scopedTabId),
        updatedAt: Date.now(),
      };

      localStorage.setItem(this.LAYOUTS_KEY, JSON.stringify(layouts));

      // plan/025 §2.5: a WORKSPACE-scope update re-captures the whole workspace
      // under this layout's name, so it becomes the new "clean" reference
      // exactly like a fresh save. A TAB-scope update does not, for the same
      // reason a tab-scope save does not — it never captured the whole
      // workspace, so comparing the full workspace against it would read every
      // other tab as dirty. Best-effort: `captureWorkspaceSnapshot` reads
      // `state.canvas`, which a minimal test store may not wire up, and a miss
      // here must not fail the update itself.
      if (scope !== 'tab') {
        try {
          setLayoutBaseline(workspaceIdentity(captureWorkspaceSnapshot(state, existing.name)));
        } catch (e) {
          console.warn('StateManager: could not record layout baseline after update:', e);
        }
      }

      console.log(`Layout "${layouts[layoutIndex].name}" updated successfully`);
      return true;
    } catch (error) {
      console.error('Failed to update layout:', error);
      throw error;
    }
  }

  /**
   * The CONTENT half of a saved layout — everything except `id`, `name`,
   * `description` and the two timestamps.
   *
   * Shared by `saveLayout` and `updateLayout` because those two already drifted
   * once: `updateLayout` used to omit `treesByTabId`, so a tab added since the
   * last save had no entry, `loadLayout` skipped its `addTabTree`,
   * TerminalContainer's default seed fired, and an API tab's `tm-*` root leaf
   * was replaced by a `tb-*` one — orphaning its PTY. The fix at the time was a
   * comment reading "Must mirror saveLayout", which is exactly the kind of
   * guarantee the NEXT field added to one branch quietly breaks. Scope support
   * would have been that next field: an update re-captured the whole workspace
   * while the spread kept `scope: 'tab'`, producing a layout that CLAIMS to be
   * one tab and CARRIES every tab.
   *
   * `scope: 'tab'` captures exactly one tab; `'workspace'` is the pre-existing
   * whole-workspace shape, byte-for-byte, so every existing caller and every
   * previously saved layout is unaffected.
   */
  private buildLayoutBody(
    state: RootState,
    scope: 'workspace' | 'tab',
    tabId?: string,
  ): Omit<SavedLayout, 'id' | 'name' | 'description' | 'createdAt' | 'updatedAt'> {
    if (scope !== 'tab') {
      return {
        tabs: state.tabs.tabs,
        activeTabId: state.tabs.activeTabId,
        paneTree: state.panes.paneTree,
        activePaneId: state.panes.activePaneId,
        // Per-tab, not just the active tab's tree — a background tab (e.g. an
        // API-created one) would otherwise have no saved tree at all and would
        // be restored as a `tb-` seed permanently (review 109 H2).
        treesByTabId: { ...state.panes.treesByTabId },
      };
    }

    if (!tabId) throw new Error('buildLayoutBody: scope "tab" requires a tabId');
    const tab = state.tabs.tabs.find(t => t.id === tabId);
    if (!tab) throw new Error(`buildLayoutBody: tab not found: ${tabId}`);

    // `in`, not `?? null`: the three states of a `treesByTabId` entry are
    // load-bearing (absent = never initialised, so TerminalContainer seeds one;
    // null = open and empty; a PaneNode = the tab's layout). Collapsing absent
    // into null here would round-trip a never-initialised tab back as an
    // explicitly-empty one — the exact distinction the workspace-scope branch
    // above preserves by spreading the map verbatim, and that
    // `populateWorkspace`'s `!== undefined` guard exists to honour.
    const hasTree = tabId in state.panes.treesByTabId;
    const tree = hasTree ? state.panes.treesByTabId[tabId] : null;
    // Only this tab's own directories, via the same keep-set filter
    // `saveState`'s autosave uses — a workspace-wide cwd map would leak
    // every OTHER tab's directory into a layout that claims to be one tab.
    const terminalCwds = pruneCwds(getAllCwdSnapshots(), new Set(getAllTerminalIds(tree)));

    const body: Omit<SavedLayout, 'id' | 'name' | 'description' | 'createdAt' | 'updatedAt'> = {
      tabs: [tab],
      activeTabId: tabId,
      paneTree: tree,
      activePaneId: state.panes.activePaneByTabId[tabId] ?? state.panes.activePaneId,
      // An absent entry stays ABSENT in the saved map (see `hasTree`).
      treesByTabId: hasTree ? { [tabId]: tree } : {},
      scope: 'tab',
      scopedTabId: tabId,
      terminalCwds,
    };
    // Only include the per-tab maps when this tab actually has an entry —
    // an absent key here (rather than a key holding `undefined`) is what
    // `loadTabScopedLayout` reads as "nothing to restore".
    if (tabId in state.panes.activePaneByTabId) {
      body.activePaneByTabId = { [tabId]: state.panes.activePaneByTabId[tabId] };
    }
    if (tabId in state.panes.maximizedPaneByTabId) {
      body.maximizedPaneByTabId = { [tabId]: state.panes.maximizedPaneByTabId[tabId] };
    }
    return body;
  }

  /**
   * Save current layout with a name.
   *
   * `opts.scope` (plan/025 §2.4) defaults to `'workspace'` — every call site
   * from before this feature existed keeps saving the whole workspace exactly
   * as it always has. `scope: 'tab'` instead captures ONE tab: a one-element
   * `tabs` array, a one-key `treesByTabId`, and that tab's own entries from the
   * three per-tab maps a workspace-scope save still does not carry (§0.2 — this
   * plan does not make the workspace-scope format lossless, only the tab one).
   */
  async saveLayout(
    name: string,
    description?: string,
    opts?: { scope?: 'workspace' | 'tab'; tabId?: string },
  ): Promise<string> {
    try {
      const store = (window as any).__REDUX_STORE__;
      if (!store) throw new Error('Store not available');

      const state: RootState = store.getState();
      const layoutId = `layout-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const scope = opts?.scope ?? 'workspace';
      const now = Date.now();

      const layout: SavedLayout = {
        id: layoutId,
        name,
        description,
        ...this.buildLayoutBody(state, scope, opts?.tabId),
        createdAt: now,
        updatedAt: now,
      };

      const existingLayouts = this.getSavedLayouts();
      existingLayouts.push(layout);

      localStorage.setItem(this.LAYOUTS_KEY, JSON.stringify(existingLayouts));

      // plan/025 §2.5: a WORKSPACE-scope save becomes the new "clean" reference.
      // A tab-scope save does NOT claim it — it never captured the whole
      // workspace, only one tab, so comparing the full workspace against it
      // would read every OTHER tab's ordinary state as "dirty". Best-effort,
      // same reasoning as `updateLayout`'s equivalent block.
      if (scope !== 'tab') {
        try {
          setLayoutBaseline(workspaceIdentity(captureWorkspaceSnapshot(state, name)));
        } catch (e) {
          console.warn('StateManager: could not record layout baseline after save:', e);
        }
      }

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
   * Returns `true` when this call committed the layout.
   *
   * Returns `false` when a NEWER `loadLayout` started before this one reached
   * its populate phase, so this call did NOT populate Redux, did NOT write
   * `lastUsed` to localStorage, and left the newer call to supply the
   * replacement state. It does NOT mean the call was side-effect free: an
   * abandoning call has already run `clearCurrentState`, tearing down the tabs
   * and pane trees that were present when it started. The only reason that is
   * safe is that the newer call (which must, by construction, have passed
   * lookup and sanitization before taking its generation token) clears again
   * and then populates. A `false` return therefore guarantees "some newer load
   * owns the state", never "nothing was touched".
   */
  async loadLayout(layoutId: string, dispatch: Dispatch): Promise<boolean> {
    return this.asReplacement(() => this.loadLayoutInner(layoutId, dispatch));
  }

  private async loadLayoutInner(layoutId: string, dispatch: Dispatch): Promise<boolean> {
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

      // plan/025 §2.3: snapshot the workspace we are about to REPLACE, before
      // any state is touched, so a later "Revert" can restore it. Both
      // statements are side-effect-free on failure: `captureWorkspaceSnapshot`
      // and `pushUndo` never dispatch, and the whole thing is wrapped so a
      // problem here (no store yet, or a store missing a slice this reads)
      // degrades to "no revert target for this switch" rather than aborting
      // the load. An empty workspace (nothing open yet) is never pushed — see
      // `isWorkspaceEmpty` — offering "revert to nothing" is worse than no
      // revert at all.
      try {
        const store = (window as any).__REDUX_STORE__;
        if (store) {
          const prior = captureWorkspaceSnapshot(store.getState(), `Workspace before loading "${layout.name}"`);
          if (!isWorkspaceEmpty(prior)) pushUndo(prior);
        }
      } catch (e) {
        console.warn('StateManager: could not snapshot workspace before load (Revert unavailable for this switch):', e);
      }

      // Round-6 HIGH (report 114). Everything below the `await` must be
      // guarded: two loads entering during the yield below BOTH clear the
      // current state, then the later one appends its tabs/trees on top of the
      // earlier one's freshly populated state (duplicate tabs when the layouts
      // share tab ids, and a stale localStorage write). Only the newest
      // generation may commit.
      //
      // The token is taken HERE, not at method entry: it must only ever be
      // held by a request that is actually able to enter the replacement
      // transaction. Lookup (`Layout not found`) and `sanitizeLayoutData` can
      // both throw, and a call that throws never clears and never populates —
      // if it had already bumped the generation it would silently invalidate a
      // valid in-flight load that was sitting in the yield below, having
      // ALREADY cleared. Neither request would then supply the replacement and
      // the app would be left empty. Acquiring the token immediately before
      // `clearCurrentState` makes "holds the generation" equivalent to "has
      // cleared and intends to populate".
      const generation = ++this.loadGeneration;

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

      // plan/025 §2.3: the actual populate — tabs, keyed trees, activation,
      // plus the per-tab focus/maximize/canvas restores a `SavedLayout` never
      // carries — is `populateWorkspace` (extracted verbatim from this method;
      // see its own header for the invariants it preserves).
      this.populateWorkspace(sanitizedLayout, dispatch);

      // plan/025 §2.5: the newly loaded layout becomes the "clean" reference
      // for dirty tracking. Best-effort for the same reason as the snapshot
      // above — a throw here must not turn a successful load into a rejection.
      try {
        const store = (window as any).__REDUX_STORE__;
        if (store) {
          setLayoutBaseline(workspaceIdentity(captureWorkspaceSnapshot(store.getState(), sanitizedLayout.name)));
        }
      } catch (e) {
        console.warn('StateManager: could not record layout baseline after load:', e);
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
   * Populate Redux with a workspace description — tabs, per-tab trees,
   * activation, and (when present) the per-tab focus/maximize/canvas restores
   * a `SavedLayout` never carried. Called by `loadLayout` (a `SavedLayout` —
   * `treesByTabId`/`activePaneByTabId`/`maximizedPaneByTabId`/`tabPanes`/
   * `terminalCwds`/`canvas` are absent there) and `revertWorkspace` (a full
   * `WorkspaceSnapshot`, where all of them are present).
   *
   * **Extracted VERBATIM from `loadLayout` (plan/025 Task A3) — comments
   * included.** `loadLayout` is seven external-review rounds deep and every
   * comment on the block below records a bug that actually shipped; do not
   * "tidy" it. The token acquisition, `clearCurrentState`, the 100ms yield and
   * the generation re-check all stay in the CALLERS (§0.3) — this method only
   * ever runs once a caller has already decided it owns the transaction.
   */
  private populateWorkspace(
    data: {
      tabs: any[];
      activeTabId: string | null;
      activePaneId: string | null;
      paneTree: any;
      treesByTabId?: Record<string, any>;
      activePaneByTabId?: Record<string, string>;
      maximizedPaneByTabId?: Record<string, string>;
      tabPanes?: Record<string, any>;
      terminalCwds?: Record<string, string>;
      canvas?: CanvasPersisted;
    },
    dispatch: Dispatch,
  ): void {
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
    if (data.tabs?.length > 0) {
      console.log(`Loading ${data.tabs.length} tabs`);

      // Restore tab panes mapping IMMEDIATELY before creating tabs, exactly as
      // `restoreState` does above — a `WorkspaceSnapshot` (`revertWorkspace`)
      // carries this field; a `SavedLayout` (`loadLayout`) does not, so this is
      // a no-op there. Per `workspaceSnapshot.ts`'s header: capturing
      // `tabPanes` is THAT module's job, restoring it back onto
      // `window.__TAB_PANES__` is this one's.
      if (data.tabPanes) {
        console.log('Restoring tab panes mapping for all tabs:', Object.keys(data.tabPanes));
        restoreTabPanesInPlace(data.tabPanes);
      }

      for (const tab of data.tabs) {
        dispatch(addTab({
          ...tab,
          isActive: false // Ensure tabs are not active initially
        }));
        // `!== undefined`, not truthiness: a saved layout can legitimately hold `null`
        // for a tab that is open and empty, and skipping that dispatch left the key
        // absent — which TerminalContainer reads as "never initialised" and fills with a
        // fresh terminal. Loading a layout then silently refilled the tab the user had
        // deliberately emptied before saving it.
        const tabTree = data.treesByTabId?.[tab.id];
        if (tabTree !== undefined) {
          dispatch(addTabTree({ tabId: tab.id, tree: tabTree }));
        }
      }

      // OLD-format layout (saved before `treesByTabId` existed): its single
      // `paneTree` belongs to the SAVED active tab. Install it explicitly
      // under that owner. Other tabs of such a layout keep today's behavior
      // (seeded by TerminalContainer).
      if (
        data.paneTree &&
        data.activeTabId &&
        !data.treesByTabId?.[data.activeTabId]
      ) {
        dispatch(addTabTree({
          tabId: data.activeTabId,
          tree: data.paneTree,
        }));
      }

      // The restores a `SavedLayout` never had (plan/025 §0.2/§2.3): per-tab
      // focus and per-tab maximize. Both maps are optional — absent for every
      // `loadLayout` call, present only for a `WorkspaceSnapshot`
      // (`revertWorkspace`). Dispatched AFTER the tree writes above (so
      // `focusPaneInTab`'s `findLeaf` guard can see the tree) and BEFORE the
      // "Activate synchronously" block below, so that block's explicit
      // `focusPane(data.activePaneId)` — the CURRENT tab's true active pane,
      // which can be fresher than its own entry here (`activePaneByTabId` is
      // only refreshed on tab-switch, see `panesSlice.setActiveTabId`) — still
      // wins for the active tab.
      if (data.activePaneByTabId) {
        for (const [tabId, paneId] of Object.entries(data.activePaneByTabId)) {
          dispatch(focusPaneInTab({ tabId, paneId }));
        }
      }
      if (data.maximizedPaneByTabId) {
        for (const [tabId, paneId] of Object.entries(data.maximizedPaneByTabId)) {
          // A SET, never a toggle. A toggle is idempotent only from a
          // known-empty start, and arguing that from "the caller ran
          // `resetPanes` first" is a guarantee the next caller opts out of
          // without noticing — `loadTabScopedLayout` is already exactly that
          // caller. See the reducer's own comment.
          dispatch(setMaximizedPane({ tabId, paneId }));
        }
      }

      // Activate synchronously, in the same pass as the keyed tree writes.
      if (data.activeTabId) {
        console.log(`Setting active tab: ${data.activeTabId}`);
        dispatch(setActiveTab(data.activeTabId));
        dispatch(setActiveTabId(data.activeTabId));

        if (data.activePaneId) {
          dispatch(focusPane(data.activePaneId));
        }
      }

      // Canvas geometry (plan/025 §2.3), restored the same way `restoreState`
      // does it above: a `SavedLayout` never carries `canvas` (a no-op here for
      // `loadLayout`), a `WorkspaceSnapshot` always does (`revertWorkspace`).
      // The two id lists come from their OWN sources and are not
      // interchangeable even though they overlap (design 011 D7).
      if (data.canvas) {
        const leafIds = new Set<string>();
        const walkLeaves = (node: any): void => {
          if (!node) return;
          if (node.type === 'terminal' && node.terminalId) leafIds.add(node.terminalId);
          if (Array.isArray(node.children)) node.children.forEach(walkLeaves);
        };
        Object.values(data.tabPanes || {}).forEach(walkLeaves);
        Object.values(data.treesByTabId || {}).forEach(walkLeaves);
        walkLeaves(data.paneTree);
        const tabIds = data.tabs.map((t: any) => t?.id).filter(Boolean);
        const canvas = sanitizeCanvasState(data.canvas, [...leafIds], tabIds, restoreZMax());
        if (canvas) dispatch(hydrateCanvas(canvas));
      }
    }
  }

  /**
   * Restore the workspace exactly as it was immediately before the last
   * `loadLayout` (or `loadTabScopedLayout`) — the "Revert" action (plan/025
   * §2.2/§2.3). Consumes the one-deep undo slot (`takeUndo`): reverting is not
   * itself undoable, and a superseded revert (see below) does not restore it —
   * the same "abandon, do not roll back" rule `loadLayout` uses.
   *
   * Same replacement-transaction shape as `loadLayout` — the generation token,
   * `clearCurrentState`, the 100ms yield, the generation re-check — for the
   * identical reason (see the long comment on `loadLayout` above): a second
   * load/revert entering during the yield must be the one to win, not both of
   * them layering on top of each other. Backlog 006's arbiter would replace
   * both call sites' copy of this shape with one; this plan does not attempt
   * that (§0.3).
   *
   * Runs `seedRestoredCwds` then `reconcileExistingTerminals` BEFORE
   * populating — exactly `restoreState`'s order — because a persisted undo
   * snapshot can be revived after a reload, when `TerminalService.processes`
   * is empty and the restored ids do not point at anything live until
   * reconciled against the backend (plan/025 §2.2 "Risks").
   */
  async revertWorkspace(dispatch: Dispatch): Promise<boolean> {
    return this.asReplacement(() => this.revertWorkspaceInner(dispatch));
  }

  private async revertWorkspaceInner(dispatch: Dispatch): Promise<boolean> {
    // PEEK, do not take. The slot is consumed only once this call has actually
    // committed (below), because every early exit from the transaction — the
    // supersede return, or a throw — would otherwise have already destroyed the
    // one copy of the workspace the user asked to get back, with nothing
    // restored in its place and no error they could act on. "Consume on
    // success" is the only ordering under which a failed revert is a no-op
    // rather than a silent total loss.
    const snapshot = peekUndo();
    // A structurally invalid snapshot is NOT a revert target. `layoutUndo`
    // hydrates from localStorage, where a truncated or foreign write parses
    // fine as an object while carrying no `tabs` — and `{}` is truthy, so a
    // bare null-check would let it through: `clearCurrentState` would wipe the
    // live workspace and `populateWorkspace` would then no-op on it (its body
    // is entirely inside `if (data.tabs?.length > 0)`), reporting success
    // while leaving the window empty.
    if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) {
      if (snapshot) {
        console.warn('StateManager: undo snapshot is unusable, discarding rather than reverting into it');
        clearUndo();
      }
      return false;
    }

    try {
      // Same invariant as `loadLayout`: only a call that can actually enter the
      // replacement transaction may hold the token. Everything above is a
      // read plus validation, so reaching here means this call intends to
      // clear and populate.
      const generation = ++this.loadGeneration;

      this.clearCurrentState(dispatch);

      await new Promise(resolve => setTimeout(resolve, 100));

      if (generation !== this.loadGeneration) {
        console.log('Workspace revert superseded, abandoning');
        return false;
      }

      // Spec 045 §3.3: seed saved directories BEFORE any tab/pane is created,
      // same reasoning as `restoreState`.
      seedRestoredCwds(snapshot.terminalCwds);

      // Best-effort reattach to whatever survived a reload — a near no-op when
      // `TerminalService`'s map is already warm (nothing reloaded), and the
      // only way a persisted undo snapshot's ids point at anything live again
      // after one.
      await this.reconcileExistingTerminals({ tabs: snapshot.tabs, tabPanes: snapshot.tabPanes });

      // The token must be re-checked after EVERY await, not just the yield.
      // This one is not a formality: `reconcileExistingTerminals` awaits
      // `apiBase()`, a `fetch` and a `json()` on every ordinary revert, so it
      // is a real window in which a newer load or revert can take the token,
      // clear, and populate. Committing after that would layer this snapshot
      // on top of the winner's freshly populated state — the exact duplicate
      // -tabs failure `loadLayout`'s own guard exists to prevent.
      if (generation !== this.loadGeneration) {
        console.log('Workspace revert superseded during reattach, abandoning');
        return false;
      }

      this.populateWorkspace(snapshot, dispatch);

      // Committed — only NOW is the slot spent. Reverting is not itself
      // undoable, which is why this consumes rather than leaves it.
      takeUndo();

      // plan/025 §2.5: the reverted-to workspace becomes the new "clean"
      // reference. Best-effort — `workspaceIdentity` is a pure stringify and
      // should not throw, but a baseline miss must never fail the revert.
      try {
        setLayoutBaseline(workspaceIdentity(snapshot));
      } catch (e) {
        console.warn('StateManager: could not record layout baseline after revert:', e);
      }

      console.log(`Workspace reverted to "${snapshot.label}"`);
      return true;
    } catch (error) {
      console.error('Failed to revert workspace:', error);
      throw error;
    }
  }

  /**
   * Load a TAB-scoped layout (plan/025 §2.4). Deliberately NOT a replacement
   * transaction — no generation token, no `clearCurrentState`, no yield — a
   * workspace load replaces everything the user has open; a tab load must
   * touch ONLY the one tab it targets, leaving every other tab (and its tree
   * in `treesByTabId`) byte-identical.
   */
  async loadTabScopedLayout(layoutId: string, dispatch: Dispatch): Promise<boolean> {
    try {
      const store = (window as any).__REDUX_STORE__;
      if (!store) throw new Error('Store not available');

      // A tab-scoped load is not a replacement and takes no generation token,
      // so it must not run while one owns the workspace — see
      // `replacementInFlight` for what layering looks like.
      if (this.replacementInFlight) {
        console.warn('StateManager: tab-scoped load ignored — a workspace replacement is already in flight');
        return false;
      }

      const layouts = this.getSavedLayouts();
      const layout = layouts.find(l => l.id === layoutId);
      if (!layout) throw new Error('Layout not found');

      const sanitizedLayout = this.sanitizeLayoutData(layout);

      // 1. Resolve the target tab id: the saved `scopedTabId`, else the single
      // entry a tab-scoped layout's `tabs` array always has. Resolved via
      // `savedTab.id` (not the raw `scopedTabId` directly) so this still lines
      // up correctly on the rare layout whose tab id `sanitizeLayoutData`
      // remapped (a non-`tb-`-prefixed id) — `scopedTabId` itself is not one of
      // that function's known fields, so it passes through UNCHANGED.
      const rawTargetId = sanitizedLayout.scopedTabId ?? sanitizedLayout.tabs?.[0]?.id;
      if (!rawTargetId) throw new Error('Tab-scoped layout has no target tab');
      const savedTab = sanitizedLayout.tabs.find((t: any) => t.id === rawTargetId) ?? sanitizedLayout.tabs[0];
      const targetTabId = savedTab.id;

      // plan/025 §2.4 step 5: "reverting a tab load is the same gesture" — push
      // an undo snapshot here too, before this tab load touches anything.
      // Best-effort, same reasoning as `loadLayout`'s equivalent snapshot.
      try {
        const prior = captureWorkspaceSnapshot(
          store.getState(),
          `Workspace before loading tab layout "${sanitizedLayout.name}"`,
        );
        if (!isWorkspaceEmpty(prior)) pushUndo(prior);
      } catch (e) {
        console.warn('StateManager: could not snapshot workspace before tab load:', e);
      }

      const state: RootState = store.getState();

      // 2. Collision guard (§2.4 step 2). `findTabIdByTerminalId` returns the
      // FIRST match, so a terminal id already live in a DIFFERENT tab would be
      // silently claimed by both this tab and its original owner. Re-mint it
      // via `generateId('tm')` and DROP the old id rather than carrying it into
      // `sessionKey`.
      //
      // That is the opposite of what `sanitizeLayoutData` does for a pre-014
      // leaf, deliberately. There, preserving the old key is required: the
      // pty-host has no rename verb and the session being renamed is OURS.
      // Here the id collides precisely because the session belongs to another
      // tab's LIVE terminal — carrying the key would make this fresh spawn
      // overwrite `session_to_process` and steal that terminal's output.
      //
      // Every re-mint is recorded in `remintedIds` because a terminal id is a
      // KEY, not just a value: `terminalCwds` is keyed by it, and seeding the
      // saved directories under the OLD id would silently drop the cwd of
      // exactly the terminals this guard renamed — they would come back in the
      // default directory while their uncollided siblings came back in place.
      // Re-keying a map means auditing its READERS, not only its writers.
      const remintedIds = new Map<string, string>();
      // Pane ids are re-minted on the same rule as terminal ids, and for the same
      // reason: an id that is ALREADY LIVE somewhere else must not be installed a
      // second time.
      //
      // Pane-id uniqueness across tabs is not a nicety, it is an assumption the
      // codebase acts on. `setPaneMuted` walks every tab's tree and returns at the
      // FIRST leaf carrying the id; so does `paneActions.findLeafInAnyTree`; and
      // `PaneContextMenu` derives "am I the maximized pane?" from a bare
      // `Object.values(maximizedPaneByTabId).includes(paneId)` under a comment that
      // says outright "Pane ids are unique across tabs". Duplicate one and those
      // operations silently act on the OTHER tab's pane — muting, splitting or
      // maximizing something the user is not looking at.
      //
      // Reachable without anything exotic: save tab A, drag pane `pn-x` from A into
      // tab B (the node keeps its id), then load A's saved tab layout.
      const remintedPaneIds = new Map<string, string>();
      const paneIdIsLiveElsewhere = (paneId: string): boolean =>
        Object.keys(state.panes.treesByTabId).some(
          tid => tid !== targetTabId && !!findLeaf(state.panes.treesByTabId[tid], paneId),
        );
      const remintCollisions = (node: any): any => {
        if (!node) return node;
        let next = node;
        if (next.id && paneIdIsLiveElsewhere(next.id)) {
          const freshPane = remintedPaneIds.get(next.id) ?? generateId('pn');
          remintedPaneIds.set(next.id, freshPane);
          next = { ...next, id: freshPane };
        }
        node = next;
        if (node.type === 'terminal' && node.terminalId) {
          const owner = findTabIdByTerminalId(state.panes.treesByTabId, node.terminalId);
          if (owner !== null && owner !== targetTabId) {
            const fresh = generateId('tm');
            // FIRST mapping wins. A well-formed saved tree cannot carry the
            // same terminal id twice, but an imported or hand-edited one can,
            // and letting the second leaf overwrite the first's entry would
            // silently hand the one saved cwd to whichever leaf happened to be
            // visited last.
            if (!remintedIds.has(node.terminalId)) remintedIds.set(node.terminalId, fresh);
            // The colliding id is DROPPED, not carried into `sessionKey`.
            //
            // `sessionKey` means "the pty-host already knows this session by
            // this id", and the whole reason we are re-minting is that some
            // OTHER tab's still-running terminal is the one the host knows by
            // it. Claiming it here is not a harmless label: the spawn path
            // forwards `sessionKey` to `create_terminal`, and the backend's
            // `register_host_terminal` indexes `session_to_process` with an
            // unconditional insert — so the fresh spawn would take over the
            // live terminal's routing key and every inbound frame for the
            // ORIGINAL, still-visible terminal would be delivered to this new
            // process instead. A re-minted leaf is by definition a terminal
            // whose identity is already taken, so it must start a genuinely
            // new session.
            //
            // `seededForTabId` goes with it. It records which tab a leaf was
            // seeded FOR, and this leaf is being installed into `targetTabId`
            // under a brand-new identity — keeping a claim on some other tab
            // hands `tabTreeSeed`'s ownership tiebreak a false owner.
            const {
              sessionKey: _claimedByALiveTerminal,
              seededForTabId: _staleOwnershipClaim,
              ...rest
            } = node;
            return { ...rest, terminalId: fresh };
          }
        }
        if (node.type === 'split' && Array.isArray(node.children)) {
          return { ...node, children: node.children.map(remintCollisions) };
        }
        return node;
      };
      // The saved entry may legitimately be ABSENT (a tab that was never given
      // a tree) — distinct from present-and-null (open and empty). Only an
      // entry that actually exists is dispatched, mirroring `populateWorkspace`'s
      // `!== undefined` guard; an absent one leaves TerminalContainer's seed
      // effect to do what it does for any uninitialised tab. A legacy
      // single-`paneTree` layout still supplies its tree through the fallback.
      const savedTree =
        sanitizedLayout.treesByTabId && targetTabId in sanitizedLayout.treesByTabId
          ? sanitizedLayout.treesByTabId[targetTabId]
          : sanitizedLayout.paneTree ?? undefined;
      const tree = savedTree === undefined ? undefined : remintCollisions(savedTree);

      // 3. Install the tab: patch durable fields in place if it already
      // exists — `removeTab` + `addTab` would destroy the tree the very next
      // line installs (`TerminalContainer`'s cleanup effect reacts to a tab's
      // disappearance by dropping its tree) — else create it fresh. Either
      // way, the tree is dispatched in the SAME synchronous block as the tab
      // itself (review 109 H2's rule).
      const tabExists = state.tabs.tabs.some(t => t.id === targetTabId);
      if (tabExists) {
        dispatch(updateTabMeta({
          id: targetTabId,
          patch: {
            title: savedTab.title,
            shellType: savedTab.shellType,
            icon: savedTab.icon,
            colorSchemaId: savedTab.colorSchemaId,
            titleColor: savedTab.titleColor,
            titleIsCustom: savedTab.titleIsCustom,
            notifyMuted: savedTab.notifyMuted,
          },
        }));
      } else {
        dispatch(addTab({ ...savedTab, id: targetTabId, isActive: false }));
      }
      if (tree !== undefined) dispatch(addTabTree({ tabId: targetTabId, tree }));

      // 4. Activate, then the per-tab maps this ONE tab carries (§0.2 lossiness
      // does not apply to a tab-scoped save — see `SavedLayout.activePaneByTabId`).
      dispatch(setActiveTab(targetTabId));
      dispatch(setActiveTabId(targetTabId));
      // Through `remintedPaneIds`, because these three fields REFERENCE pane ids
      // rather than containing them — remapping the tree but not its referrers
      // would leave the restored tab focusing and maximizing panes that no longer
      // exist in it (and, worse, that DO still exist in the tab we re-minted away
      // from). Re-keying a map means auditing its readers.
      const remap = (id: string | null | undefined): string | undefined =>
        id === undefined || id === null ? undefined : remintedPaneIds.get(id) ?? id;
      const activePaneId = remap(
        sanitizedLayout.activePaneByTabId?.[targetTabId] ?? sanitizedLayout.activePaneId,
      );
      // `focusPaneInTab`, not `focusPane`: this also records the pane in
      // `activePaneByTabId[targetTabId]` (not just the top-level
      // `activePaneId` mirror), so the tab's remembered focus survives a later
      // switch away and back, exactly like any other tab's.
      if (activePaneId) dispatch(focusPaneInTab({ tabId: targetTabId, paneId: activePaneId }));
      // A SET, and dispatched UNCONDITIONALLY. Two distinct bugs live here,
      // both invisible because this path never runs `resetPanes`:
      //   - a toggle would DELETE the entry when the target pane happens to be
      //     maximized already, i.e. the restore un-maximizes the very pane the
      //     layout asked to maximize;
      //   - skipping the dispatch when the layout saved no maximize would leave
      //     the tab's CURRENT maximize in place, so the restored tab keeps a
      //     zoomed pane the saved layout does not describe.
      // `null` clears, which is what "this layout has no maximized pane" means.
      dispatch(setMaximizedPane({
        tabId: targetTabId,
        paneId: remap(sanitizedLayout.maximizedPaneByTabId?.[targetTabId]) ?? null,
      }));
      if (sanitizedLayout.terminalCwds) {
        // Re-key onto the ids the tree actually carries (see `remintedIds`).
        // A no-op when nothing collided, which is the ordinary case.
        seedRestoredCwds(
          remintedIds.size === 0
            ? sanitizedLayout.terminalCwds
            : Object.fromEntries(
                Object.entries(sanitizedLayout.terminalCwds)
                  .map(([id, cwd]) => [remintedIds.get(id) ?? id, cwd]),
              ),
        );
      }

      console.log(`Tab-scoped layout "${sanitizedLayout.name}" loaded into tab ${targetTabId}`);
      return true;
    } catch (error) {
      console.error('Failed to load tab-scoped layout:', error);
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
   * Reset to default layout (single tab with default shell).
   *
   * Returns whether the reset actually happened. It can decline (a replacement
   * owns the workspace) or fail, and the caller has its OWN half of the reset
   * to perform — `layoutsSlice.resetLayoutTracking` clears `activeLayoutId` and
   * `isDirty` while this clears the undo slot and the identity baseline. A
   * `void` return let the caller dispatch its half unconditionally, so a
   * declined reset still tore up the Redux tracking for a workspace that had
   * not been reset: the two halves this method exists to keep in step, split.
   */
  resetToDefaultLayout(dispatch: Dispatch): boolean {
    // Synchronous, so it cannot be interrupted mid-flight — but dispatched
    // INTO another replacement's yield it layers exactly the same way a
    // tab-scoped load would. See `replacementInFlight`.
    if (this.replacementInFlight) {
      console.warn('StateManager: reset ignored — a workspace replacement is already in flight');
      return false;
    }
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
      
      // A reset discards the workspace the undo slot describes, so the slot's
      // target is no longer the thing the user would be taken back to:
      // after Switch then Reset, Revert would skip OVER the reset and restore
      // a pre-switch workspace the user has since deliberately thrown away.
      // Same reasoning for the baseline — the default layout is not the
      // layout the baseline was captured from, and leaving it installed lets
      // a freshly-reset workspace compare CLEAN against a named layout it no
      // longer resembles. `layoutsSlice.resetLayoutTracking` clears the Redux
      // half (`activeLayoutId`/`isDirty`); these two clear the module half.
      clearUndo();
      clearLayoutBaseline();
      console.log('Reset to default layout');
      return true;
    } catch (error) {
      console.error('Failed to reset layout:', error);
      return false;
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
    // ...and every session-closed record with them (`plan/024` Req 4). The per-terminal close
    // paths (PaneManager, TabManager) clear one entry each, but this path discards the whole
    // workspace WITHOUT going through either — so without this, loading a layout would strand
    // an entry for every terminal that had exited under the previous one.
    dispatch(clearAllSessionClosed());
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
  /**
   * Move persisted scrollback so it follows leaves that sanitisation renamed.
   *
   * Sequential rather than `Promise.all`: every call takes the same SQLite
   * mutex, so concurrency buys nothing and a burst would contend with the 30s
   * scrollback flush holding that mutex over multi-MB blobs.
   *
   * Never throws. A row that will not move costs one pane its restored
   * scrollback; letting that abort `restoreState` would cost the whole session.
   */
  private async migrateHistoryForRenamedLeaves(renames: Map<string, string>): Promise<void> {
    if (renames.size === 0) return;
    const rename = window.electronAPI?.renameTerminalHistory;
    if (!rename) return; // browser/dev bridge without the command — nothing to do
    console.log(`StateManager: migrating scrollback for ${renames.size} renamed leaf/leaves`);
    for (const [from, to] of renames) {
      try {
        await rename(from, to);
      } catch (err) {
        console.warn(`StateManager: could not move scrollback ${from} -> ${to}:`, err);
      }
    }
  }

  private sanitizeLayoutData<T extends {
    tabs: any[];
    activeTabId: string | null;
    paneTree: any;
    activePaneId: string | null;
    tabPanes?: { [tabId: string]: any };
    terminalCwds?: { [terminalId: string]: string };
    treesByTabId?: { [tabId: string]: any };
  }>(data: T, renamesOut?: Map<string, string>): T {
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
          // DESIGN 014 MIGRATION — ONE rule: a live leaf is a `tm-`, so anything
          // else is pre-014 and gets migrated. This was three narrower branches,
          // and each gap was silent:
          //   - keyed on `terminalId === tabId`, so a pre-014 root leaf DRAGGED
          //     into another tab never matched its host tab's id and stayed a
          //     `tb-` forever;
          //   - a legacy (UUID) tab id was rewritten to the tab's NEW `tb-` id,
          //     i.e. it minted a fresh `tb-` leaf — the exact id shape 014 removed;
          //   - a non-prefixed split leaf minted without consulting
          //     `terminalIdMap`, so the two passes below produced different ids.
          //
          // The old id is kept as `sessionKey`: the pty-host still knows this
          // session by it and its protocol has NO rename verb, so moving the leaf
          // without recording the old key orphans an armed session (design 014 §A2).
          //
          // Reuses an existing mapping because `sanitizeNode` runs TWICE over the
          // same logical tree (see the guard below) and `generateId` is
          // non-deterministic — minting twice would put a different id on each pass.
          if (!oldTerminalId.startsWith('tm-')) {
            newNode.terminalId = terminalIdMap.get(oldTerminalId) ?? generateId('tm');
            if (newNode.sessionKey === undefined) newNode.sessionKey = oldTerminalId;
            // `seededForTabId` records the ownership the id equality used to imply,
            // which `tabTreeSeed` Rule 3 and the duplicate-leaf tiebreak depend on.
            // Set ONLY when the old id was a TAB id, i.e. this really was a tab's
            // root leaf. A plain split leaf never owned a tab, and claiming one for
            // it here would hand `claimsItsOwnId` a false owner.
            const bornAsTab =
              tabIdMap.get(oldTerminalId) ??
              (oldTerminalId.startsWith('tb-') || oldTerminalId.startsWith('tab-')
                ? oldTerminalId
                : oldTerminalId === tabId
                  ? tabId
                  : undefined);
            if (newNode.seededForTabId === undefined && bornAsTab !== undefined) {
              newNode.seededForTabId = bornAsTab;
            }
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

    // Surface the leaf renames so the caller can move the persisted scrollback
    // rows to match (design 014 §A4). Deliberately the SAME map `remapCwds`
    // consumes: the cwd and the history must follow a leaf together, or a
    // migrated pane comes back with one and not the other.
    if (renamesOut) {
      for (const [from, to] of terminalIdMap) renamesOut.set(from, to);
    }

    return result;
  }
}

export const StateManager = new StateManagerClass();