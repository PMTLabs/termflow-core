import { PaneNode } from './panesSlice';
import { generateId } from '../../utils/id';

/** Edge zones for an insert (center is handled separately via swapLeaves). */
export type EdgeZone = 'left' | 'right' | 'top' | 'bottom';

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
    const tmp = { terminalId: a.terminalId, name: a.name, shellType: a.shellType };
    a.terminalId = b.terminalId;
    a.name = b.name;
    a.shellType = b.shellType;
    b.terminalId = tmp.terminalId;
    b.name = tmp.name;
    b.shellType = tmp.shellType;
  }
  return root;
}

/**
 * Reverse lookup: return the id of the tab whose pane tree contains a terminal
 * leaf with the given terminalId, or null if no tab owns it. Used to attribute an
 * external (MCP/API) interaction to a tab when the backend event omits the tabId.
 */
export function findTabIdByTerminalId(
  treesByTabId: Record<string, PaneNode>,
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
 * The pane id a tab currently has focused: its remembered active pane if that
 * pane still exists in the tree, else the tree's first terminal leaf. Mirrors
 * the same fallback rule panesSlice's setActiveTabId uses when restoring focus
 * on tab switch, exposed here so other features (e.g. dynamic tab titles) can
 * ask "which pane is this tab's selected one" without duplicating the rule.
 */
export function getSelectedPaneId(
  treesByTabId: Record<string, PaneNode>,
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
  treesByTabId: Record<string, PaneNode>,
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
