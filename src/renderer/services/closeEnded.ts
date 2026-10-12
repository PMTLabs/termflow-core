import { store, RootState } from '../store';
import { terminalService } from './TerminalService';
import { getAllLeafIds, getPaneLeaves } from '../store/slices/paneTreeOps';
import { closeEndedRequests, closeEventFor } from '../components/Canvas/canvasClose';
import type { CanvasEndedNode } from '../components/Canvas/canvasClose';

/**
 * Collect all leaf terminal nodes across all tabs whose shell session has ended.
 * Matches the same criteria as Canvas Mode's Close Ended button (`sessionExit[terminalId]`).
 */
export function collectEndedNodes(state: RootState): CanvasEndedNode[] {
  const tabs = state.tabs.tabs;
  const trees = state.panes.treesByTabId;
  const sessionExit = state.sessionExit.byTerminalId;
  const ended: CanvasEndedNode[] = [];

  for (const tab of tabs) {
    const tree = trees[tab.id];
    if (!tree) continue;
    const leaves = getPaneLeaves(tree);
    for (const leaf of leaves) {
      if (leaf.terminalId && sessionExit[leaf.terminalId]) {
        ended.push({
          terminalId: leaf.terminalId,
          tabId: tab.id,
          paneId: leaf.id,
        });
      }
    }
  }
  return ended;
}

/**
 * Close every terminal whose session has already ended across the workspace.
 * Resolves through `closeEndedRequests` so multi-pane tabs whose every pane has ended
 * close as a single tab close, while split tabs with live siblings close only the ended panes.
 * Same function as the "Close Ended" button in Canvas Mode.
 */
export function closeAllEndedTerminals(): void {
  const state = store.getState();
  const ended = collectEndedNodes(state);
  if (ended.length === 0) return;

  const trees = state.panes.treesByTabId;
  const panesInTab = (tabId: string) => getAllLeafIds(trees[tabId] ?? null).length;
  const isTerminalAlive = (terminalId: string): boolean =>
    !!terminalService.getProcessIdForTerminal(terminalId);

  const requests = closeEndedRequests(ended, panesInTab, isTerminalAlive);
  for (const req of requests) {
    const { type, detail } = closeEventFor(req);
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
