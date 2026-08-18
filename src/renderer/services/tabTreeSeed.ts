import type { PaneNode } from '../store/slices/panesSlice';
import { getAllTerminalIds, removeLeaf } from '../store/slices/paneTreeOps';
import { generateId } from '../utils/id';

/**
 * Whether a tab needs a pane tree manufactured for it, and what that tree should be.
 *
 * `TerminalContainer` runs this on every render for every tab, so it is the safety net that
 * gives an API- or restore-created tab a tree when nothing else dispatched one. It is also
 * the place a terminal can be brought back from the dead, which is what this module exists
 * to stop:
 *
 * Dragging a group's LAST terminal into another group (canvas re-homing, design 010 §6.3)
 * empties the source tab. The tab stays open — the design calls that "already a legal
 * state" and the canvas keeps its frame as a drop target. The seed net then saw a tab with
 * no tree, could not tell "emptied" from "never initialised", and seeded it a fresh root
 * leaf carrying the tab's own id — which is precisely the id the re-homed root pane kept.
 * The terminal was then a member of two tabs at once. Nothing failed: the sidebar listed it
 * twice, and Arrange placed the node in whichever group came last, leaving the other
 * group's frame shrink-wrapped across the whole workspace to reach it.
 *
 * Two independent rules, because they cover different routes to the same state:
 */
export interface SeedTab {
  id: string;
  title?: string;
  shellType?: string;
}

/** Every terminal already living in a tab OTHER than `tabId`. */
export function terminalsHomedElsewhere(
  trees: Record<string, PaneNode | null>,
  tabId: string,
): Set<string> {
  const out = new Set<string>();
  for (const [id, tree] of Object.entries(trees)) {
    if (id === tabId) continue;
    for (const terminalId of getAllTerminalIds(tree)) out.add(terminalId);
  }
  return out;
}

/**
 * Drop every leaf whose terminal is already spoken for — by another tab (`taken`) or by an
 * earlier leaf of this same tree. Returns null if nothing survives.
 *
 * A tree naming one terminal twice is malformed however it got that way: one PTY cannot be
 * two panes, and rendering it as two mounts the same terminal in two places. Installing such
 * a tree is never right, so this repairs the candidate rather than trusting or rejecting it
 * wholesale — rejecting would orphan the leaves that were fine, which for a restored tree
 * means losing a terminal that had nothing to do with the problem.
 *
 * This matters most for state that is ALREADY on disk. `saveAppState` persists the
 * window-global mirror verbatim, so a session that hit the resurrection bug has the duplicate
 * saved in localStorage and restores it on the next launch — where the entry arrives with no
 * key and Rule 1 has nothing to say about it.
 *
 * The FIRST occurrence wins, and the walk is depth-first left-to-right, so the repair is
 * deterministic: the same saved state always restores the same way.
 */
export function pruneDuplicateLeaves(tree: PaneNode, taken: Set<string>): PaneNode | null {
  const seen = new Set(taken);
  const offenders: string[] = [];
  const walk = (n: PaneNode): void => {
    if (n.type === 'terminal') {
      if (!n.terminalId) return;
      if (seen.has(n.terminalId)) offenders.push(n.id);
      else seen.add(n.terminalId);
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  walk(tree);

  let out: PaneNode | null = tree;
  for (const paneId of offenders) {
    if (!out) break;
    out = removeLeaf(out, paneId).tree;
  }
  return out;
}

/**
 * The tree to install for `tab`, or null to leave it alone.
 *
 * Rule 1 — **an existing key means initialised, even when it holds null.** `null` is an open
 * tab with no terminals; only a tab whose key was never written gets seeded. This is the
 * rule that keeps a re-homed tab empty instead of refilling it.
 *
 * Rule 2 — **never install a leaf naming a terminal another tab already owns.** Rule 1 alone
 * relies on the null surviving, and it does not always: `tabPanes` is a window-global mirror
 * that is upsert-only and gets persisted, and a layout restored from it arrives with no key
 * at all. So the candidate is pruned against what the other tabs hold — and against itself,
 * which is what repairs a duplicate already saved to disk by a session that hit the bug.
 */
export function seedTreeFor(
  tab: SeedTab,
  trees: Record<string, PaneNode | null>,
  tabPanes: Record<string, PaneNode | null | undefined>,
): PaneNode | null {
  if (tab.id in trees) return null;

  const candidate: PaneNode = tabPanes[tab.id] ?? {
    id: generateId('pn'),
    type: 'terminal' as const,
    terminalId: tab.id,
    name: tab.title || 'Terminal',
    shellType: tab.shellType,
  };

  return pruneDuplicateLeaves(candidate, terminalsHomedElsewhere(trees, tab.id));
}
