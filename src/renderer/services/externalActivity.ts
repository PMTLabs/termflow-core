/**
 * Pure resolver for the `terminal:external-activity` event's target tab.
 *
 * The payload (api_server.rs `external_activity_payload`) carries up to four
 * ids, and only one of them is a TAB:
 *   `terminalId` / `processId`     — the backend PTY id (`pc-*` in-process).
 *   `tabId` / `rendererTerminalId` — the renderer LEAF (`tb-*` root, `tm-*` split).
 *   `owningTabId`                  — the tab. NEW in P0-A.
 *
 * `flagTabActivity` (tabsSlice.ts:133-141) resolves its argument against
 * `state.tabs`, which holds ONLY root tab ids — handing it a `tm-*` leaf is a
 * silent no-op, which is why every split pane's activity indicator was dropped.
 * Mirrors RunningActivityTracker.resolveTab (:267-271), the pattern that already
 * gets this right.
 */
import { findTabIdByTerminalId } from '../store/slices/paneTreeOps';
import type { PaneNode } from '../store/slices/panesSlice';

export interface ExternalActivityDetail {
  terminalId?: string;
  processId?: string;
  tabId?: string | null;
  rendererTerminalId?: string | null;
  owningTabId?: string | null;
}

export function resolveActivityTabId(
  detail: ExternalActivityDetail,
  treesByTabId: Record<string, PaneNode>,
  knownTabIds: Set<string>,
): string | null {
  // 1. The backend told us the owner outright. Trust it only if the tab is
  //    still open — a closed tab must not resurrect an indicator.
  if (detail.owningTabId && knownTabIds.has(detail.owningTabId)) {
    return detail.owningTabId;
  }

  // 2. Resolve a renderer leaf through the pane tree. `tabId` is a deprecated
  //    alias of the leaf, so it is a leaf candidate, NOT a tab candidate —
  //    except in the one case where it is genuinely a root tab id (below).
  for (const leaf of [detail.rendererTerminalId, detail.tabId]) {
    if (!leaf) continue;
    const owner = findTabIdByTerminalId(treesByTabId, leaf);
    if (owner && knownTabIds.has(owner)) return owner;
    if (knownTabIds.has(leaf)) return leaf;
  }

  // 3. Last resort: an event from a build that only sent the process id. This
  //    matches nothing on the in-process path (leaves are never `pc-*`), and is
  //    kept only for the sidecar path, where the map key IS the leaf.
  if (detail.terminalId) {
    const owner = findTabIdByTerminalId(treesByTabId, detail.terminalId);
    if (owner && knownTabIds.has(owner)) return owner;
  }

  return null;
}
