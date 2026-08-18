import { seedTreeFor, terminalsHomedElsewhere } from '../tabTreeSeed';
import { getAllTerminalIds } from '../../store/slices/paneTreeOps';
import type { PaneNode } from '../../store/slices/panesSlice';

const leaf = (paneId: string, terminalId: string): PaneNode => ({
  id: paneId, type: 'terminal', terminalId,
});

const TAB = { id: 'tb-b', title: 'PowerShell 7 4', shellType: 'powershell' };

describe('terminalsHomedElsewhere', () => {
  it('collects every leaf from the OTHER tabs', () => {
    const trees = {
      'tb-a': {
        id: 'pn-r', type: 'split' as const, direction: 'horizontal' as const, size: 50,
        children: [leaf('pn-1', 'tb-a'), leaf('pn-2', 'tm-right')],
      },
      'tb-b': leaf('pn-3', 'tb-b'),
    };
    expect([...terminalsHomedElsewhere(trees, 'tb-b')].sort()).toEqual(['tb-a', 'tm-right']);
  });

  // Excluding the tab itself is what lets a tab be re-seeded from its OWN stale mirror after
  // a reload. Include it and `seedTreeFor` would refuse every tab that already has a tree,
  // which is a refusal that looks like success until a tab comes up blank.
  it('excludes the tab being asked about', () => {
    expect(terminalsHomedElsewhere({ 'tb-b': leaf('pn-3', 'tb-b') }, 'tb-b').has('tb-b'))
      .toBe(false);
  });

  it('tolerates a null tree', () => {
    expect([...terminalsHomedElsewhere({ 'tb-a': null, 'tb-b': leaf('p', 'tb-b') }, 'tb-b')])
      .toEqual([]);
  });
});

describe('seedTreeFor', () => {
  it('manufactures a root leaf for a tab with no entry', () => {
    const seed = seedTreeFor(TAB, {}, {})!;
    expect(seed.type).toBe('terminal');
    expect(seed.terminalId).toBe('tb-b');
    expect(seed.name).toBe('PowerShell 7 4');
    expect(seed.shellType).toBe('powershell');
  });

  it('falls back to a plain name when the tab has no title', () => {
    expect(seedTreeFor({ id: 'tb-b' }, {}, {})!.name).toBe('Terminal');
  });

  it('prefers the window mirror over manufacturing', () => {
    const mirrored = leaf('pn-mirror', 'tm-mirror');
    expect(seedTreeFor(TAB, {}, { 'tb-b': mirrored })).toBe(mirrored);
  });

  // The two states a key can be in, and they must be treated the SAME: both mean initialised.
  it.each([
    ['a tree', leaf('pn-3', 'tb-b') as PaneNode | null],
    ['null — open and empty', null],
  ])('leaves a tab alone when its entry already holds %s', (_label, value) => {
    expect(seedTreeFor(TAB, { 'tb-b': value }, {})).toBeNull();
  });

  // The distinction the whole module turns on: absent is NOT the same as null.
  it('an absent entry and a null entry differ', () => {
    expect(seedTreeFor(TAB, {}, {})).not.toBeNull();
    expect(seedTreeFor(TAB, { 'tb-b': null }, {})).toBeNull();
  });

  // A mirror tree with SEVERAL panes, only one of which moved away. The offending leaf is
  // PRUNED and the rest of the tree installed — refusing the whole tree would orphan
  // `tm-stayed`, which had nothing to do with the problem and would then belong to no tab at
  // all. Every single-leaf case looks the same under either policy; this is the one that
  // separates them.
  it('prunes the moved leaf from a multi-pane mirror and keeps the rest', () => {
    const stale: PaneNode = {
      id: 'pn-stale', type: 'split', direction: 'horizontal', size: 50,
      children: [leaf('pn-s1', 'tm-moved'), leaf('pn-s2', 'tm-stayed')],
    };
    const seeded = seedTreeFor(TAB, { 'tb-a': leaf('pn-a', 'tm-moved') }, { 'tb-b': stale })!;
    expect(seeded).not.toBeNull();
    expect(getAllTerminalIds(seeded)).toEqual(['tm-stayed']);

    // ...and it is left completely alone when neither leaf is spoken for, so the pruning is
    // about ownership rather than about the tree having more than one pane.
    expect(seedTreeFor(TAB, { 'tb-a': leaf('pn-a', 'tm-other') }, { 'tb-b': stale })).toBe(stale);
  });

  /**
   * The repair for state that is ALREADY on disk.
   *
   * A session that hit the resurrection bug saved a tree naming one terminal twice, and
   * `saveAppState` persists the window mirror verbatim — so it comes back on the next launch
   * with no key, where the "already initialised" rule has nothing to say about it. One PTY
   * cannot be two panes, so the second copy is dropped and the tab comes up correct.
   */
  it('repairs a saved tree that names the same terminal twice', () => {
    const corrupt: PaneNode = {
      id: 'pn-root', type: 'split', direction: 'horizontal', size: 50,
      children: [
        leaf('pn-1', 'tb-b'),
        { id: 'pn-inner', type: 'split', direction: 'vertical', size: 50,
          children: [leaf('pn-2', 'tm-dupe'), leaf('pn-3', 'tm-dupe')] },
      ],
    };
    const seeded = seedTreeFor(TAB, {}, { 'tb-b': corrupt })!;
    expect(getAllTerminalIds(seeded)).toEqual(['tb-b', 'tm-dupe']);
  });

  it('keeps the FIRST copy, so the same saved state always restores the same way', () => {
    const corrupt: PaneNode = {
      id: 'pn-root', type: 'split', direction: 'horizontal', size: 50,
      children: [leaf('pn-keep', 'tm-dupe'), leaf('pn-drop', 'tm-dupe')],
    };
    const seeded = seedTreeFor(TAB, {}, { 'tb-b': corrupt })!;
    expect(seeded.type).toBe('terminal');
    expect(seeded.id).toBe('pn-keep');
  });

  it('refuses a mirror tree whose leaves live in another tab now', () => {
    const trees = { 'tb-a': leaf('pn-moved', 'tm-moved') };
    expect(seedTreeFor(TAB, trees, { 'tb-b': leaf('pn-stale', 'tm-moved') })).toBeNull();
    // A mirror naming only terminals nobody else owns is still fine.
    expect(seedTreeFor(TAB, trees, { 'tb-b': leaf('pn-ok', 'tm-fresh') })).not.toBeNull();
  });
});
