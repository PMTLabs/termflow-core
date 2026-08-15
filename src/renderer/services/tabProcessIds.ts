import { PaneNode } from '../store/slices/panesSlice';
import { tabLeafIds } from '../store/slices/paneTreeOps';
import { terminalService } from './TerminalService';

/**
 * Backend process ids for every LIVE terminal leaf a tab owns.
 *
 * Re-review 111 finding 3: `tab.id` is a terminal id only for a
 * renderer-created tab. An API-created tab's root leaf is a backend-minted
 * `tm-*`, and once such a tab is split it owns several leaves — so resolving
 * "the tab's process" through `tab.id` silently produced nothing. Leaves are
 * taken from the tree (`tabLeafIds`), which falls back to `tab.id` only when
 * the tab has no tree at all.
 */
export function resolveTabProcessIds(tree: PaneNode | null, tabId: string): string[] {
  return tabLeafIds(tree, tabId)
    .map((terminalId) => terminalService.getProcessIdForTerminal(terminalId))
    .filter((pid): pid is string => !!pid);
}

/**
 * Push a tab title down to the backend name of EVERY live leaf process of that
 * tab. A tab title is tab-level, so a split tab renames all of its panes.
 * A single failing pane is logged and does not stop the rest.
 */
export async function renameTabProcesses(
  tree: PaneNode | null,
  tabId: string,
  title: string,
): Promise<string[]> {
  const processIds = resolveTabProcessIds(tree, tabId);
  for (const processId of processIds) {
    try {
      await window.electronAPI.updateTerminalName(processId, title);
    } catch (error) {
      console.error('Failed to update terminal name:', error);
    }
  }
  return processIds;
}
