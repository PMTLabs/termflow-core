import { PaneNode } from '../panesSlice';
import {
  removeLeaf,
  insertByZone,
  swapLeaves,
  findLeaf,
  findTabIdByTerminalId,
  getAllTerminalIds,
  getSelectedPaneId,
  resolveExitedTabId,
} from '../paneTreeOps';

const leaf = (id: string, tid: string): PaneNode => ({ id, type: 'terminal', terminalId: tid });
const hsplit = (id: string, a: PaneNode, b: PaneNode): PaneNode =>
  ({ id, type: 'split', direction: 'horizontal', size: 50, children: [a, b] });

describe('removeLeaf', () => {
  it('removes a leaf and collapses the parent split into the sibling', () => {
    const tree = hsplit('s1', leaf('p1', 't1'), leaf('p2', 't2'));
    const { tree: next, removed } = removeLeaf(tree, 'p2');
    expect(removed?.terminalId).toBe('t2');
    expect(next?.id).toBe('p1'); // collapsed to sibling
    expect(next?.type).toBe('terminal');
  });

  it('returns null tree when removing the only leaf', () => {
    const { tree: next, removed } = removeLeaf(leaf('p1', 't1'), 'p1');
    expect(next).toBeNull();
    expect(removed?.terminalId).toBe('t1');
  });

  it('collapses nested splits correctly', () => {
    const tree = hsplit('s1', leaf('p1', 't1'), hsplit('s2', leaf('p2', 't2'), leaf('p3', 't3')));
    const { tree: next } = removeLeaf(tree, 'p3');
    // s2 collapses to p2; s1 now has [p1, p2]
    expect(next?.children?.map(c => c.terminalId)).toEqual(['t1', 't2']);
  });

  it('does not mutate the input tree', () => {
    const tree = hsplit('s1', leaf('p1', 't1'), leaf('p2', 't2'));
    const snapshot = JSON.stringify(tree);
    removeLeaf(tree, 'p2');
    expect(JSON.stringify(tree)).toEqual(snapshot);
  });

  it('is a no-op (removed=null) for an unknown id', () => {
    const tree = hsplit('s1', leaf('p1', 't1'), leaf('p2', 't2'));
    const { tree: next, removed } = removeLeaf(tree, 'nope');
    expect(removed).toBeNull();
    expect(next?.type).toBe('split');
  });
});

describe('insertByZone', () => {
  it('left -> vertical split with new node first', () => {
    const next = insertByZone(leaf('p1', 't1'), 'p1', leaf('pX', 'tX'), 'left');
    expect(next.type).toBe('split');
    expect(next.direction).toBe('vertical');
    expect(next.children?.map(c => c.terminalId)).toEqual(['tX', 't1']);
  });

  it('right -> vertical split with target first', () => {
    const next = insertByZone(leaf('p1', 't1'), 'p1', leaf('pX', 'tX'), 'right');
    expect(next.direction).toBe('vertical');
    expect(next.children?.map(c => c.terminalId)).toEqual(['t1', 'tX']);
  });

  it('top -> horizontal split, new node first', () => {
    const next = insertByZone(leaf('p1', 't1'), 'p1', leaf('pX', 'tX'), 'top');
    expect(next.direction).toBe('horizontal');
    expect(next.children?.map(c => c.terminalId)).toEqual(['tX', 't1']);
  });

  it('bottom -> horizontal split, target first', () => {
    const next = insertByZone(leaf('p1', 't1'), 'p1', leaf('pX', 'tX'), 'bottom');
    expect(next.direction).toBe('horizontal');
    expect(next.children?.map(c => c.terminalId)).toEqual(['t1', 'tX']);
  });

  it('inserts into a nested target', () => {
    const tree = hsplit('s1', leaf('p1', 't1'), leaf('p2', 't2'));
    const next = insertByZone(tree, 'p2', leaf('pX', 'tX'), 'right');
    const s1b = next.children?.[1];
    expect(s1b?.type).toBe('split');
    expect(s1b?.children?.map(c => c.terminalId)).toEqual(['t2', 'tX']);
  });

  it('does not mutate the input tree', () => {
    const tree = hsplit('s1', leaf('p1', 't1'), leaf('p2', 't2'));
    const snapshot = JSON.stringify(tree);
    insertByZone(tree, 'p2', leaf('pX', 'tX'), 'right');
    expect(JSON.stringify(tree)).toEqual(snapshot);
  });
});

