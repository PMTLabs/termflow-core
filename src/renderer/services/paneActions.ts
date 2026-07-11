import { store } from '../store';
import { addTab } from '../store/slices/tabsSlice';
import { splitPaneWithTab } from '../store/slices/panesSlice';
import { findLeaf, firstLeafId } from '../store/slices/paneTreeOps';
import { generateId } from '../utils/id';
import { terminalService } from './TerminalService';

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
 *  stacks the new pane below, 'vertical' places it to the right. Backlog 004: the
 *  new pane inherits the SOURCE pane's live CWD (falls back to the app default if
 *  it can't be read). */
export async function splitPaneById(paneId: string, direction: 'horizontal' | 'vertical'): Promise<void> {
  const state = store.getState();
  const shellType = state.settings.defaultProfile || 'default';

  let cwd: string | undefined;
  try {
    const tree = state.panes.paneTree;
    const node = tree ? findLeaf(tree, paneId) : null;
    const srcTerminalId = node?.terminalId;
    const processId = srcTerminalId ? terminalService.getProcessId(srcTerminalId) : undefined;
    if (processId) {
      cwd = (await window.electronAPI.getTerminalCwd?.(processId)) ?? undefined;
    }
  } catch (err) {
    console.warn('paneActions: could not read source pane cwd; using default', err);
  }

  store.dispatch(splitPaneWithTab({ paneId, direction, shellType, cwd }));
}

/** Resolve the best pane to split for a given tab: its focused pane if that pane
 *  lives in the tab, otherwise the tab's first leaf. Used by the tab menu, which
 *  isn't bound to one specific pane. Returns null if the tab has no panes. */
export function splitTabPane(tabId: string, direction: 'horizontal' | 'vertical'): void {
  const panes = store.getState().panes;
  const tree = panes.treesByTabId[tabId];
  if (!tree) return;
  const focused = panes.activePaneId && findLeaf(tree, panes.activePaneId)
    ? panes.activePaneId
    : firstLeafId(tree);
  if (focused) void splitPaneById(focused, direction);
}
