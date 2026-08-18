/**
 * Pure resolver for the `terminal:external-activity` event's target tab.
 *
 * The payload (api_server.rs `external_activity_payload`) carries up to four
 * ids, and only one of them is a TAB:
 *   `terminalId` / `processId`     — the backend PTY id (`pc-*` in-process).
 *   `tabId` / `rendererTerminalId` — the renderer LEAF. Two id FORMS, naming who
 *                                    minted the leaf and NOT the pane's shape:
 *                                    `tb-*` for a renderer-created tab root
 *                                    (leaf == owner), `tm-*` for split panes AND
 *                                    for every API-created terminal, including a
 *                                    solo root. Shape comes from the pane tree.
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
  treesByTabId: Record<string, PaneNode | null>,
  knownTabIds: Set<string>,
): string | null {
  // 1. The PANE TREE IS AUTHORITATIVE. Resolve the renderer leaf through it
  //    first: it is this window's live record of which tab holds which pane,
  //    whereas the emitted owner is a backend copy written at spawn that a pane
  //    move can invalidate (review 099 T2-F2 — `setTerminalOwningTab` repairs
  //    it, but an event already in flight can still carry the old value, and a
  //    build/instance without the repair carries it always). Whenever the tree
  //    has an answer it wins, so a moved pane lights the tab it is IN.
  //    `tabId` is a deprecated alias of the leaf, so it is a leaf candidate, NOT
  //    a tab candidate — except in the one case where it is genuinely a root tab
  //    id (the second half of the loop body).
  for (const leaf of [detail.rendererTerminalId, detail.tabId]) {
    if (!leaf) continue;
    const owner = findTabIdByTerminalId(treesByTabId, leaf);
    if (owner && knownTabIds.has(owner)) return owner;
    if (knownTabIds.has(leaf)) return leaf;
  }

  // 2. The backend's owner, now a HINT rather than the first answer: used only
  //    where the tree has none. That is a real case, not a formality — an
  //    API-created pane's first write can beat the renderer's own insertion into
  //    the tree, and the sidecar/headless paths never enter it at all. Still
  //    gated on the tab being open, so a closed tab cannot resurrect an
  //    indicator.
  if (detail.owningTabId && knownTabIds.has(detail.owningTabId)) {
    return detail.owningTabId;
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