describe('swapLeaves', () => {
  it('swaps terminalId/name/shellType of two leaves', () => {
    const tree = hsplit('s1',
      { id: 'p1', type: 'terminal', terminalId: 't1', name: 'A', shellType: 'zsh' },
      { id: 'p2', type: 'terminal', terminalId: 't2', name: 'B', shellType: 'bash' });
    const next = swapLeaves(tree, 'p1', 'p2');
    const [c1, c2] = next.children!;
    expect([c1.terminalId, c1.name, c1.shellType]).toEqual(['t2', 'B', 'bash']);
    expect([c2.terminalId, c2.name, c2.shellType]).toEqual(['t1', 'A', 'zsh']);
  });
});

describe('findLeaf', () => {
  it('finds a leaf by id', () => {
    const tree = hsplit('s1', leaf('p1', 't1'), leaf('p2', 't2'));
    expect(findLeaf(tree, 'p2')?.terminalId).toBe('t2');
  });
  it('returns null for missing id', () => {
    expect(findLeaf(leaf('p1', 't1'), 'nope')).toBeNull();
  });
});

describe('findTabIdByTerminalId', () => {
  it('finds the tab containing a terminal in a single-leaf tree', () => {
    const trees = { 'tb-1': leaf('p1', 't1'), 'tb-2': leaf('p2', 't2') };
    expect(findTabIdByTerminalId(trees, 't2')).toBe('tb-2');
  });

  it('finds the tab when the terminal is nested inside splits', () => {
    const trees = {
      'tb-1': hsplit('s1', leaf('p1', 't1'), hsplit('s2', leaf('p2', 't2'), leaf('p3', 't3'))),
    };
    expect(findTabIdByTerminalId(trees, 't3')).toBe('tb-1');
  });

  it('returns null when no tree contains the terminal', () => {
    const trees = { 'tb-1': leaf('p1', 't1') };
    expect(findTabIdByTerminalId(trees, 'nope')).toBeNull();
  });

  it('returns null for an empty trees map', () => {
    expect(findTabIdByTerminalId({}, 'any')).toBeNull();
  });
});

describe('getAllTerminalIds', () => {
  it('returns the single terminalId of a leaf tree', () => {
    expect(getAllTerminalIds(leaf('p1', 't1'))).toEqual(['t1']);
  });

  it('collects every terminalId across nested splits, depth-first', () => {
    const tree = hsplit('s1', leaf('p1', 't1'), hsplit('s2', leaf('p2', 't2'), leaf('p3', 't3')));
    expect(getAllTerminalIds(tree)).toEqual(['t1', 't2', 't3']);
  });

  it('returns [] for a null tree', () => {
    expect(getAllTerminalIds(null)).toEqual([]);
  });

  it('skips terminal nodes that have no terminalId', () => {
    const tree = hsplit('s1', { id: 'p1', type: 'terminal' }, leaf('p2', 't2'));
    expect(getAllTerminalIds(tree)).toEqual(['t2']);
  });
});

describe('getSelectedPaneId', () => {
  it('returns the remembered active pane when it still exists in the tree', () => {
    const tree = hsplit('s1', leaf('p1', 't1'), leaf('p2', 't2'));
    const treesByTabId = { 'tab-1': tree };
    const activePaneByTabId = { 'tab-1': 'p2' };
    expect(getSelectedPaneId(treesByTabId, activePaneByTabId, 'tab-1')).toBe('p2');
  });

  it('falls back to the first terminal leaf when no pane is remembered', () => {
    const tree = hsplit('s1', leaf('p1', 't1'), leaf('p2', 't2'));
    const treesByTabId = { 'tab-1': tree };
    expect(getSelectedPaneId(treesByTabId, {}, 'tab-1')).toBe('p1');
  });

  it('falls back to the first terminal leaf when the remembered pane no longer exists (e.g. closed)', () => {
    const tree = hsplit('s1', leaf('p1', 't1'), leaf('p2', 't2'));
    const treesByTabId = { 'tab-1': tree };
    const activePaneByTabId = { 'tab-1': 'p-stale' };
    expect(getSelectedPaneId(treesByTabId, activePaneByTabId, 'tab-1')).toBe('p1');
  });

  it('returns null for an unknown tab id', () => {
    expect(getSelectedPaneId({}, {}, 'tab-missing')).toBeNull();
  });
});

