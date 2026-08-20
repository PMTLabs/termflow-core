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

/**
 * A tree to install, and the tab to install it under.
 *
 * `tree: null` is an instruction, not a no-op: it writes the KEY holding null, which is how
 * a restored tab that is open and empty stays empty. Returning nothing for that case would
 * leave the key absent, and absent is the one state the seed net fills in.
 */
export interface SeedPlan {
  tabId: string;
  tree: PaneNode | null;
}

/** A leaf the repair dropped, so the caller can say so out loud. */
export interface DroppedLeaf {
  paneId: string;
  terminalId: string;
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
 * earlier leaf of this same tree. Returns the repaired tree (null if nothing survives) and
 * the leaves it dropped.
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
 * **It reports what it dropped, and the caller logs it.** This is a data migration wearing a
 * validator's clothes: it deletes a pane the user never asked to lose. A silent drop is
 * indistinguishable from the crash-on-restore it replaced, so `planSeeds` warns per leaf.
 * Within one tree the FIRST occurrence wins and the walk is depth-first left-to-right; which
 * TAB wins is decided by `planSeeds`, not here.
 */
export function pruneDuplicateLeaves(
  tree: PaneNode,
  taken: Set<string>,
): { tree: PaneNode | null; dropped: DroppedLeaf[] } {
  const seen = new Set(taken);
  const dropped: DroppedLeaf[] = [];
  const walk = (n: PaneNode): void => {
    if (n.type === 'terminal') {
      if (!n.terminalId) return;
      if (seen.has(n.terminalId)) dropped.push({ paneId: n.id, terminalId: n.terminalId });
      else seen.add(n.terminalId);
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  walk(tree);

  let out: PaneNode | null = tree;
  for (const { paneId } of dropped) {
    if (!out) break;
    out = removeLeaf(out, paneId).tree;
  }
  return { tree: out, dropped };
}

/**
 * The tree this tab would like to install, before any ownership check.
 *
 * **A mirrored `null` is an answer, not a gap.** `saveState` persists the window mirror
 * rather than `treesByTabId`, and the mirror faithfully carries the null of a tab someone
 * emptied. Reading that null as "nothing stored" and manufacturing a root leaf is how an
 * emptied tab came back full on the next launch — the restore-time twin of the bug this
 * module exists for. Only `undefined` means nothing was stored.
 */
function candidateFor(
  tab: SeedTab,
  tabPanes: Record<string, PaneNode | null | undefined>,
): PaneNode | null {
  const mirrored = tabPanes[tab.id];
  if (mirrored !== undefined) return mirrored;
  return {
    id: generateId('pn'),
    type: 'terminal' as const,
    // A fresh `tm-` leaf, NOT `tab.id` (design 014 §A1). Before 014 a tab's root
    // pane carried the tab's own id, which is why a field labelled "Terminal ID"
    // displayed a `tb-` and an agent in a two-pane tab could not say which
    // terminal it meant. `seededForTabId` below carries the ownership that equality
    // used to imply.
    terminalId: generateId('tm'),
    seededForTabId: tab.id,
    name: tab.title || 'Terminal',
    shellType: tab.shellType,
  };
}

/**
 * A tab that is claiming a terminal named after ITSELF is that terminal's natural owner.
 *
 * The root pane of a tab carries the tab's own id as its terminal id, so `tb-a` in tab `tb-a`
 * is the original and `tb-a` in tab `tb-b` is the copy the resurrection bug made. Ordering
 * the natural owner first is what makes the repair canonical instead of a coin-flip on
 * whichever tab `tabs` happened to list first — the same corrupt save now heals the same way
 * on every machine.
 */
function claimsItsOwnId(tab: SeedTab, tabPanes: Record<string, PaneNode | null | undefined>): boolean {
  const candidate = candidateFor(tab, tabPanes);
  // Post-014: ownership is recorded explicitly, because a root leaf no longer
  // carries its tab's id. Checked FIRST so a migrated tree is judged by the fact
  // rather than by the equality it no longer satisfies.
  if (declaresOwner(candidate, tab.id)) return true;
  // Pre-014 trees restored from disk: the root leaf IS the tab id. Keeping this
  // fallback is what stops the repair regressing to `tabs` order for anyone
  // upgrading with existing saved state.
  return getAllTerminalIds(candidate).includes(tab.id);
}

/** Does any pane in `node` declare `tabId` as the tab it was seeded for? */
function declaresOwner(node: PaneNode | null, tabId: string): boolean {
  if (!node) return false;
  if (node.seededForTabId === tabId) return true;
  return (node.children ?? []).some((child) => declaresOwner(child, tabId));
}

/** Collect every `seededForTabId` recorded anywhere in `node` into `out`. */
function collectSeededFor(node: PaneNode | null, out: Set<string>): void {
  if (!node) return;
  if (node.seededForTabId) out.add(node.seededForTabId);
  (node.children ?? []).forEach((child) => collectSeededFor(child, out));
}

/**
 * Every tree to install for `tabs`, decided over the WHOLE set at once.
 *
 * **The batch is the point.** Seeding used to be a per-tab decision taken against the
 * `treesByTabId` snapshot the effect closed over, and dispatching does not update that
 * snapshot mid-loop. So on a restore where two tabs both name terminal `T` — which is
 * precisely the shape the resurrection bug saves to disk — tab A was checked against `{}`,
 * tab B was checked against `{}` as well, and BOTH installed `T`. The very next render saw
 * two keys, Rule 1 returned null for each, and the duplicate was permanent. The repair
 * existed and could not fire on the one input it was written for.
 *
 * So ownership is accumulated here, across the batch, before anything is installed.
 */
export function planSeeds(
  tabs: SeedTab[],
  trees: Record<string, PaneNode | null>,
  tabPanes: Record<string, PaneNode | null | undefined>,
): SeedPlan[] {
  // Rule 1 — an existing key means initialised, even when it holds null. `null` is an open
  // tab with no terminals; only a tab whose key was never written gets seeded. This is the
  // rule that keeps a re-homed tab empty instead of refilling it.
  const pending = tabs.filter((tab) => !(tab.id in trees));
  if (!pending.length) return [];

  // Already installed beats any candidate. A pending tab never has a key, so scanning every
  // tree here is the same set `terminalsHomedElsewhere` would return for each of them.
  const taken = new Set<string>();
  for (const tree of Object.values(trees)) {
    for (const terminalId of getAllTerminalIds(tree)) taken.add(terminalId);
  }

  // Tabs some OTHER tab's pane was seeded for. A pending tab has no key, so any
  // match here can only be a pane that moved away — which proves the tab was
  // initialised once and then emptied, not that it is new.
  const seededElsewhere = new Set<string>();
  for (const tree of Object.values(trees)) collectSeededFor(tree, seededElsewhere);

  // Natural owners first; `sort` is stable, so everything else keeps `tabs` order.
  const ordered = [...pending].sort(
    (a, b) => Number(claimsItsOwnId(b, tabPanes)) - Number(claimsItsOwnId(a, tabPanes)),
  );

  // Rule 2 — never install a leaf naming a terminal another tab already owns. Rule 1 alone
  // relies on the null surviving, and it does not always: `tabPanes` is a window-global
  // mirror that is upsert-only and gets persisted, and a layout restored from it arrives
  // with no key at all. So each candidate is pruned against what the other tabs hold —
  // including the ones claimed earlier in THIS batch — and against itself.
  const out: SeedPlan[] = [];
  for (const tab of ordered) {
    // Rule 3 — never MANUFACTURE a terminal for a tab that was emptied.
    //
    // Before design 014 this was enforced by accident: the manufactured leaf was
    // `tab.id`, which is the very id the departing terminal carried, so Rule 2
    // pruned it. Once a root leaf is a fresh `tm-` there is no collision left to
    // catch it, and an emptied tab would silently come back holding a brand-new
    // shell — the resurrection bug again, by a different route.
    //
    // Two signals, one per era, because restored state can be either shape:
    //   - `taken.has(tab.id)`  — legacy: the tab's own id is still a live leaf
    //                            somewhere, so it moved away.
    //   - `seededElsewhere`    — post-014: a pane elsewhere names this tab as the
    //                            one it was seeded for.
    // Only applies to the manufacture branch; a stored mirror is an answer and is
    // handled by Rule 2 below.
    if (tabPanes[tab.id] === undefined && (taken.has(tab.id) || seededElsewhere.has(tab.id))) {
      out.push({ tabId: tab.id, tree: null });
      continue;
    }

    const candidate = candidateFor(tab, tabPanes);
    // Stored as explicitly empty. Install the key so Rule 1 protects it from here on.
    if (candidate === null) {
      out.push({ tabId: tab.id, tree: null });
      continue;
    }

    const { tree, dropped } = pruneDuplicateLeaves(candidate, taken);
    for (const leaf of dropped) {
      console.warn(
        `tabTreeSeed: dropped pane ${leaf.paneId} from tab ${tab.id} — terminal ` +
        `${leaf.terminalId} is already owned by another pane. Restored state named it twice.`,
      );
    }
    // Everything it named was already spoken for. The tab is open and empty, and saying so
    // explicitly is what stops the next render manufacturing a fresh terminal for it.
    for (const terminalId of getAllTerminalIds(tree)) taken.add(terminalId);
    out.push({ tabId: tab.id, tree });
  }
  return out;
}
