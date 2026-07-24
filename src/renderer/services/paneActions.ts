import { store } from '../store';
import { addTab } from '../store/slices/tabsSlice';
import { splitPaneWithTab } from '../store/slices/panesSlice';
import { findLeaf, firstLeafId } from '../store/slices/paneTreeOps';
import { generateId } from '../utils/id';
import { terminalService } from './TerminalService';
import { getCwdSnapshot } from './cwdSnapshot';

/**
 * Shared "new tab / new window / split pane" actions used by the tab, pane and
 * terminal context menus (and the tab-strip + button). Centralised here so all
 * entry points behave identically instead of each re-implementing the logic.
 */

/** Make a tab title unique against the currently open tabs (e.g. "PowerShell 7 1"). */
function uniqueTabTitle(baseName: string): string {
  const existing = store.getState().tabs.tabs.map(t => t.title);
  let name = baseName;
  let counter = 1;
  while (existing.includes(name)) {
    name = `${baseName} ${counter}`;
    counter++;
  }
  return name;
}

/** Open a new tab using the user's default shell profile (falls back to the first).
 *  When `afterTabId` is given, the new tab is inserted immediately after that tab
 *  (its right neighbour); otherwise it is appended to the end. */
export function openNewTabWithDefaultProfile(afterTabId?: string): void {
  const { shellProfiles, defaultProfile } = store.getState().settings;
  if (!shellProfiles || shellProfiles.length === 0) {
    console.warn('paneActions: shell profiles not loaded yet');
    return;
  }
  const profile = shellProfiles.find(p => p.id === defaultProfile) || shellProfiles[0];
  store.dispatch(addTab({
    id: generateId('tb'),
    title: uniqueTabTitle(profile.name),
    shellType: profile.id,
    icon: '🖥️',
    insertAfterId: afterTabId,
  }));
}

/** Open a brand-new, empty app window (boots a single default-profile tab). */
export async function openNewWindow(): Promise<void> {
  try {
    await window.electronAPI?.createNewWindow?.();
  } catch (err) {
    console.error('paneActions: failed to open new window', err);
  }
}

/** Split a specific pane. Direction matches the pane split buttons: 'horizontal'
 *  stacks panes top/bottom, 'vertical' places them side-by-side. `position` says
 *  which side of the original the NEW pane lands on ('before' = top/left,
 *  'after' = bottom/right, the default). Backlog 004: the new pane inherits the
 *  SOURCE pane's live CWD (falls back to the app default if it can't be read). */
export async function splitPaneById(
  paneId: string,
  direction: 'horizontal' | 'vertical',
  position: 'before' | 'after' = 'after',
): Promise<void> {
  const state = store.getState();
  const shellType = state.settings.defaultProfile || 'default';

  let cwd: string | undefined;
  try {
    // Spec 045 §3.6: search every tab's tree, not just `panes.paneTree` — that
    // mirrors the ACTIVE tab only, so a split requested from a BACKGROUND tab's
    // header found no source pane and silently inherited no cwd.
    const node = findLeafInAnyTree(state.panes, paneId);
    const srcTerminalId = node?.terminalId;
    const processId = srcTerminalId ? terminalService.getProcessId(srcTerminalId) : undefined;
    if (processId) {
      try {
        cwd = (await window.electronAPI.getTerminalCwd?.(processId)) ?? undefined;
      } catch (e) {
        // A REJECTED live query (IPC down, process gone, timeout) must still fall
        // through to the snapshot below — sharing one try/catch meant a throw
        // jumped past the fallback and the pane spawned at C:\Windows anyway.
        console.warn('paneActions: live getTerminalCwd failed; falling back to snapshot', e);
      }
    }
    // Fallback (spec 045 §3.3): after a reload / PTY-host hot-swap reattach the
    // backend's live cwd map is empty until the shell renders its next prompt
    // (OSC 9;9), and on Windows the process-scan fallback can't read a cwd — so
    // the live query yields nothing and the new pane would spawn at the app's
    // launch dir (C:\Windows). The renderer's persisted snapshot (seeded on
    // restore) still holds the last-known folder, so inherit that instead.
    if (!cwd && srcTerminalId) cwd = getCwdSnapshot(srcTerminalId);
  } catch (err) {
    console.warn('paneActions: could not read source pane cwd; using default', err);
  }

  store.dispatch(splitPaneWithTab({ paneId, direction, position, shellType, cwd }));
}

/** Find a leaf by id in any tab's tree (falling back to the active mirror).
 *  Spec 045 §3.6 — the tab context menu can target a background tab. */
function findLeafInAnyTree(panes: { treesByTabId: Record<string, any>; paneTree: any }, paneId: string): any {
  for (const tree of Object.values(panes.treesByTabId || {})) {
    const found = tree ? findLeaf(tree, paneId) : null;
    if (found) return found;
  }
  return panes.paneTree ? findLeaf(panes.paneTree, paneId) : null;
}

/** Resolve the best pane to split for a given tab: its focused pane if that pane
 *  lives in the tab, otherwise the tab's first leaf. Used by the tab menu, which
 *  isn't bound to one specific pane. No-op if the tab has no panes.
 *
 *  `activePaneId` is global, so for a BACKGROUND tab it never matches this tab's
 *  tree and we fall back to its first leaf — deliberate, and the documented
 *  answer to spec 045 §6's open item.
 *
 *  `position` mirrors splitPaneById's (spec 045 §3.2) so the tab-header menu
 *  offers the same four directional actions as the pane-header menu. */
export function splitTabPane(
  tabId: string,
  direction: 'horizontal' | 'vertical',
  position: 'before' | 'after' = 'after',
): void {
  const panes = store.getState().panes;
  const tree = panes.treesByTabId[tabId];
  if (!tree) return;
  const focused = panes.activePaneId && findLeaf(tree, panes.activePaneId)
    ? panes.activePaneId
    : firstLeafId(tree);
  if (focused) void splitPaneById(focused, direction, position);
}
