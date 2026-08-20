import { planSeeds, pruneDuplicateLeaves, terminalsHomedElsewhere } from '../tabTreeSeed';
import { getAllTerminalIds } from '../../store/slices/paneTreeOps';
import type { PaneNode } from '../../store/slices/panesSlice';

const leaf = (paneId: string, terminalId: string): PaneNode => ({
  id: paneId, type: 'terminal', terminalId,
});

const split = (paneId: string, ...children: PaneNode[]): PaneNode => ({
  id: paneId, type: 'split', direction: 'horizontal', size: 50, children,
});

const TAB = { id: 'tb-b', title: 'PowerShell 7 4', shellType: 'powershell' };

/** The single-tab answer, which is what most of these cases are about. */
const seedOne = (
  tab: { id: string; title?: string; shellType?: string },
  trees: Record<string, PaneNode | null>,
  tabPanes: Record<string, PaneNode | null | undefined>,
) => planSeeds([tab], trees, tabPanes);

describe('terminalsHomedElsewhere', () => {
  it('collects every leaf from the OTHER tabs', () => {
    const trees = {
      'tb-a': split('pn-r', leaf('pn-1', 'tb-a'), leaf('pn-2', 'tm-right')),
      'tb-b': leaf('pn-3', 'tb-b'),
    };
    expect([...terminalsHomedElsewhere(trees, 'tb-b')].sort()).toEqual(['tb-a', 'tm-right']);
  });

  it('excludes the tab being asked about', () => {
    expect(terminalsHomedElsewhere({ 'tb-b': leaf('pn-3', 'tb-b') }, 'tb-b').has('tb-b'))
      .toBe(false);
  });

  it('tolerates a null tree', () => {
    expect([...terminalsHomedElsewhere({ 'tb-a': null, 'tb-b': leaf('p', 'tb-b') }, 'tb-b')])
      .toEqual([]);
  });
});

describe('pruneDuplicateLeaves', () => {
  it('reports what it dropped, so the caller can say so out loud', () => {
    const tree = split('pn-root', leaf('pn-keep', 'tm-dupe'), leaf('pn-drop', 'tm-dupe'));
    const { tree: out, dropped } = pruneDuplicateLeaves(tree, new Set());
    expect(dropped).toEqual([{ paneId: 'pn-drop', terminalId: 'tm-dupe' }]);
    expect(getAllTerminalIds(out)).toEqual(['tm-dupe']);
  });

  it('reports nothing when there was nothing wrong', () => {
    const tree = split('pn-root', leaf('pn-1', 'tm-a'), leaf('pn-2', 'tm-b'));
    expect(pruneDuplicateLeaves(tree, new Set()).dropped).toEqual([]);
  });
});

