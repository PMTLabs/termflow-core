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

/**
 * renderer leaf id -> the tab that owns it.
 *
 * The leaf id has two FORMS, naming who minted it and NOT the pane's shape:
 * `tb-*` for a renderer-created tab root, `tm-*` for split panes AND for every
 * API-created terminal, including a solo root. Root/solo/split comes only from
 * the pane tree; ownership comes only from this map, never from the prefix — a
 * leaf keeps its id when moved into another tab, which is what this module
 * detects.
 */
export type LeafOwners = Map<string, string>;

export interface OwnerChange {
  rendererTerminalId: string;
  owningTabId: string;
}

/** Flatten every tab's pane tree into leaf -> owning tab. */
export function collectLeafOwners(treesByTabId: Record<string, PaneNode | null>): LeafOwners {
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
  getState: () => { panes: { treesByTabId: Record<string, PaneNode | null> } };
  subscribe: (listener: () => void) => () => void;
}

/**
 * The store `attachPaneOwnershipSync` was given, so `reassertOwnerAfterSpawn`
 * can read the tree without taking an import edge into the store graph — the
 * same constraint the module header states. Null until bootstrap has run, which
 * makes the re-assert a safe no-op for anything created before then.
 */
let ownershipStore: PaneOwnershipStore | null = null;

/**
 * Push a leaf's CURRENT owner once its PTY is actually registered.
 *
 * Closes the window external review 101 F2 describes. The subscription above
 * fires on the tree change, but the backend can only retarget a terminal it has
 * already registered, and `spawn_terminal` registers LAST — so a pane dragged
 * between tabs while its own spawn is still in flight gets an update that hits
 * nothing. `set_terminal_owning_tab` treats an unmatched leaf as a successful
 * no-op (it must: the renderer fires off its own tree lifecycle, and a pane's
 * PTY may legitimately not exist), and the subscription has already advanced
 * `lastOwners`, so no later tree change re-sends it. The move is then lost for
 * the rest of the session: the pane sits visibly in the new tab while
 * `get_terminal_detail` keeps naming the old one.
 *
 * Called at the one moment that race resolves — the create has returned, so the
 * terminal IS registered. Sends nothing in the common case, where the owner the
 * spawn carried is still the owner the tree holds.
 */
export function reassertOwnerAfterSpawn(
  rendererTerminalId: string,
  ownerSentAtSpawn: string | undefined,
): void {
  if (!ownershipStore) return;
  const current = collectLeafOwners(ownershipStore.getState().panes.treesByTabId).get(
    rendererTerminalId,
  );
  // No entry means the pane left this window (or the tree has not been committed
  // yet); either way this window has no correction to offer.
  if (!current || current === ownerSentAtSpawn) return;
  window.electronAPI?.setTerminalOwningTab?.(rendererTerminalId, current)?.catch((e: unknown) => {
    console.warn(
      `Failed to re-assert owner ${current} for terminal ${rendererTerminalId} after spawn`,
      e,
    );
  });
}

/**
 * Watch `panes.treesByTabId` and push every ownership change to the backend.
 * Returns the store's unsubscribe.
 *
 * Best-effort and fire-and-forget: a failed update costs the correct routing of
 * a later API/MCP call, never the move itself.
 */
export function attachPaneOwnershipSync(store: PaneOwnershipStore): () => void {
  ownershipStore = store;
  // Trees are immutable per change (RTK/immer), so an identity check keeps every
  // unrelated dispatch — every keystroke-driven action — down to one comparison.
  let lastTrees: Record<string, PaneNode | null> | null = null;
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
