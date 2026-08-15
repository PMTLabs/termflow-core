/**
 * Keeps the BACKEND's `owning_tab_id` in step with the renderer pane tree.
 *
 * The backend records a terminal's owning tab once, at spawn. Moving a pane
 * changes its tab but NOT its identity — the leaf travels with the pane — so
 * nothing downstream notices and the stored owner keeps naming the tab the pane
 * left. That stale owner is echoed by `get_terminal_detail`/`get_my_terminal`,
 * and the MCP tool descriptions tell an agent to pass it straight back when it
 * creates a sibling pane, so the agent's next pane lands in the wrong tab
 * (external review 099, T2-F2). It is also emitted on
 * `terminal:external-activity`, lighting the wrong tab.
 *
 * WHY THIS HANGS OFF THE TREE, NOT OFF A LIFECYCLE HOOK
 * The obvious hook — `TerminalService.bindProcess` — is not enough: a moved pane
 * already has a mapping, so `TerminalPane` takes its reuse path and never binds
 * (TerminalPane.tsx:167-202). Rather than chase every dispatch site, this
 * derives the answer from `panes.treesByTabId` itself — the authority on
 * ownership — and pushes only what actually CHANGED. Every reparent path is then
 * covered by construction:
 *   - same-window drag        `movePaneToTab`      (PaneDragController.tsx)
 *   - cross-window drop       `insertPaneIntoTab`  (dnd/detach.ts)
 *   - detached window boot /
 *     whole-tab reattach      `addTabTree`         (dnd/detach.ts)
 *   - reload/restore reattach `setPaneTree` + `addTabTree`
 *                                                  (StateManager / TerminalContainer)
 *   - any future programmatic move, without a new call site.
 *
 * Reads its two collaborators off `window` (the bridge and the terminal service,
 * both installed by `index.tsx` at bootstrap) exactly as App.tsx does, so the
 * module adds no import edge into the store's graph and no import-order hazard.
 */
import type { PaneNode } from '../store/slices/panesSlice';

/** renderer leaf id (`tb-*` root, `tm-*` split) -> the tab that owns it. */
export type LeafOwners = Map<string, string>;

export interface OwnerChange {
  rendererTerminalId: string;
  owningTabId: string;
}

/** Flatten every tab's pane tree into leaf -> owning tab. */
export function collectLeafOwners(treesByTabId: Record<string, PaneNode>): LeafOwners {
  const owners: LeafOwners = new Map();
  const walk = (node: PaneNode | null | undefined, tabId: string): void => {
    if (!node) return;
    if (node.type === 'terminal' && node.terminalId) owners.set(node.terminalId, tabId);
    node.children?.forEach((child) => walk(child, tabId));
  };
  for (const tabId of Object.keys(treesByTabId)) walk(treesByTabId[tabId], tabId);
  return owners;
}

/**
 * The ownership updates this window owes the backend.
 *
 * Two kinds of leaf need one, and only these two:
 *
 *   (a) A leaf this window already tracked now sits under a different tab — a
 *       same-window move.
 *   (b) A leaf this window has never seen that ALREADY has a live process
 *       binding — it arrived from somewhere else (cross-window drop, detached
 *       window boot, reload reattach), so its backend owner names the tab it
 *       came from.
 *
 * The binding test is what separates (b) from a freshly split pane: a new pane's
 * leaf enters the tree BEFORE `TerminalPane` spawns its PTY, so it has no
 * binding and needs nothing — the spawn itself carries the right owner. Pushing
 * for it anyway would be a harmless no-op backend-side, but it would also mean
 * every startup fired one invoke per pane for nothing.
 */
export function diffOwnerChanges(
  previous: LeafOwners | null,
  next: LeafOwners,
  hasLiveProcess: (rendererTerminalId: string) => boolean,
): OwnerChange[] {
  const changes: OwnerChange[] = [];
  for (const [leaf, owningTabId] of next) {
    const before = previous?.get(leaf);
    if (before === owningTabId) continue;
    if (before !== undefined || hasLiveProcess(leaf)) {
      changes.push({ rendererTerminalId: leaf, owningTabId });
    }
  }
  return changes;
}

/** The slice of the store this needs — structural, so no import of the store. */
interface PaneOwnershipStore {
  getState: () => { panes: { treesByTabId: Record<string, PaneNode> } };
  subscribe: (listener: () => void) => () => void;
}

/**
 * Watch `panes.treesByTabId` and push every ownership change to the backend.
 * Returns the store's unsubscribe.
 *
 * Best-effort and fire-and-forget: a failed update costs the correct routing of
 * a later API/MCP call, never the move itself.
 */
export function attachPaneOwnershipSync(store: PaneOwnershipStore): () => void {
  // Trees are immutable per change (RTK/immer), so an identity check keeps every
  // unrelated dispatch — every keystroke-driven action — down to one comparison.
  let lastTrees: Record<string, PaneNode> | null = null;
  let lastOwners: LeafOwners | null = null;

  return store.subscribe(() => {
    const trees = store.getState().panes.treesByTabId;
    if (trees === lastTrees) return;
    lastTrees = trees;

    const next = collectLeafOwners(trees);
    const terminalService = (window as any).terminalService;
    const changes = diffOwnerChanges(lastOwners, next, (leaf) => !!terminalService?.getProcessId?.(leaf));
    lastOwners = next;

    for (const change of changes) {
      window.electronAPI?.setTerminalOwningTab?.(change.rendererTerminalId, change.owningTabId)
        ?.catch((e: unknown) => {
          console.warn(
            `Failed to re-parent terminal ${change.rendererTerminalId} to tab ${change.owningTabId}`,
            e,
          );
        });
    }
  });
}
