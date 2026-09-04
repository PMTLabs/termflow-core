import { PaneNode } from './panesSlice';
import { generateId } from '../../utils/id';

/** Edge zones for an insert (center is handled separately via swapLeaves). */
export type EdgeZone = 'left' | 'right' | 'top' | 'bottom';

/**
 * Every `PaneNode` field that describes the TERMINAL a pane holds, as opposed to the
 * pane's position in the tree (`id`, `type`, `direction`, `size`, `children`).
 *
 * **One list, because this defect class has now appeared four times.** Whenever a
 * terminal is re-homed onto a different node — split, swap, cross-window drag, detach
 * — every field here has to travel with it, and each site that hand-listed the fields
 * dropped a different subset:
 *
 * | site | dropped |
 * |---|---|
 * | `splitPaneWithTab` | `seededForTabId`, `sessionKey`, `shellType` |
 * | `swapLeaves` | `seededForTabId`, `sessionKey`, `notifyMuted` |
 * | cross-window drag / detach | `seededForTabId`, `sessionKey`, `notifyMuted` |
 *
 * Each loss is silent and each is durable: `sessionKey` orphans a migrated pane's
 * armed pty-host session, `seededForTabId` destroys the only record that a tab owns
 * its terminals (design 014 removed the id equality that used to imply it), and
 * `notifyMuted` un-mutes a pane the user muted.
 *
 * `paneTreeOps.test.ts` derives this list from `PaneNode`'s own declaration, so adding
 * a seventh per-terminal field without adding it here fails the suite.
 */
export const TERMINAL_BOUND_FIELDS = [
  'terminalId',
  'name',
  // Travels with `name` or it is worse than useless: a split copies the name across but would
  // leave the flag behind, silently demoting a name the USER typed to a default — and
  // `terminalLabelSync` would then let the tab title override it.
  'nameIsCustom',
  'shellType',
  'notifyMuted',
  'sessionKey',
  'seededForTabId',
] as const;

/** The terminal-bound half of a pane node — everything that must follow the terminal. */
export type TerminalIdentity = Pick<PaneNode, (typeof TERMINAL_BOUND_FIELDS)[number]>;

/** Lift the terminal-bound fields off a node. Absent fields stay absent. */
export function terminalIdentityOf(node: PaneNode): TerminalIdentity {
  const out: TerminalIdentity = {};
  for (const key of TERMINAL_BOUND_FIELDS) {
    if (node[key] !== undefined) Object.assign(out, { [key]: node[key] });
  }
  return out;
}

/**
 * Write `identity` onto `node`, mutating it, and CLEAR any terminal-bound field the
 * identity does not carry.
 *
 * The clear is the point: a swap that only assigns present fields leaves the target's
 * own `sessionKey`/`notifyMuted` in place, so the incoming terminal silently inherits
 * the outgoing one's state. That is finding 2 of review 170.
 */
export function assignTerminalIdentity(node: PaneNode, identity: TerminalIdentity): void {
  for (const key of TERMINAL_BOUND_FIELDS) {
    if (identity[key] === undefined) delete node[key];
    else Object.assign(node, { [key]: identity[key] });
  }
}

const clone = (n: PaneNode): PaneNode => JSON.parse(JSON.stringify(n));

