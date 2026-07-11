import reducer, {
  initializePane,
  splitPane,
  splitPaneInTab,
  closePane,
  focusPane,
  setActiveTabId,
  addTabTree,
  removeTabTree,
  removePaneFromTab,
  insertPaneIntoTab,
  movePaneWithinTab,
  movePaneToTab,
  toggleMaximizePane,
  PaneNode,
} from '../panesSlice';

const init = () => reducer(undefined, { type: '@@INIT' } as any);
const withActive = (tabId: string) => reducer(init(), setActiveTabId(tabId));

const leaf = (id: string, tid: string): PaneNode => ({ id, type: 'terminal', terminalId: tid });

describe('panesSlice treesByTabId (additive mirror)', () => {
  it('setActiveTabId sets activeTabId and mirrors its tree into paneTree', () => {
    let s = init();
    s = reducer(s, addTabTree({ tabId: 'tb-1', tree: leaf('pn-1', 'tb-1') }));
    s = reducer(s, setActiveTabId('tb-1'));
    expect(s.activeTabId).toBe('tb-1');
    expect(s.paneTree?.id).toBe('pn-1');
  });

  it('initializePane (active tab) writes both paneTree and treesByTabId', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1', name: 'A' }));
    expect(s.paneTree?.terminalId).toBe('tb-1');
    expect(s.treesByTabId['tb-1']?.terminalId).toBe('tb-1');
  });

  it('splitPane keeps paneTree and treesByTabId in sync', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const paneId = s.paneTree!.id;
    s = reducer(s, splitPane({ paneId, direction: 'vertical', terminalId: 'tm-2' }));
    expect(s.paneTree?.type).toBe('split');
    expect(JSON.stringify(s.treesByTabId['tb-1'])).toEqual(JSON.stringify(s.paneTree));
  });

  it('closePane on the only pane clears that tab tree and paneTree', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    s = reducer(s, closePane(s.paneTree!.id));
    expect(s.treesByTabId['tb-1']).toBeUndefined();
    expect(s.paneTree).toBeNull();
  });

  it('removeTabTree drops the tab', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    s = reducer(s, removeTabTree('tb-1'));
    expect(s.treesByTabId['tb-1']).toBeUndefined();
  });
});

describe('panesSlice active-pane focus memory (per-tab)', () => {
  it('setActiveTabId selects the first leaf when the tab has no remembered pane', () => {
    let s = init();
    s = reducer(s, addTabTree({ tabId: 'tb-1', tree: leaf('pn-1', 'tb-1') }));
    s = reducer(s, setActiveTabId('tb-1'));
    expect(s.activePaneId).toBe('pn-1');
  });

  it("remembers each tab's active pane and restores it on return", () => {
    // tab tb-1: split into [a, b]; the user focuses b
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const rootId = s.paneTree!.id;
    s = reducer(s, splitPane({ paneId: rootId, direction: 'vertical', terminalId: 'tm-2' }));
    const [a, b] = s.paneTree!.children!;
    s = reducer(s, focusPane(b.id));
    expect(s.activePaneId).toBe(b.id);

    // tab tb-2: switch to it, split into [c, d], focus d
    s = reducer(s, addTabTree({ tabId: 'tb-2', tree: leaf('pn-c', 'tb-2') }));
    s = reducer(s, setActiveTabId('tb-2'));
    s = reducer(s, splitPane({ paneId: 'pn-c', direction: 'vertical', terminalId: 'tm-d' }));
    const [, d] = s.paneTree!.children!;
    s = reducer(s, focusPane(d.id));
    expect(s.activePaneId).toBe(d.id);

    // back to tb-1 → restores b (NOT the first leaf a, NOT tb-2's d)
    s = reducer(s, setActiveTabId('tb-1'));
    expect(s.activePaneId).toBe(b.id);

    // back to tb-2 → restores d
    s = reducer(s, setActiveTabId('tb-2'));
    expect(s.activePaneId).toBe(d.id);
  });

  it('falls back to the first leaf when the remembered pane was removed', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const rootId = s.paneTree!.id;
    s = reducer(s, splitPane({ paneId: rootId, direction: 'vertical', terminalId: 'tm-2' }));
    const [a, b] = s.paneTree!.children!;
    s = reducer(s, focusPane(b.id));

    // leave tb-1 (remembers b), then b is removed from tb-1 in the background
    s = reducer(s, addTabTree({ tabId: 'tb-2', tree: leaf('pn-c', 'tb-2') }));
    s = reducer(s, setActiveTabId('tb-2'));
    s = reducer(s, removePaneFromTab({ tabId: 'tb-1', paneId: b.id }));

    // return to tb-1 → remembered b is gone → first surviving leaf (a)
    s = reducer(s, setActiveTabId('tb-1'));
    expect(s.activePaneId).toBe(a.id);
  });
});

