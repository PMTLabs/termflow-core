/**
 * plan/025 §2.1 — a superset of `SavedLayout` that captures everything a user
 * would notice missing after a layout switch and back: per-tab focus/maximize,
 * terminal cwds, and canvas geometry, none of which `SavedLayout` carries
 * (see plan/025 §0.2). Used by `layoutUndo.ts` (the one-deep revert slot) and
 * by `layoutBaseline.ts` (dirty tracking) — never mutated once captured.
 */
import { RootState } from '../store';
import { Tab } from '../store/slices/tabsSlice';
import { PaneNode } from '../store/slices/panesSlice';
import { CanvasPersisted } from '../store/slices/canvasSlice';
import { getTabPanesGlobal } from './tabPanesStore';
import { getAllCwdSnapshots } from './cwdSnapshot';

export interface WorkspaceSnapshot {
  tabs: Tab[];
  activeTabId: string | null;
  paneTree: PaneNode | null;
  activePaneId: string | null;
  treesByTabId: Record<string, PaneNode | null>;
  activePaneByTabId: Record<string, string>;
  maximizedPaneByTabId: Record<string, string>;
  tabPanes: Record<string, PaneNode>;
  terminalCwds: Record<string, string>;
  canvas?: CanvasPersisted;
  capturedAt: number;
  label: string;
}

/**
 * Capture everything needed to put the workspace back exactly as it is now.
 *
 * `treesByTabId` is spread, not filtered — key-ABSENT ("never initialised")
 * and value-NULL ("open and empty") are a load-bearing distinction
 * (`panesSlice.ts:50-52`); an `if (tree)` guard here would collapse both into
 * "absent" and a restore would refill a tab the user had deliberately emptied.
 */
export function captureWorkspaceSnapshot(state: RootState, label: string): WorkspaceSnapshot {
  return {
    tabs: [...state.tabs.tabs],
    activeTabId: state.tabs.activeTabId,
    paneTree: state.panes.paneTree,
    activePaneId: state.panes.activePaneId,
    treesByTabId: { ...state.panes.treesByTabId },
    activePaneByTabId: { ...state.panes.activePaneByTabId },
    maximizedPaneByTabId: { ...state.panes.maximizedPaneByTabId },
    // `window.__TAB_PANES__`'s identity must never be replaced — that object IS the
    // thing `tabPanesStore.ts` exists to keep stable, and `clearTabPanesInPlace` /
    // `restoreTabPanesInPlace` mutate it IN PLACE (delete every key, then reassign).
    // Storing a reference to it here would mean a later clear silently erases this
    // "frozen" snapshot too. A shallow copy decouples the two: the individual
    // PaneNode values are Redux-immutable, so only the top-level container needs
    // copying. Restoring this field back out goes through `restoreTabPanesInPlace`
    // (not this module's job — see `layoutUndo.ts` consumers).
    tabPanes: { ...getTabPanesGlobal() },
    // Already a fresh object per call (`Object.fromEntries` over the live map).
    terminalCwds: getAllCwdSnapshots(),
    // Only the CanvasPersisted fields — never `edges` (backend-owned) or the
    // live-only UI fields (`focusedId`, `selectedId`, ...). Same projection
    // `StateManager.saveState` uses.
    canvas: {
      viewport: state.canvas.viewport,
      nodes: state.canvas.nodes,
      groups: state.canvas.groups,
      sidebarOpen: state.canvas.sidebarOpen,
      sidebarWidth: state.canvas.sidebarWidth,
      sidebarZoom: state.canvas.sidebarZoom,
    },
    capturedAt: Date.now(),
    label,
  };
}

/**
 * The durable projection of one `Tab` — every field EXCEPT the six transient
 * ones that are recomputed at runtime and never describe a user edit:
 * `processId`, `exited`, `isRunning`, `hasBackgroundActivity`, `activityTick`,
 * `hasUnseenOutput` (`tabsSlice.ts:6-50`; the same set `StateManager`'s
 * `sanitizeLayoutData` strips on load). Written as a fixed-key-order literal,
 * not a destructured rest-spread, so the field order is the same across two
 * `Tab` objects built by different code paths (a fresh `addTab` vs. one that
 * round-tripped through JSON) — required for `JSON.stringify` to double as a
 * stable deep-equality check.
 */
function durableTab(tab: Tab) {
  return {
    id: tab.id,
    title: tab.title,
    shellType: tab.shellType,
    isActive: tab.isActive,
    isDirty: tab.isDirty,
    icon: tab.icon,
    exitCode: tab.exitCode,
    colorSchemaId: tab.colorSchemaId,
    titleColor: tab.titleColor,
    titleIsCustom: tab.titleIsCustom,
    notifyMuted: tab.notifyMuted,
  };
}

/** `Object.entries` sorted by key, so stringifying a `Record` is order-independent —
 *  the same trick `settingsDirty.ts` uses for `agentColorSchemes`/`customKeybindings`. */