describe('resolveExitedTabId', () => {
  const alive = (aliveIds: string[]) => (id: string) => aliveIds.includes(id);

  it('resolves a never-split tab whose root terminalId equals the tab id', () => {
    // treesByTabId has no entry until a tab is split (see splitPaneInTab).
    expect(resolveExitedTabId({}, ['tab-1'], 'tab-1', alive([]))).toBe('tab-1');
  });

  it('returns null when the exited id belongs to no known tab', () => {
    expect(resolveExitedTabId({}, ['tab-1'], 'nope', alive([]))).toBeNull();
  });

  it('returns null when a sibling pane in the tab is still alive', () => {
    const tree = hsplit('s1', leaf('p1', 'tab-1'), leaf('p2', 't2'));
    const trees = { 'tab-1': tree };
    // Root pane (terminalId === tab id) exited, but t2 is still running.
    expect(resolveExitedTabId(trees, ['tab-1'], 'tab-1', alive(['t2']))).toBeNull();
  });

  it('resolves the tab once every pane in a multi-pane tree has exited (bug repro)', () => {
    const tree = hsplit('s1', leaf('p1', 'tab-1'), leaf('p2', 't2'));
    const trees = { 'tab-1': tree };
    // t2 exited earlier (no longer alive); the root pane exits last here.
    expect(resolveExitedTabId(trees, ['tab-1'], 'tab-1', alive([]))).toBe('tab-1');
  });

  it('resolves the tab when a non-root pane is the last to exit', () => {
    const tree = hsplit('s1', leaf('p1', 'tab-1'), leaf('p2', 't2'));
    const trees = { 'tab-1': tree };
    // Root pane already exited; t2 exiting now is the last live pane.
    expect(resolveExitedTabId(trees, ['tab-1'], 't2', alive([]))).toBe('tab-1');
  });

  it('returns null with three panes when two are alive', () => {
    const tree = hsplit('s1', leaf('p1', 'tab-1'), hsplit('s2', leaf('p2', 't2'), leaf('p3', 't3')));
    const trees = { 'tab-1': tree };
    expect(resolveExitedTabId(trees, ['tab-1'], 't3', alive(['t2']))).toBeNull();
  });

  it('resolves with three panes once the last one exits', () => {
    const tree = hsplit('s1', leaf('p1', 'tab-1'), hsplit('s2', leaf('p2', 't2'), leaf('p3', 't3')));
    const trees = { 'tab-1': tree };
    expect(resolveExitedTabId(trees, ['tab-1'], 't3', alive([]))).toBe('tab-1');
  });

  // Detach-to-new-window (detach.ts): detachPaneToNewWindow generates a FRESH
  // tab id for the destination tab, but reuses the dragged pane's original
  // PaneNode (and its terminalId) as the tree root — so the destination tab's
  // root terminalId does NOT equal its own tab id. Same window/store instance
  // (each detached window has its own React app + Redux store + TerminalService
  // singleton), so this must still resolve via the tree, not the direct-id path.
  it('resolves a detached single-pane tab whose root terminalId does not equal the new tab id', () => {
    const trees = { 'tb-new': leaf('p1', 'tm-original-pane-id') };
    expect(resolveExitedTabId(trees, ['tb-new'], 'tm-original-pane-id', alive([]))).toBe('tb-new');
  });

  // Whole-tab detach (detachTabToNewWindow/dropTabAcrossWindows) reuses the
  // SAME tab id in the destination window, so the root-pane direct-id path
  // still applies there.
  it('resolves a whole-tab detach that kept its original tab id', () => {
    const tree = hsplit('s1', leaf('p1', 'tab-1'), leaf('p2', 't2'));
    const trees = { 'tab-1': tree };
    expect(resolveExitedTabId(trees, ['tab-1'], 'tab-1', alive(['t2']))).toBeNull();
    expect(resolveExitedTabId(trees, ['tab-1'], 't2', alive([]))).toBe('tab-1');
  });

  // Source window after detach: removeSourceTab/removePaneFromTab strip the
  // tab from tabIds and its entry from treesByTabId, so a stray broadcast
  // pty:exit for a terminal that already moved to another window's TerminalService
  // must resolve to nothing here, not to a stale/wrong tab.
  it('returns null in the source window once the tab/pane has been detached away', () => {
    expect(resolveExitedTabId({}, [], 'tm-original-pane-id', alive([]))).toBeNull();
  });
});