describe('planSeeds — one tab', () => {
  // AMENDED by design 014. This previously asserted `terminalId === 'tb-b'`,
  // the pre-014 rule that a tab's root pane carries the tab's own id. That
  // equality is what made a field labelled "Terminal ID" show a `tb-` value and
  // left an agent in a two-pane tab unable to say which terminal it meant.
  // Ownership is now carried explicitly by `seededForTabId` instead of implied by
  // the id.
  it('manufactures a root leaf with a fresh tm- id, owned by the tab', () => {
    const [plan] = seedOne(TAB, {}, {});
    expect(plan.tabId).toBe('tb-b');
    expect(plan.tree!.type).toBe('terminal');
    expect(plan.tree!.terminalId).toMatch(/^tm-/);
    expect(plan.tree!.terminalId).not.toBe('tb-b');
    expect(plan.tree!.seededForTabId).toBe('tb-b');
    expect(plan.tree!.name).toBe('PowerShell 7 4');
    expect(plan.tree!.shellType).toBe('powershell');
  });

  it('gives two tabs two different root leaves', () => {
    const a = seedOne({ id: 'tb-a' }, {}, {})[0].tree!.terminalId;
    const b = seedOne({ id: 'tb-b' }, {}, {})[0].tree!.terminalId;
    expect(a).not.toBe(b);
  });

  it('leaves sessionKey unset — only the migration sets it', () => {
    expect(seedOne(TAB, {}, {})[0].tree!.sessionKey).toBeUndefined();
  });

  it('falls back to a plain name when the tab has no title', () => {
    expect(seedOne({ id: 'tb-b' }, {}, {})[0].tree!.name).toBe('Terminal');
  });

  it('prefers the window mirror over manufacturing', () => {
    const mirrored = leaf('pn-mirror', 'tm-mirror');
    expect(seedOne(TAB, {}, { 'tb-b': mirrored })[0].tree).toBe(mirrored);
  });

  // The two states a key can be in, and they must be treated the SAME: both mean initialised.
  it.each([
    ['a tree', leaf('pn-3', 'tb-b') as PaneNode | null],
    ['null — open and empty', null],
  ])('leaves a tab alone when its entry already holds %s', (_label, value) => {
    expect(seedOne(TAB, { 'tb-b': value }, {})).toEqual([]);
  });

  // The distinction the whole module turns on: absent is NOT the same as null.
  it('an absent entry and a null entry differ', () => {
    expect(seedOne(TAB, {}, {})).toHaveLength(1);
    expect(seedOne(TAB, { 'tb-b': null }, {})).toEqual([]);
  });

  /**
   * A mirror that says "this tab is open and empty" is an ANSWER, not a gap.
   *
   * `saveState` persists the window mirror rather than `treesByTabId`, and the mirror
   * carries the null faithfully. Reading it as "nothing stored" and manufacturing a root
   * leaf is how an emptied tab came back full on the next launch. The plan still has to be
   * EMITTED — with a null tree — because writing nothing leaves the key absent, and absent
   * is the state the seed net fills in on the very next render.
   */
  it('installs the KEY for a mirror that is explicitly empty, and no terminal', () => {
    expect(seedOne(TAB, {}, { 'tb-b': null })).toEqual([{ tabId: 'tb-b', tree: null }]);
  });

  it('prunes the moved leaf from a multi-pane mirror and keeps the rest', () => {
    const stale = split('pn-stale', leaf('pn-s1', 'tm-moved'), leaf('pn-s2', 'tm-stayed'));
    const [plan] = seedOne(TAB, { 'tb-a': leaf('pn-a', 'tm-moved') }, { 'tb-b': stale });
    expect(getAllTerminalIds(plan.tree)).toEqual(['tm-stayed']);

    // ...and it is left completely alone when neither leaf is spoken for, so the pruning is
    // about ownership rather than about the tree having more than one pane.
    expect(seedOne(TAB, { 'tb-a': leaf('pn-a', 'tm-other') }, { 'tb-b': stale })[0].tree)
      .toBe(stale);
  });

  it('repairs a saved tree that names the same terminal twice', () => {
    const corrupt = split(
      'pn-root',
      leaf('pn-1', 'tb-b'),
      { id: 'pn-inner', type: 'split', direction: 'vertical', size: 50,
        children: [leaf('pn-2', 'tm-dupe'), leaf('pn-3', 'tm-dupe')] },
    );
    expect(getAllTerminalIds(seedOne(TAB, {}, { 'tb-b': corrupt })[0].tree))
      .toEqual(['tb-b', 'tm-dupe']);
  });

  // A tab whose every leaf is spoken for is EMPTY, and it has to say so. Returning no plan
  // would leave the key absent, and the next render would manufacture a fresh terminal —
  // the resurrection this module exists to stop, one render later.
  it('emits an empty tab rather than nothing when every leaf is taken', () => {
    const trees = { 'tb-a': leaf('pn-moved', 'tm-moved') };
    expect(seedOne(TAB, trees, { 'tb-b': leaf('pn-stale', 'tm-moved') }))
      .toEqual([{ tabId: 'tb-b', tree: null }]);
    // A mirror naming only terminals nobody else owns is still installed as-is.
    expect(seedOne(TAB, trees, { 'tb-b': leaf('pn-ok', 'tm-fresh') })[0].tree).not.toBeNull();
  });
});

/**
 * The batch is where the repair actually has to work.
 *
 * Seeding used to be decided per tab against the `treesByTabId` snapshot the effect closed
 * over, and dispatching does not update that snapshot mid-loop. On a restore where two tabs
 * both name terminal `T` — which is precisely the shape the resurrection bug saves to disk —
 * each tab was checked against `{}` and BOTH installed `T`. The next render saw two keys and
 * skipped them both, so the duplicate became permanent. The repair existed and could not fire
 * on the one input it was written for.
 */