export function findLeaf(tree: PaneNode | null, paneId: string): PaneNode | null {
  if (!tree) return null;
  if (tree.id === paneId) return tree;
  if (tree.type === 'split' && tree.children) {
    for (const c of tree.children) {
      const found = findLeaf(c, paneId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The renderer terminal id (leaf, always `tm-*`) that a tab's OWN root pane
 * carries, for a solo (unsplit) tab whose tree is a single terminal node.
 *
 * Review 109 H3: this is NEVER `tab.id`. It once was for a renderer-created tab,
 * which is exactly the equality design 014 removed — every root leaf is minted.
 * Callers that need "the terminal this tab is currently showing" (process
 * lookup for Copy Tab Info / rename) must resolve through this rather than
 * assuming `tab.id` is a live leaf. Returns `null` for a split tree (no single
 * root pane) or a missing tree.
 *
 * NOTE: callers that need "the terminal(s) this tab owns" should prefer
 * `tabLeafIds` — falling back to `tab.id` merely because this returned `null`
 * is what re-review 111 finding 3 flagged: for a SPLIT API-created tab `tab.id`
 * is not a terminal at all, so the process lookup silently misses.
 */
export function soloRootLeafId(tree: PaneNode | null): string | null {
  if (!tree) return null;
  if (tree.type === 'terminal') return tree.terminalId ?? null;
  return null;
}

/**
 * Every renderer terminal id a tab owns, for tab-level lookups (Copy Tab Info,
 * rename).
 *
 * Re-review 111 finding 3: `tab.id` is only coincidentally a terminal id — true
 * for a renderer-created tab, false for an API-created one whose root leaf is a
 * backend-minted `tm-*`. So `tab.id` is used ONLY when the tab has no tree at
 * all (nothing better exists). Whenever a tree exists it is authoritative, even
 * if it is a split with several leaves, and even if it yields no terminal at all.
 */
export function tabLeafIds(tree: PaneNode | null, tabId: string): string[] {
  if (!tree) return [tabId];
  return getAllTerminalIds(tree);
}

/** Id of the first terminal leaf in the tree (depth-first), or null. */
export function firstLeafId(tree: PaneNode | null): string | null {
  if (!tree) return null;
  if (tree.type === 'terminal') return tree.id;
  if (tree.children) {
    for (const c of tree.children) {
      const id = firstLeafId(c);
      if (id) return id;
    }
  }
  return null;
}

/**
 * Remove a leaf by id, collapsing a 2-child split into its remaining sibling.
 * Returns a fresh tree (input is not mutated) and the removed node (deep-cloned).
 */
export function removeLeaf(
  tree: PaneNode | null,
  paneId: string,
): { tree: PaneNode | null; removed: PaneNode | null } {
  if (!tree) return { tree: null, removed: null };
  if (tree.id === paneId) return { tree: null, removed: clone(tree) };

  const root: PaneNode = clone(tree);
  let removed: PaneNode | null = null;

  const walk = (node: PaneNode, parent: PaneNode | null): boolean => {
    if (node.type === 'split' && node.children) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.id === paneId) {
          removed = clone(child);
          node.children.splice(i, 1);
          // Collapse the split into its remaining sibling.
          if (node.children.length === 1) {
            const remaining = node.children[0];
            if (parent && parent.children) {
              parent.children[parent.children.indexOf(node)] = remaining;
            } else {
              collapsedRoot = remaining; // node was the root
            }
          }
          return true;
        }
        if (walk(child, node)) return true;
      }
    }
    return false;
  };

  let collapsedRoot: PaneNode | null = null;
  walk(root, null);
  return { tree: collapsedRoot ?? root, removed };
}

const dirFor = (zone: EdgeZone): 'horizontal' | 'vertical' =>
  zone === 'left' || zone === 'right' ? 'vertical' : 'horizontal';

/**
 * Insert `node` adjacent to the target leaf according to `zone`, by converting
 * the target leaf into a split. Returns a fresh tree (input is not mutated).
 */
export function insertByZone(
  tree: PaneNode,
  targetPaneId: string,
  node: PaneNode,
  zone: EdgeZone,
): PaneNode {
  const root = clone(tree);
  const newNode = clone(node);

  const makeSplit = (target: PaneNode): PaneNode => {
    const targetCopy: PaneNode = { ...target };
    const children =
      zone === 'left' || zone === 'top' ? [newNode, targetCopy] : [targetCopy, newNode];
    return { id: generateId('pn'), type: 'split', direction: dirFor(zone), size: 50, children };
  };

  if (root.id === targetPaneId) {
    return makeSplit(root);
  }

  const replace = (n: PaneNode): boolean => {
    if (n.type === 'split' && n.children) {
      for (let i = 0; i < n.children.length; i++) {
        if (n.children[i].id === targetPaneId) {
          n.children[i] = makeSplit(n.children[i]);
          return true;
        }
        if (replace(n.children[i])) return true;
      }
    }
    return false;
  };

  replace(root);
  return root;
}

/** Swap the terminal payload of two leaves (center-zone drop). Returns a fresh tree. */
export function swapLeaves(tree: PaneNode, aId: string, bId: string): PaneNode {
  const root = clone(tree);
  const a = findLeaf(root, aId);
  const b = findLeaf(root, bId);
  if (a && b) {
    // The WHOLE terminal-bound set, not the three fields this used to name. Swapping a
    // subset left `sessionKey`/`seededForTabId`/`notifyMuted` on the node the terminal
    // just LEFT, so each terminal inherited the other's — a migrated pane's armed host
    // session was orphaned and a muted pane silently swapped its mute with its sibling.
    const aIdentity = terminalIdentityOf(a);
    assignTerminalIdentity(a, terminalIdentityOf(b));
    assignTerminalIdentity(b, aIdentity);
  }
  return root;
}

/**
 * Reverse lookup: return the id of the tab whose pane tree contains a terminal
 * leaf with the given terminalId, or null if no tab owns it. Used to attribute an
 * external (MCP/API) interaction to a tab when the backend event omits the tabId.
 */
/**
 * The pty-host session key recorded on the pane holding `terminalId`, if any.
 *
 * `undefined` means "the host knows this session by the leaf itself", which is
 * true for every pane created on this build. A value is present only on a pane
 * MIGRATED from a pre-014 build, where the leaf became a fresh `tm-` but the
 * host still knows the session by the old `tb-` id — the pty-host protocol has
 * no rename verb, so moving that key would orphan an armed session
 * (design 014 §A2).
 */
export function findSessionKeyByTerminalId(
  treesByTabId: Record<string, PaneNode | null>,
  terminalId: string,
): string | undefined {
  const search = (node: PaneNode | null): string | undefined => {
    if (!node) return undefined;
    if (node.type === 'terminal' && node.terminalId === terminalId) return node.sessionKey;
    for (const c of node.children ?? []) {
      const found = search(c);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const tree of Object.values(treesByTabId)) {
    const found = search(tree);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function findTabIdByTerminalId(
  treesByTabId: Record<string, PaneNode | null>,
  terminalId: string,
): string | null {
  const contains = (node: PaneNode | null): boolean => {
    if (!node) return false;
    if (node.type === 'terminal' && node.terminalId === terminalId) return true;
    if (node.type === 'split' && node.children) {
      for (const c of node.children) {
        if (contains(c)) return true;
      }
    }
    return false;
  };
  for (const tabId of Object.keys(treesByTabId)) {
    if (contains(treesByTabId[tabId])) return tabId;
  }
  return null;
}

/**
 * Whether the terminal leaf with `terminalId` is muted for notifications
 * (its own pane-level mute, independent of any tab-level mute). Walks all tabs'
 * trees for the leaf carrying that terminalId and returns its `notifyMuted`
 * flag. Used by RunningActivityTracker to suppress a single muted pane's
 * notifications while its unmuted siblings still ring. False if the terminal is
 * not found (fail-open: never silently drop a real notification).
 */
export function isTerminalMuted(
  treesByTabId: Record<string, PaneNode | null>,
  terminalId: string,
): boolean {
  const find = (node: PaneNode | null): PaneNode | null => {
    if (!node) return null;
    if (node.type === 'terminal' && node.terminalId === terminalId) return node;
    if (node.type === 'split' && node.children) {
      for (const c of node.children) {
        const found = find(c);
        if (found) return found;
      }
    }
    return null;
  };
  for (const tabId of Object.keys(treesByTabId)) {
    const leaf = find(treesByTabId[tabId]);
    if (leaf) return !!leaf.notifyMuted;
  }
  return false;
}

/**
 * The pane id a tab currently has focused: its remembered active pane if that
 * pane still exists in the tree, else the tree's first terminal leaf. Mirrors
 * the same fallback rule panesSlice's setActiveTabId uses when restoring focus
 * on tab switch, exposed here so other features (e.g. dynamic tab titles) can
 * ask "which pane is this tab's selected one" without duplicating the rule.
 */
export function getSelectedPaneId(
  treesByTabId: Record<string, PaneNode | null>,
  activePaneByTabId: Record<string, string>,
  tabId: string,
): string | null {
  const tree = treesByTabId[tabId] ?? null;
  const remembered = activePaneByTabId[tabId];
  if (remembered && findLeaf(tree, remembered)) return remembered;
  return firstLeafId(tree);
}

/**
 * Collect every terminalId in a pane tree (depth-first order). Used to enumerate
 * all terminals a tab owns — e.g. to resolve their foreground processes before
 * a close confirm. Returns [] for a null tree or terminal-less nodes.
 */
export function getAllTerminalIds(node: PaneNode | null): string[] {
  if (!node) return [];
  if (node.type === 'terminal') return node.terminalId ? [node.terminalId] : [];
  if (node.children) return node.children.flatMap((c) => getAllTerminalIds(c));
  return [];
}

/**
 * Collect every terminal-leaf pane id in a tree, depth-first (left-to-right,
 * top-to-bottom) — i.e. the tab's visual pane order. Used by the pane
 * focus-cycle shortcuts (Alt+]/Alt+[) to compute "next"/"previous".
 */
export function getAllLeafIds(node: PaneNode | null): string[] {
  if (!node) return [];
  if (node.type === 'terminal') return [node.id];
  if (node.children) return node.children.flatMap((c) => getAllLeafIds(c));
  return [];
}

/**
 * Resolve the tab that should be treated as fully exited when a single pane's
 * process exits, or null if the exit shouldn't affect the tab yet. A tab only
 * counts as exited once EVERY terminal in its tree has no live process — a
 * lone sibling exiting (root pane or not) leaves a multi-pane tab running.
 *
 * `exitedTerminalId` may be a never-split tab's root terminal (its id equals
 * the tab id, and treesByTabId has no entry for it — resolved via `tabIds`)
 * or a split-pane terminal nested in a tree (resolved via findTabIdByTerminalId).
 */
export function resolveExitedTabId(
  treesByTabId: Record<string, PaneNode | null>,
  tabIds: string[],
  exitedTerminalId: string,
  isTerminalAlive: (terminalId: string) => boolean,
): string | null {
  const tabId = tabIds.includes(exitedTerminalId)
    ? exitedTerminalId
    : findTabIdByTerminalId(treesByTabId, exitedTerminalId);
  if (!tabId) return null;

  const tree = treesByTabId[tabId] ?? null;
  const stillRunning = getAllTerminalIds(tree).some(isTerminalAlive);
  return stillRunning ? null : tabId;
}

/**
 * Does this tab have no panes left?
 *
 * `treesByTabId` holds three states — key absent (never initialised), null (open and empty),
 * or a tree — and this collapses the first two, which is what a caller deciding "should the
 * tab close now?" wants.
 *
 * Shared because the two callers that ask it — the cross-window detach and the tab-strip drag
 * — held the same expression written out separately, testing `=== undefined` back when an
 * emptied tab was expressed by DELETING its key. When that changed to null, both had to move
 * together or the tab would silently stop closing. One rule, one place, one test.
 *
 * Canvas re-homing deliberately does NOT ask: design 010 §6.3 keeps an emptied group's frame
 * on the canvas as a drop target, so its tab stays open and empty.
 */
export function tabHasNoPanes(
  treesByTabId: Record<string, PaneNode | null>,
  tabId: string,
): boolean {
  return treesByTabId[tabId] == null;
}