describe('panesSlice movePaneWithinTab', () => {
  // Build active tab tb-1 with a vertical split of two panes.
  const twoPaneTab = () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const rootId = s.paneTree!.id;
    s = reducer(s, splitPane({ paneId: rootId, direction: 'vertical', terminalId: 'tm-2' }));
    return s;
  };

  it('center swaps the two terminals, structure intact', () => {
    let s = twoPaneTab();
    const [a, b] = s.paneTree!.children!;
    s = reducer(s, movePaneWithinTab({ tabId: 'tb-1', sourcePaneId: a.id, targetPaneId: b.id, zone: 'center' }));
    expect(s.paneTree?.type).toBe('split');
    const [a2, b2] = s.paneTree!.children!;
    expect(a2.terminalId).toBe(b.terminalId);
    expect(b2.terminalId).toBe(a.terminalId);
  });

  it('no-op when source === target', () => {
    let s = twoPaneTab();
    const before = JSON.stringify(s.paneTree);
    const a = s.paneTree!.children![0];
    s = reducer(s, movePaneWithinTab({ tabId: 'tb-1', sourcePaneId: a.id, targetPaneId: a.id, zone: 'right' }));
    expect(JSON.stringify(s.paneTree)).toEqual(before);
  });

  it('edge zone re-splits: moving p1 to bottom of p2 yields horizontal split holding both', () => {
    let s = twoPaneTab();
    const [a, b] = s.paneTree!.children!;
    const aTid = a.terminalId, bTid = b.terminalId;
    s = reducer(s, movePaneWithinTab({ tabId: 'tb-1', sourcePaneId: a.id, targetPaneId: b.id, zone: 'bottom' }));
    // p1 removed from root (root collapses to p2), then p2 becomes a horizontal split [p2, p1]
    expect(s.paneTree?.type).toBe('split');
    expect(s.paneTree?.direction).toBe('horizontal');
    const tids = s.paneTree!.children!.map(c => c.terminalId);
    expect(tids).toEqual([bTid, aTid]);
  });
});

describe('panesSlice movePaneToTab', () => {
  const srcAndDst = () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const srcRoot = s.paneTree!.id;
    s = reducer(s, splitPane({ paneId: srcRoot, direction: 'vertical', terminalId: 'tm-2' }));
    // destination tab tb-2 with a single pane
    s = reducer(s, addTabTree({ tabId: 'tb-2', tree: leaf('pn-q1', 'tb-2') }));
    return s;
  };

  it('inserts into target tree and removes from source', () => {
    let s = srcAndDst();
    const srcPane = s.treesByTabId['tb-1'].children![0]; // p1 (tb-1)
    s = reducer(s, movePaneToTab({
      sourceTabId: 'tb-1', sourcePaneId: srcPane.id,
      targetTabId: 'tb-2', targetPaneId: 'pn-q1', zone: 'right',
    }));
    // tb-2 now a vertical split [tb-2, tb-1]
    expect(s.treesByTabId['tb-2'].type).toBe('split');
    expect(s.treesByTabId['tb-2'].children!.map(c => c.terminalId)).toEqual(['tb-2', 'tb-1']);
    // tb-1 collapsed to remaining pane (tm-2)
    expect(s.treesByTabId['tb-1'].type).toBe('terminal');
    expect(s.treesByTabId['tb-1'].terminalId).toBe('tm-2');
  });

  it('removePaneFromTab prunes a pane and deletes the tab when it empties', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const onlyPane = s.paneTree!.id;
    s = reducer(s, removePaneFromTab({ tabId: 'tb-1', paneId: onlyPane }));
    expect(s.treesByTabId['tb-1']).toBeUndefined();
    expect(s.paneTree).toBeNull();
    expect(s.activePaneId).toBeNull();
  });

  it('removePaneFromTab repoints activePaneId to a survivor when the active pane is removed', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const rootId = s.paneTree!.id;
    s = reducer(s, splitPane({ paneId: rootId, direction: 'vertical', terminalId: 'tm-2' }));
    const [a, b] = s.paneTree!.children!;
    // splitPane makes the new pane (b) active; remove it and the active pane must
    // repoint to the surviving leaf (a), never the removed id.
    expect(s.activePaneId).toBe(b.id);
    s = reducer(s, removePaneFromTab({ tabId: 'tb-1', paneId: b.id }));
    expect(s.activePaneId).not.toBe(b.id);
    expect(s.activePaneId).toBe(a.id);
  });

  it('insertPaneIntoTab inserts an external leaf at the target pane/zone (cross-window drop)', () => {
    let s = withActive('tb-2');
    s = reducer(s, addTabTree({ tabId: 'tb-2', tree: leaf('pn-q1', 'tb-2') }));
    s = reducer(s, setActiveTabId('tb-2'));
    const external = leaf('pn-ext', 'tm-ext');
    s = reducer(s, insertPaneIntoTab({ tabId: 'tb-2', targetPaneId: 'pn-q1', zone: 'right', node: external }));
    expect(s.treesByTabId['tb-2'].type).toBe('split');
    expect(s.treesByTabId['tb-2'].children!.map((c) => c.terminalId)).toEqual(['tb-2', 'tm-ext']);
    expect(s.activePaneId).toBe('pn-ext');
  });

  it('deletes source tab tree when it empties', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const onlyPane = s.paneTree!.id;
    s = reducer(s, addTabTree({ tabId: 'tb-2', tree: leaf('pn-q1', 'tb-2') }));
    s = reducer(s, movePaneToTab({
      sourceTabId: 'tb-1', sourcePaneId: onlyPane,
      targetTabId: 'tb-2', targetPaneId: 'pn-q1', zone: 'left',
    }));
    expect(s.treesByTabId['tb-1']).toBeUndefined();
    expect(s.treesByTabId['tb-2'].children!.map(c => c.terminalId)).toEqual(['tb-1', 'tb-2']);
  });
});

