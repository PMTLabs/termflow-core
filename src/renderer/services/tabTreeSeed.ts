import type { PaneNode } from '../store/slices/panesSlice';
import { getAllTerminalIds } from '../store/slices/paneTreeOps';
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
 * The tree to install for `tab`, or null to leave it alone.
 *
 * Rule 1 — **an existing key means initialised, even when it holds null.** `null` is an open
 * tab with no terminals; only a tab whose key was never written gets seeded. This is the
 * rule that keeps a re-homed tab empty instead of refilling it.
 *
 * Rule 2 — **never install a tree naming a terminal another tab already owns.** Rule 1 alone
 * relies on the null surviving, and it does not always: `tabPanes` is a window-global mirror
 * that is upsert-only and gets persisted, and a layout restored from it arrives with no key
 * at all. So the candidate tree is checked against what the other tabs hold, whether it came
 * from that stale mirror or was manufactured here.
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

  const homed = terminalsHomedElsewhere(trees, tab.id);
  if (getAllTerminalIds(candidate).some((id) => homed.has(id))) return null;

  return candidate;
}
