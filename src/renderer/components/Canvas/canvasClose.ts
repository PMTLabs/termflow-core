/**
 * What "close this node" means, kept out of the component because the answer is not obvious
 * and the two ways of getting it wrong are both silent.
 *
 * **A node is a PANE, and a tab's last pane is the TAB.** `closePane` on the root sets
 * `paneTree = null` (panesSlice), so routing a solo node down the pane path leaves a tab with
 * no terminal and no way back — a tab-shaped hole in the strip. The canvas is the one surface
 * where this is easy to hit, because it flattens every tab's panes into one field of nodes and
 * nothing on screen says which of them is its tab's only one.
 *
 * The count that decides it is PANES, not terminals. They differ for exactly one case and it
 * is a real one: a freshly split pane enters the tree before `TerminalPane` spawns its PTY, so
 * it has no `terminalId` yet and the canvas — which projects from `leaves()`, dropping
 * terminal-less leaves — does not draw a node for it. Counting terminals there would see 1,
 * call it a tab close, and take the spawning sibling down with it.
 */

/** Which of the app's two close flows a node's close belongs to. */
export type CanvasCloseKind = 'pane' | 'tab';

export interface CanvasCloseRequest {
  kind: CanvasCloseKind;
  /** The id this kind's event carries: `paneId` for a pane close, `tabId` for a tab close. */
  targetId: string;
  /** Whether to ask first. */
  confirm: boolean;
}

/**
 * `confirm` is per-TERMINAL liveness, which is the whole point of the request Tam made
 * ("always confirm unless there is no process on it").
 *
 * It deliberately does NOT read `node.isRunning`, and the reason changed with `plan/020` §2
 * without changing the conclusion. That field used to be projected from `tab.isRunning`, so on a
 * split tab it answered a question about the TAB while looking like an answer about the node;
 * it is now genuinely per-terminal, so that objection is gone. The remaining one is the real
 * one: `isRunning` means "producing output right now", and this asks "is there a process at
 * all" — a shell sitting at an idle prompt is not running and must still be confirmed.
 *
 * `isAlive` is the predicate `App.tsx` already trusts for exactly this
 * (`terminalService.getProcessIdForTerminal`, which `TerminalService` deletes on `pty:exit`),
 * so the canvas and the exit path cannot drift apart.
 */
export function decideCanvasClose(
  node: { terminalId: string; tabId: string; paneId: string },
  panesInTab: number,
  isAlive: (terminalId: string) => boolean,
): CanvasCloseRequest {
  const kind: CanvasCloseKind = panesInTab > 1 ? 'pane' : 'tab';
  return {
    kind,
    targetId: kind === 'pane' ? node.paneId : node.tabId,
    confirm: isAlive(node.terminalId),
  };
}

/**
 * The four events, as data.
 *
 * The canvas closes terminals by asking the surface that owns them, never by reaching into the
 * pane tree itself: `PaneManager` and `TabManager` stay mounted for every tab while the canvas
 * is up (`TerminalContainer` renders them all), and each already owns its confirm dialog, its
 * PTY teardown and its cwd-snapshot cleanup. A canvas-local close would be a fourth copy of
 * that, and the copy that forgets `clearCwdSnapshot` is the one you find months later.
 */
export const CLOSE_EVENTS = {
  pane: { confirm: 'ui:requestPaneClose', force: 'ui:forcePaneClose', idKey: 'paneId' },
  tab: { confirm: 'ui:requestTabClose', force: 'ui:forceTabClose', idKey: 'tabId' },
} as const;

/** The event a decision turns into. Split from `decideCanvasClose` so the mapping is testable
 *  without a DOM and without dispatching anything. */
export function closeEventFor(req: CanvasCloseRequest): { type: string; detail: Record<string, string> } {
  const e = CLOSE_EVENTS[req.kind];
  return {
    type: req.confirm ? e.confirm : e.force,
    detail: { [e.idKey]: req.targetId },
  };
}

/** A node's identity, as far as bulk-closing ended terminals needs it. */
export interface CanvasEndedNode {
  terminalId: string;
  tabId: string;
  paneId: string;
}

/**
 * What "close every ended terminal" resolves to — the toolbar's Close Ended button, Tam's ask
 * 2026-08-24.
 *
 * Grouped by TAB rather than decided node-by-node, and that grouping is what avoids the trap a
 * naive per-node loop would hit: two ended panes in the same multi-pane tab must not each read
 * the pane count from a snapshot taken before either closed, or the second one sees a count that
 * no longer matches reality and can route what is by then the tab's LAST pane down the pane-close
 * flow — exactly the "tab-shaped hole" this file's own header note warns `decideCanvasClose`
 * against. Deciding once per tab, from one consistent `panesInTab` snapshot, needs no such
 * staleness: a tab whose every pane has ended closes as ONE tab-close event; a tab with a live
 * sibling closes only the ended panes, and the live one — never a member of `endedNodes` — can
 * never be the one counted toward "every pane has ended".
 */
export function closeEndedRequests(
  endedNodes: readonly CanvasEndedNode[],
  panesInTab: (tabId: string) => number,
  isAlive: (terminalId: string) => boolean,
): CanvasCloseRequest[] {
  const byTab = new Map<string, CanvasEndedNode[]>();
  for (const node of endedNodes) {
    const list = byTab.get(node.tabId);
    if (list) list.push(node); else byTab.set(node.tabId, [node]);
  }

  const requests: CanvasCloseRequest[] = [];
  for (const [tabId, nodes] of byTab) {
    if (nodes.length >= panesInTab(tabId)) {
      requests.push({ kind: 'tab', targetId: tabId, confirm: nodes.some((n) => isAlive(n.terminalId)) });
    } else {
      for (const node of nodes) {
        requests.push({ kind: 'pane', targetId: node.paneId, confirm: isAlive(node.terminalId) });
      }
    }
  }
  return requests;
}