describe('panesSlice splitPaneInTab (tab-scoped, no activation)', () => {
  it('splits a BACKGROUND tab without touching activeTabId or paneTree', () => {
    // Active tab is tb-1; tb-2 exists in the background with a single pane.
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    s = reducer(s, addTabTree({ tabId: 'tb-2', tree: leaf('pn-2', 'tm-2') }));

    const activeBefore = s.activeTabId;
    const paneTreeBefore = JSON.stringify(s.paneTree);

    s = reducer(s, splitPaneInTab({ tabId: 'tb-2', paneId: 'pn-2', direction: 'vertical', terminalId: 'tm-3' }));

    // Background tab's tree became a split with two terminals.
    expect(s.treesByTabId['tb-2'].type).toBe('split');
    expect(s.treesByTabId['tb-2'].children?.length).toBe(2);
    // Active tab + its mirror are untouched.
    expect(s.activeTabId).toBe(activeBefore);
    expect(JSON.stringify(s.paneTree)).toBe(paneTreeBefore);
    // New pane recorded as the background tab's remembered active pane.
    expect(s.activePaneByTabId['tb-2']).toBeDefined();
  });

  it('mirrors into paneTree when splitting the ACTIVE tab', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const paneId = s.paneTree!.id;
    s = reducer(s, splitPaneInTab({ tabId: 'tb-1', paneId, direction: 'vertical', terminalId: 'tm-9' }));
    expect(s.paneTree?.type).toBe('split');
    expect(JSON.stringify(s.treesByTabId['tb-1'])).toEqual(JSON.stringify(s.paneTree));
  });

  it('seeds a single-terminal tree for a tab that has none', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    s = reducer(s, splitPaneInTab({ tabId: 'tb-empty', direction: 'vertical', terminalId: 'tm-seed' }));
    expect(s.treesByTabId['tb-empty'].type).toBe('terminal');
    expect(s.treesByTabId['tb-empty'].terminalId).toBe('tm-seed');
    // Active tab untouched.
    expect(s.activeTabId).toBe('tb-1');
  });

  it('splits the first leaf when no paneId is given', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    s = reducer(s, addTabTree({ tabId: 'tb-2', tree: leaf('pn-2', 'tm-2') }));
    s = reducer(s, splitPaneInTab({ tabId: 'tb-2', direction: 'horizontal', terminalId: 'tm-3' }));
    expect(s.treesByTabId['tb-2'].type).toBe('split');
  });

  it('falls back to the first leaf when the given paneId does not exist (no silent drop)', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    s = reducer(s, addTabTree({ tabId: 'tb-2', tree: leaf('pn-2', 'tm-2') }));
    // 'pn-stale' is not in tb-2's tree — the terminal must still be added.
    s = reducer(s, splitPaneInTab({ tabId: 'tb-2', paneId: 'pn-stale', direction: 'vertical', terminalId: 'tm-3' }));
    expect(s.treesByTabId['tb-2'].type).toBe('split');
    const tids = s.treesByTabId['tb-2'].children!.map(c => c.terminalId).sort();
    expect(tids).toEqual(['tm-2', 'tm-3']);
  });
});

