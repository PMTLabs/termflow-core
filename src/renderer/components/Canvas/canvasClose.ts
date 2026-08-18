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
 * It deliberately does NOT read `node.isRunning`. That field is projected from `tab.isRunning`
 * — `buildModel` says so in as many words — so every node in a tab carries the same value, and
 * on a split tab it answers a question about the tab while looking like an answer about the
 * node. `isAlive` is the predicate `App.tsx` already trusts for exactly this
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