describe('planSeeds — the whole batch at once', () => {
  const A = { id: 'tb-a' };
  const B = { id: 'tb-b' };

  it('gives a terminal claimed by two restored tabs to exactly one of them', () => {
    const plans = planSeeds([A, B], {}, {
      'tb-a': leaf('pn-a', 'tm-shared'),
      'tb-b': leaf('pn-b', 'tm-shared'),
    });
    const homes = plans.flatMap((p) => getAllTerminalIds(p.tree).map(() => p.tabId));
    expect(homes).toEqual(['tb-a']);
    // Both tabs are still initialised — the loser is EMPTY, not absent, or the next render
    // manufactures it a terminal and we are back where we started.
    expect(plans.map((p) => p.tabId).sort()).toEqual(['tb-a', 'tb-b']);
    expect(plans.find((p) => p.tabId === 'tb-b')!.tree).toBeNull();
  });

  /**
   * WHICH tab keeps it is not a coin flip.
   *
   * A tab's root pane carries the tab's own id as its terminal id, so `tb-a` inside tab
   * `tb-a` is the original and `tb-a` inside tab `tb-b` is the copy the bug made. Ordering
   * the natural owner first is what makes the same corrupt save heal the same way on every
   * machine — under plain first-wins the answer changed with whatever order `tabs` happened
   * to be in.
   */
  it.each([
    ['owner last', [B, A]],
    ['owner first', [A, B]],
  ])('gives it to the tab named after it, whatever the tab order (%s)', (_label, tabs) => {
    const plans = planSeeds(tabs, {}, {
      'tb-a': leaf('pn-a', 'tb-a'),
      'tb-b': leaf('pn-b', 'tb-a'),
    });
    const winner = plans.find((p) => getAllTerminalIds(p.tree).includes('tb-a'));
    expect(winner!.tabId).toBe('tb-a');
    expect(plans.find((p) => p.tabId === 'tb-b')!.tree).toBeNull();
  });

  /**
   * The SAME determinism, for post-014 trees.
   *
   * The test above feeds legacy-shaped mirrors whose leaves are `tb-` ids, so it
   * exercises the id-equality fallback. Once roots carry a `tm-` leaf that
   * equality never holds, and without an explicit owner this repair silently
   * degrades to `tabs` order — the coin flip the whole function exists to remove.
   * A regression here is invisible: the repair still runs and still produces a
   * plan, just a different one depending on tab order.
   */
  it.each([
    ['owner last', ['tb-b', 'tb-a']],
    ['owner first', ['tb-a', 'tb-b']],
  ])('honours an explicit seededForTabId whatever the tab order (%s)', (_label, order) => {
    const tabs = order.map((id) => ({ id }));
    const plans = planSeeds(tabs as any, {}, {
      'tb-a': { id: 'pn-a', type: 'terminal', terminalId: 'tm-shared01', seededForTabId: 'tb-a' },
      'tb-b': { id: 'pn-b', type: 'terminal', terminalId: 'tm-shared01' },
    } as any);
    const winner = plans.find((p) => getAllTerminalIds(p.tree).includes('tm-shared01'));
    expect(winner!.tabId).toBe('tb-a');
    expect(plans.find((p) => p.tabId === 'tb-b')!.tree).toBeNull();
  });

  it('says out loud which pane it dropped', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      planSeeds([A, B], {}, {
        'tb-a': leaf('pn-a', 'tb-a'),
        'tb-b': leaf('pn-orphan', 'tb-a'),
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0] as [string];
      expect(message).toContain('pn-orphan');
      expect(message).toContain('tb-b');
    } finally {
      warn.mockRestore();
    }
  });

  it('lets an ALREADY INSTALLED tree beat any candidate', () => {
    const plans = planSeeds([B], { 'tb-a': leaf('pn-a', 'tm-shared') }, {
      'tb-b': leaf('pn-b', 'tm-shared'),
    });
    expect(plans).toEqual([{ tabId: 'tb-b', tree: null }]);
  });

  it('leaves unrelated tabs completely alone', () => {
    const plans = planSeeds([A, B], {}, {
      'tb-a': leaf('pn-a', 'tm-one'),
      'tb-b': leaf('pn-b', 'tm-two'),
    });
    expect(plans.map((p) => getAllTerminalIds(p.tree))).toEqual(
      expect.arrayContaining([['tm-one'], ['tm-two']]),
    );
  });

  it('returns nothing at all when every tab is already initialised', () => {
    expect(planSeeds([A, B], { 'tb-a': leaf('p', 'tb-a'), 'tb-b': null }, {})).toEqual([]);
  });
});