describe('panesSlice maximize (pane zoom)', () => {
  // Active tab tb-1 with a vertical split of two real panes (ids generated by splitPane).
  const twoPaneActive = () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const rootId = s.paneTree!.id;
    s = reducer(s, splitPane({ paneId: rootId, direction: 'vertical', terminalId: 'tm-2' }));
    const [a, b] = s.paneTree!.children!;
    return { s, aId: a.id, bId: b.id };
  };

  it('toggleMaximizePane sets then clears the tab flag', () => {
    let { s, aId } = twoPaneActive();
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: aId }));
    expect(s.maximizedPaneByTabId['tb-1']).toBe(aId);
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: aId }));
    expect(s.maximizedPaneByTabId['tb-1']).toBeUndefined();
  });

  it('is per-tab: maximizing one tab does not affect another', () => {
    let s = init();
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: 'pn-a' }));
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-2', paneId: 'pn-x' }));
    expect(s.maximizedPaneByTabId['tb-1']).toBe('pn-a');
    expect(s.maximizedPaneByTabId['tb-2']).toBe('pn-x');
    // Re-toggling tb-1 leaves tb-2 untouched.
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: 'pn-a' }));
    expect(s.maximizedPaneByTabId['tb-1']).toBeUndefined();
    expect(s.maximizedPaneByTabId['tb-2']).toBe('pn-x');
  });

  it('closing the maximized pane clears the flag (lifecycle)', () => {
    let { s, aId } = twoPaneActive();
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: aId }));
    s = reducer(s, closePane(aId));
    expect(s.maximizedPaneByTabId['tb-1']).toBeUndefined();
  });

  it('splitting the maximized pane clears the flag — H1 (active tab)', () => {
    let { s, aId } = twoPaneActive();
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: aId }));
    s = reducer(s, splitPane({ paneId: aId, direction: 'horizontal', terminalId: 'tm-3' }));
    // Without the fix, the flag would still point at aId — now a split node — and hide the sibling.
    expect(s.maximizedPaneByTabId['tb-1']).toBeUndefined();
  });

  it('splitPaneInTab on the maximized pane clears the flag — H1 (background tab)', () => {
    let s = withActive('tb-2'); // active elsewhere; tb-1 is a background tab
    s = reducer(s, addTabTree({ tabId: 'tb-1', tree: leaf('pn-a', 'tm-a') }));
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: 'pn-a' }));
    s = reducer(s, splitPaneInTab({ tabId: 'tb-1', paneId: 'pn-a', direction: 'vertical', terminalId: 'tm-b' }));
    expect(s.maximizedPaneByTabId['tb-1']).toBeUndefined();
  });

  it('removeTabTree clears the tab maximize flag', () => {
    let s = init();
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: 'pn-a' }));
    s = reducer(s, removeTabTree('tb-1'));
    expect(s.maximizedPaneByTabId['tb-1']).toBeUndefined();
  });

  it('movePaneToTab clears a dangling maximize on the source tab — M2', () => {
    let { s, aId } = twoPaneActive();
    s = reducer(s, addTabTree({ tabId: 'tb-2', tree: leaf('pn-q1', 'tb-2') }));
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: aId }));
    s = reducer(s, movePaneToTab({
      sourceTabId: 'tb-1', sourcePaneId: aId,
      targetTabId: 'tb-2', targetPaneId: 'pn-q1', zone: 'right',
    }));
    expect(s.maximizedPaneByTabId['tb-1']).toBeUndefined();
  });

  it('inserting a pane into a maximized tab clears the flag so the new pane is visible — L4', () => {
    let { s, aId } = twoPaneActive();
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: aId }));
    s = reducer(s, insertPaneIntoTab({
      tabId: 'tb-1', targetPaneId: aId, zone: 'right', node: leaf('pn-new', 'tm-new'),
    }));
    expect(s.maximizedPaneByTabId['tb-1']).toBeUndefined();
  });
});