function sortedEntries<T>(record: Record<string, T>): Array<[string, T]> {
  return Object.entries(record).sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * A stable identity string for a snapshot's DURABLE content.
 *
 * Follows the `settingsDirty.ts` technique: build a fixed-key-order projection,
 * then `JSON.stringify` it, so `===` on the result is a stable deep compare.
 *
 * `capturedAt` and `label` are deliberately excluded — they are metadata ABOUT
 * the snapshot, not workspace content. Including either would make two
 * captures of the exact same unchanged workspace compare as different (every
 * capture has a new timestamp), which is precisely the false-dirty result this
 * function exists to avoid.
 */
export function workspaceIdentity(s: WorkspaceSnapshot): string {
  return JSON.stringify({
    tabs: s.tabs.map(durableTab),
    activeTabId: s.activeTabId,
    paneTree: s.paneTree,
    activePaneId: s.activePaneId,
    treesByTabId: sortedEntries(s.treesByTabId),
    activePaneByTabId: sortedEntries(s.activePaneByTabId),
    maximizedPaneByTabId: sortedEntries(s.maximizedPaneByTabId),
    tabPanes: sortedEntries(s.tabPanes),
    terminalCwds: sortedEntries(s.terminalCwds),
    canvas: s.canvas,
  });
}

/** No tabs means nothing to revert to — offering "revert to nothing" is worse
 *  than not offering revert at all (plan/025 §2.2). */
export function isWorkspaceEmpty(s: WorkspaceSnapshot): boolean {
  return s.tabs.length === 0;
}

/** The five fields a workspace-scope `SavedLayout` and a live `WorkspaceSnapshot`
 *  both carry. Structural, so either shape satisfies it without a cast. */
export interface LayoutShaped {
  tabs: Tab[];
  activeTabId: string | null;
  paneTree: PaneNode | null;
  activePaneId: string | null;
  treesByTabId?: Record<string, PaneNode | null>;
}

/**
 * A stable identity over ONLY what a workspace-scope saved layout can hold.
 *
 * `workspaceIdentity` above cannot be used to compare a workspace against a
 * SAVED layout, and not merely because it would give a wrong answer: it would
 * THROW. `StateManager.buildLayoutBody` writes exactly
 * `{ tabs, activeTabId, paneTree, activePaneId, treesByTabId }` for a
 * workspace-scope save, so `tabPanes` and `canvas` are absent from every saved
 * layout that has ever existed, and `activePaneByTabId` / `maximizedPaneByTabId`
 * / `terminalCwds` are present only on TAB-scoped saves. `sortedEntries` calls
 * `Object.entries(undefined)` on any of those and raises a TypeError.
 *
 * So this is a deliberately WEAKER comparison, and the weakness is the point.
 * The fields it drops are exactly the ones a workspace layout does not persist:
 * per-tab focus, per-tab maximize, working directories and canvas geometry.
 * A workspace that differs from a saved layout ONLY in those is a workspace
 * whose difference that layout could not have stored — so offering to "save"
 * it before switching would not preserve the difference either. Gating on it
 * offers the user a remedy that does not work.
 *
 * What it does NOT license is comparing against a tab-scoped layout: a one-tab
 * layout is not a claim about the whole workspace, and the caller must exclude
 * those. See `matchesAnySavedWorkspace`.
 */
export function layoutShapeIdentity(s: LayoutShaped): string {
  return JSON.stringify({
    tabs: (s.tabs ?? []).map(durableTab),
    activeTabId: s.activeTabId ?? null,
    paneTree: s.paneTree ?? null,
    activePaneId: s.activePaneId ?? null,
    // `?? {}` rather than a required field: `treesByTabId` is optional on
    // `SavedLayout` for backward compatibility with layouts saved before it
    // existed, and those must compare as "no keyed trees" rather than throw.
    treesByTabId: sortedEntries(s.treesByTabId ?? {}),
  });
}

/**
 * Does the live workspace already match some saved layout, whatever the user
 * last loaded?
 *
 * The dirty gate's original question was "has the workspace drifted from the
 * layout it came FROM", which answers yes for a workspace the user has since
 * saved under another name — offering to protect work that is already on disk.
 * This is the second question: is this exact arrangement stored ANYWHERE?
 *
 * Tab-scoped layouts are excluded. Their `tabs` array holds the one saved tab,
 * so a single-tab workspace could match one by coincidence — and "you have this
 * tab saved" is not "you have this workspace saved". Matching one would wave the
 * gate through on the strength of a layout that never claimed to describe the
 * whole workspace.
 */
export function matchesAnySavedWorkspace(
  current: LayoutShaped,
  savedLayouts: ReadonlyArray<LayoutShaped & { scope?: 'workspace' | 'tab' }>,
): boolean {
  const identity = layoutShapeIdentity(current);
  return savedLayouts.some(
    layout => layout.scope !== 'tab' && layoutShapeIdentity(layout) === identity,
  );
}
