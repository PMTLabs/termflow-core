import { collectLeafOwners, diffOwnerChanges } from '../paneOwnership';
import type { PaneNode } from '../../store/slices/panesSlice';

const leaf = (id: string, terminalId: string): PaneNode => ({ id, type: 'terminal', terminalId });

const split = (id: string, children: PaneNode[]): PaneNode => ({
  id,
  type: 'split',
  direction: 'vertical',
  children,
});

const bound = (...ids: string[]) => (id: string) => ids.includes(id);
const noneBound = () => false;

describe('collectLeafOwners', () => {
  it('maps every leaf in every tab, however deeply nested', () => {
    const owners = collectLeafOwners({
      'tb-a': split('pn-1', [leaf('pn-2', 'tb-a'), split('pn-3', [leaf('pn-4', 'tm-x'), leaf('pn-5', 'tm-y')])]),
      'tb-b': leaf('pn-6', 'tb-b'),
    });
    expect(Object.fromEntries(owners)).toEqual({
      'tb-a': 'tb-a',
      'tm-x': 'tb-a',
      'tm-y': 'tb-a',
      'tb-b': 'tb-b',
    });
  });

  it('ignores split containers, which own no terminal', () => {
    expect(collectLeafOwners({ 'tb-a': split('pn-1', [leaf('pn-2', 'tb-a')]) }).has('pn-1')).toBe(false);
  });
});

describe('diffOwnerChanges', () => {
  // The bug this whole change exists for: a pane dragged from tab A to tab B.
  it('reports a leaf that changed tab', () => {
    const before = collectLeafOwners({ 'tb-a': split('pn-1', [leaf('pn-2', 'tb-a'), leaf('pn-3', 'tm-x')]) });
    const after = collectLeafOwners({
      'tb-a': leaf('pn-2', 'tb-a'),
      'tb-b': split('pn-4', [leaf('pn-5', 'tb-b'), leaf('pn-3', 'tm-x')]),
    });
    expect(diffOwnerChanges(before, after, noneBound)).toEqual([
      { rendererTerminalId: 'tm-x', owningTabId: 'tb-b' },
    ]);
  });

  it('says nothing when a tree changes shape without changing ownership', () => {
    const before = collectLeafOwners({ 'tb-a': split('pn-1', [leaf('pn-2', 'tb-a'), leaf('pn-3', 'tm-x')]) });
    // Same two leaves, swapped positions and resized — no reparent.
    const after = collectLeafOwners({ 'tb-a': split('pn-9', [leaf('pn-3', 'tm-x'), leaf('pn-2', 'tb-a')]) });
    expect(diffOwnerChanges(before, after, bound('tm-x', 'tb-a'))).toEqual([]);
  });

  // A pane dropped in from ANOTHER WINDOW is brand new to this tree, but its
  // backend owner is the tab it came from. `attachExistingTerminal` has already
  // bound it here, which is what distinguishes it from a fresh split.
  it('reports a newly seen leaf that already has a live process', () => {
    const after = collectLeafOwners({ 'tb-b': split('pn-1', [leaf('pn-2', 'tb-b'), leaf('pn-3', 'tm-fromA')]) });
    expect(diffOwnerChanges(collectLeafOwners({}), after, bound('tm-fromA'))).toEqual([
      { rendererTerminalId: 'tm-fromA', owningTabId: 'tb-b' },
    ]);
  });

  it('stays silent for a freshly split pane whose PTY has not spawned yet', () => {
    const before = collectLeafOwners({ 'tb-a': leaf('pn-2', 'tb-a') });
    const after = collectLeafOwners({ 'tb-a': split('pn-1', [leaf('pn-2', 'tb-a'), leaf('pn-3', 'tm-new')]) });
    // The spawn itself carries the right owner, so the update would be a no-op.
    expect(diffOwnerChanges(before, after, bound('tb-a'))).toEqual([]);
  });

  // Detached-window boot: the first tree this window ever sees is one it was
  // handed, with its PTYs already attached.
  it('reports attached leaves on the first observation of a tree', () => {
    const after = collectLeafOwners({ 'tb-detached': leaf('pn-1', 'tm-moved') });
    expect(diffOwnerChanges(null, after, bound('tm-moved'))).toEqual([
      { rendererTerminalId: 'tm-moved', owningTabId: 'tb-detached' },
    ]);
  });

  it('does not report a cold start whose panes have not spawned yet', () => {
    const after = collectLeafOwners({ 'tb-a': leaf('pn-1', 'tb-a') });
    expect(diffOwnerChanges(null, after, noneBound)).toEqual([]);
  });

  // A pane that left this window (moved out / tab closed) is the DESTINATION's
  // business to report; a departure says nothing about the new owner.
  it('reports nothing for a leaf that disappeared', () => {
    const before = collectLeafOwners({ 'tb-a': split('pn-1', [leaf('pn-2', 'tb-a'), leaf('pn-3', 'tm-x')]) });
    const after = collectLeafOwners({ 'tb-a': leaf('pn-2', 'tb-a') });
    expect(diffOwnerChanges(before, after, bound('tm-x'))).toEqual([]);
  });
});