/**
 * Rule 3 on a COLD restore — the path it exists for, and the one it was not running on.
 *
 * `taken` and `seededElsewhere` are both "what the other tabs already hold", and both must
 * grow as the batch installs trees. Only `taken` did. Seeding `seededElsewhere` from `trees`
 * alone is enough for a warm call (some tabs already initialised) and does nothing at all on
 * a restore, where `trees` is `{}`: the set started empty and, with nothing adding to it,
 * stayed empty for every tab in the batch. Rule 3's post-014 signal was therefore inert
 * exactly when the legacy `taken.has(tab.id)` signal is also dead — no leaf carries a tab's
 * id after design 014 — so an emptied tab was protected by nothing.
 *
 * Found by agy in review 170 (finding 3).
 */
describe('planSeeds Rule 3 sees tabs seeded earlier in the SAME batch', () => {
  // Tab B was emptied by dragging its terminal into tab A. The proof is the pane in A that
  // still names B as the tab it was born for.
  const paneFromB: PaneNode = {
    id: 'pn-moved', type: 'terminal', terminalId: 'tm-moved001', seededForTabId: 'tb-b',
  };
  const tabA = { id: 'tb-a', title: 'A', shellType: 'powershell' };
  const tabB = { id: 'tb-b', title: 'B', shellType: 'powershell' };

  it('does not manufacture a shell for a tab emptied into another tab in the same batch', () => {
    // COLD restore: nothing installed yet, so `trees` is empty — the whole point.
    const plans = planSeeds([tabA, tabB], {}, { 'tb-a': paneFromB, 'tb-b': undefined });
    const forB = plans.find((p) => p.tabId === 'tb-b');
    expect(forB).toBeDefined();
    expect(forB!.tree).toBeNull();
  });

  it('still installs the tab that actually holds the pane', () => {
    const plans = planSeeds([tabA, tabB], {}, { 'tb-a': paneFromB, 'tb-b': undefined });
    const forA = plans.find((p) => p.tabId === 'tb-a');
    expect(getAllTerminalIds(forA!.tree)).toEqual(['tm-moved001']);
  });

  // Order must not decide it. `ordered` puts natural owners first, so B can be visited
  // before A — the accumulation has to be what protects B, not luck in the sort.
  it('holds whichever order the tabs arrive in', () => {
    const plans = planSeeds([tabB, tabA], {}, { 'tb-a': paneFromB, 'tb-b': undefined });
    expect(plans.find((p) => p.tabId === 'tb-b')!.tree).toBeNull();
  });

  // The warm path must keep working: a tab already in `trees` is the case the original
  // seeding covered, and it is still the first thing checked.
  it('still honours a pane seeded elsewhere that was already installed', () => {
    const plans = planSeeds([tabB], { 'tb-a': paneFromB }, { 'tb-b': undefined });
    expect(plans.find((p) => p.tabId === 'tb-b')!.tree).toBeNull();
  });

  // ...and a genuinely NEW tab must still get its shell. A guard that suppressed every
  // manufacture would pass all four tests above and break the app.
  it('still manufactures for a tab nothing has ever named', () => {
    const fresh = { id: 'tb-new', title: 'New', shellType: 'powershell' };
    const plans = planSeeds([tabA, fresh], {}, { 'tb-a': paneFromB, 'tb-new': undefined });
    const forNew = plans.find((p) => p.tabId === 'tb-new')!;
    expect(forNew.tree).not.toBeNull();
    expect(forNew.tree!.terminalId).toMatch(/^tm-/);
  });
});
