import reducer, {
  initializePane,
  splitPane,
  splitPaneInTab,
  closePane,
  focusPane,
  focusPaneInTab,
  resizeFocusedPane,
  setActiveTabId,
  setPaneTree,
  addTabTree,
  removeTabTree,
  removePaneFromTab,
  insertPaneIntoTab,
  movePaneWithinTab,
  movePaneToTab,
  toggleMaximizePane,
  setPaneMuted,
  splitPaneWithTab,
  renamePanes,
  PaneNode,
} from '../panesSlice';
import { findLeaf } from '../paneTreeOps';

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

  // The tab is left EMPTY, not UNINITIALISED, and the difference is the whole bug: an
  // absent key is what `planSeeds` fills in, so deleting it here meant closing an active
  // tab's last pane immediately manufactured a replacement terminal for it.
  it('closePane on the only pane empties that tab tree without deleting its key', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    s = reducer(s, closePane(s.paneTree!.id));
    expect(s.paneTree).toBeNull();
    expect(s.treesByTabId['tb-1']).toBeNull();
    expect('tb-1' in s.treesByTabId).toBe(true);
  });

  // syncActive only ever DOWNGRADES an entry that exists. A virtual tab (canvas, settings)
  // is active with no tree of its own, and minting a null key for it would give the canvas
  // a group frame for ITSELF.
  //
  // Driven through `setPaneTree(null)` deliberately: that reducer reaches `syncActive`
  // unconditionally, and it is the real path — `TerminalContainer` dispatches exactly this
  // when the active tab is closed. Routed through `closePane` instead, the reducer returns
  // on its own `if (!state.paneTree)` guard and `syncActive` never runs at all, so the
  // assertion holds no matter what `syncActive` does. It passed while the mutant lived.
  it('syncActive does not mint a key for an active tab that never had one', () => {
    let s = withActive('tb-canvas');
    s = reducer(s, setPaneTree(null));
    expect('tb-canvas' in s.treesByTabId).toBe(false);
  });

  // The positive control for the test above, through the SAME reducer: an entry that exists
  // is downgraded to null. Without this pair, "never mint a key" would also be satisfied by
  // a syncActive that had stopped writing anything.
  it('syncActive downgrades an existing entry to null through the same path', () => {
    let s = withActive('tb-1');
    s = reducer(s, addTabTree({ tabId: 'tb-1', tree: leaf('pn-1', 'tb-1') }));
    s = reducer(s, setPaneTree(null));
    expect('tb-1' in s.treesByTabId).toBe(true);
    expect(s.treesByTabId['tb-1']).toBeNull();
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

  /**
   * An EMPTY destination is a destination.
   *
   * A tab someone emptied by dragging its last terminal away stays open and stays a drop
   * target — that is the whole point of the null state. This guard read `!dstTree`, so null
   * failed it exactly like a tab that does not exist, and dropping a pane onto the emptied
   * tab's header silently did nothing. `insertPaneIntoTab` and `planRegroup` had already
   * been taught the difference; this was the third caller of the same guard and it was
   * missed, which is why the fix is asserted here rather than assumed from the other two.
   */
  it('moves a pane into a tab that is open and EMPTY', () => {
    let s = srcAndDst();
    s = reducer(s, addTabTree({ tabId: 'tb-empty', tree: null }));
    const srcPane = s.treesByTabId['tb-1'].children![0];
    s = reducer(s, movePaneToTab({
      sourceTabId: 'tb-1', sourcePaneId: srcPane.id,
      targetTabId: 'tb-empty', targetPaneId: 'pn-anything', zone: 'right',
    }));
    expect(s.treesByTabId['tb-empty']).not.toBeNull();
    expect(s.treesByTabId['tb-empty'].terminalId).toBe('tb-1');
    // ...and it really left the source, rather than being copied into both.
    expect(s.treesByTabId['tb-1'].terminalId).toBe('tm-2');
  });

  // The negative half: `undefined` still means "no such tab" and is still refused. Without
  // this, widening the guard to accept anything falsy would pass the test above.
  it('refuses a destination tab that was never initialised', () => {
    let s = srcAndDst();
    const srcPane = s.treesByTabId['tb-1'].children![0];
    const before = s.treesByTabId['tb-1'];
    s = reducer(s, movePaneToTab({
      sourceTabId: 'tb-1', sourcePaneId: srcPane.id,
      targetTabId: 'tb-nope', targetPaneId: 'pn-anything', zone: 'right',
    }));
    expect('tb-nope' in s.treesByTabId).toBe(false);
    expect(s.treesByTabId['tb-1']).toEqual(before);
  });

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

  // The entry survives holding null — "open and empty" — rather than being deleted. Deleting
  // it made an emptied tab look identical to one that had never been initialised, and
  // TerminalContainer's seed effect then gave it a terminal it had just given away.
  it('removePaneFromTab prunes a pane and leaves the tab entry null when it empties', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const onlyPane = s.paneTree!.id;
    s = reducer(s, removePaneFromTab({ tabId: 'tb-1', paneId: onlyPane }));
    expect('tb-1' in s.treesByTabId).toBe(true);
    expect(s.treesByTabId['tb-1']).toBeNull();
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

  // An empty tab is a legal DESTINATION: design 010 §6.3 keeps an emptied group's frame on
  // the canvas as a drop target, so the drop has to land somewhere. The arriving pane becomes
  // the tab's whole tree. Refusing it left a group you could drag out of and never back into.
  it('insertPaneIntoTab makes the arriving pane the whole tree of an emptied tab', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    s = reducer(s, removePaneFromTab({ tabId: 'tb-1', paneId: s.paneTree!.id }));
    expect(s.treesByTabId['tb-1']).toBeNull();

    s = reducer(s, insertPaneIntoTab({
      tabId: 'tb-1', targetPaneId: null, zone: 'right', node: leaf('pn-back', 'tm-back'),
    }));
    expect(s.treesByTabId['tb-1']!.type).toBe('terminal');
    expect(s.treesByTabId['tb-1']!.terminalId).toBe('tm-back');
  });

  // A tab whose entry was never written has no layout to insert into — distinct from the null
  // above, and still refused. Without this the two cases could collapse into one and the
  // reducer would start manufacturing trees for tabs that are still starting up.
  it('insertPaneIntoTab refuses a tab that has no entry at all', () => {
    let s = withActive('tb-1');
    s = reducer(s, insertPaneIntoTab({
      tabId: 'tb-never', targetPaneId: null, zone: 'right', node: leaf('pn-x', 'tm-x'),
    }));
    expect('tb-never' in s.treesByTabId).toBe(false);
  });

  it('nulls the source tab tree when it empties', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const onlyPane = s.paneTree!.id;
    s = reducer(s, addTabTree({ tabId: 'tb-2', tree: leaf('pn-q1', 'tb-2') }));
    s = reducer(s, movePaneToTab({
      sourceTabId: 'tb-1', sourcePaneId: onlyPane,
      targetTabId: 'tb-2', targetPaneId: 'pn-q1', zone: 'left',
    }));
    // Null, not deleted. `PaneDragController.commitDrop` reads exactly this to decide whether
    // to close the source tab, so the tab-strip drag still closes a tab it empties.
    expect('tb-1' in s.treesByTabId).toBe(true);
    expect(s.treesByTabId['tb-1']).toBeNull();
    expect(s.treesByTabId['tb-2']!.children!.map(c => c.terminalId)).toEqual(['tb-1', 'tb-2']);
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

describe('panesSlice resizeFocusedPane (Alt+Shift+Arrow)', () => {
  // Active tab tb-1 with a side-by-side ('vertical') split [a | b], size 50.
  const sideBySide = () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    s = reducer(s, splitPane({ paneId: s.paneTree!.id, direction: 'vertical', terminalId: 'tm-2' }));
    const [a, b] = s.paneTree!.children!;
    return { s, aId: a.id, bId: b.id };
  };

  it('right/left nudge the divider of a side-by-side split by 5%', () => {
    let { s, aId } = sideBySide();
    s = reducer(s, focusPane(aId));
    s = reducer(s, resizeFocusedPane({ direction: 'right' }));
    expect(s.paneTree!.size).toBe(55);
    s = reducer(s, resizeFocusedPane({ direction: 'left' }));
    expect(s.paneTree!.size).toBe(50);
  });

  it('divider direction is absolute — same delta whichever child is focused', () => {
    let { s, bId } = sideBySide();
    s = reducer(s, focusPane(bId));
    // Focus on the RIGHT pane: Right still moves the shared divider right (grows a, shrinks b).
    s = reducer(s, resizeFocusedPane({ direction: 'right' }));
    expect(s.paneTree!.size).toBe(55);
  });

  it('up/down are a no-op when the focused pane has no stacked ancestor', () => {
    let { s, aId } = sideBySide();
    s = reducer(s, focusPane(aId));
    const before = JSON.stringify(s.paneTree);
    s = reducer(s, resizeFocusedPane({ direction: 'up' }));
    s = reducer(s, resizeFocusedPane({ direction: 'down' }));
    expect(JSON.stringify(s.paneTree)).toEqual(before);
  });

  it('targets the NEAREST matching-orientation ancestor in a nested layout', () => {
    // Root: [a | (b over c)] — vertical root, second child split horizontally.
    let { s, bId } = sideBySide();
    s = reducer(s, splitPane({ paneId: bId, direction: 'horizontal', terminalId: 'tm-3' }));
    const inner = s.paneTree!.children![1];
    const cId = inner.children![1].id;
    s = reducer(s, focusPane(cId));

    // Down adjusts the inner stacked split; Right walks up to the vertical root.
    s = reducer(s, resizeFocusedPane({ direction: 'down' }));
    expect(s.paneTree!.children![1].size).toBe(55);
    expect(s.paneTree!.size).toBe(50);
    s = reducer(s, resizeFocusedPane({ direction: 'right' }));
    expect(s.paneTree!.size).toBe(55);
    expect(s.paneTree!.children![1].size).toBe(55);
  });

  it('clamps to the same 10-90 range as drag resize', () => {
    let { s, aId } = sideBySide();
    s = reducer(s, focusPane(aId));
    for (let i = 0; i < 12; i++) {
      s = reducer(s, resizeFocusedPane({ direction: 'right' }));
    }
    expect(s.paneTree!.size).toBe(90);
    for (let i = 0; i < 20; i++) {
      s = reducer(s, resizeFocusedPane({ direction: 'left' }));
    }
    expect(s.paneTree!.size).toBe(10);
  });

  it('no-op on a single-pane tab and when no tree exists', () => {
    let s = withActive('tb-1');
    expect(() => reducer(s, resizeFocusedPane({ direction: 'right' }))).not.toThrow();
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const before = JSON.stringify(s.paneTree);
    s = reducer(s, resizeFocusedPane({ direction: 'right' }));
    expect(JSON.stringify(s.paneTree)).toEqual(before);
  });

  it('is a no-op while the tab has a maximized pane (review 053 F2: no invisible layout drift)', () => {
    let { s, aId } = sideBySide();
    s = reducer(s, focusPane(aId));
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: aId }));
    s = reducer(s, resizeFocusedPane({ direction: 'right' }));
    expect(s.paneTree!.size).toBe(50);
    // Un-maximize -> resizing works again.
    s = reducer(s, toggleMaximizePane({ tabId: 'tb-1', paneId: aId }));
    s = reducer(s, resizeFocusedPane({ direction: 'right' }));
    expect(s.paneTree!.size).toBe(55);
  });

  it('mirrors the resized tree into treesByTabId (syncActive)', () => {
    let { s, aId } = sideBySide();
    s = reducer(s, focusPane(aId));
    s = reducer(s, resizeFocusedPane({ direction: 'right' }));
    expect(s.treesByTabId['tb-1'].size).toBe(55);
  });
});

describe('panesSlice setPaneMuted', () => {
  // A split tab: pn-a/tm-1 and pn-b/tm-2 side by side.
  const sideBySide = () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    s = reducer(s, splitPane({ paneId: s.paneTree!.id, direction: 'vertical', terminalId: 'tm-2' }));
    const [a, b] = s.paneTree!.children!;
    return { s, aId: a.id, bId: b.id };
  };

  it('mutes only the targeted pane leaf', () => {
    let { s, aId, bId } = sideBySide();
    s = reducer(s, setPaneMuted({ paneId: aId, muted: true }));
    expect(findLeaf(s.treesByTabId['tb-1'], aId)?.notifyMuted).toBe(true);
    expect(findLeaf(s.treesByTabId['tb-1'], bId)?.notifyMuted).toBeUndefined();
  });

  it('keeps the active-tab paneTree mirror in sync (shared object graph)', () => {
    let { s, aId } = sideBySide();
    s = reducer(s, setPaneMuted({ paneId: aId, muted: true }));
    expect(findLeaf(s.paneTree, aId)?.notifyMuted).toBe(true);
  });

  it('unmute deletes the flag', () => {
    let { s, aId } = sideBySide();
    s = reducer(s, setPaneMuted({ paneId: aId, muted: true }));
    s = reducer(s, setPaneMuted({ paneId: aId, muted: false }));
    expect(findLeaf(s.treesByTabId['tb-1'], aId)?.notifyMuted).toBeUndefined();
  });

  it('mutes a pane in a BACKGROUND tab (not the active one)', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    // Seed a background tab tree directly.
    s = reducer(s, addTabTree({ tabId: 'tb-2', tree: { id: 'pn-bg', type: 'terminal', terminalId: 'tm-bg' } }));
    s = reducer(s, setPaneMuted({ paneId: 'pn-bg', muted: true }));
    expect(findLeaf(s.treesByTabId['tb-2'], 'pn-bg')?.notifyMuted).toBe(true);
  });

  it('closing a muted pane removes its mute state (no orphan)', () => {
    let { s, aId } = sideBySide();
    s = reducer(s, setPaneMuted({ paneId: aId, muted: true }));
    s = reducer(s, closePane(aId));
    // aId is gone from the tree entirely; nothing muted lingers.
    expect(findLeaf(s.treesByTabId['tb-1'], aId)).toBeNull();
  });

  it('is a no-op for an unknown pane id', () => {
    let { s } = sideBySide();
    const before = JSON.stringify(s.treesByTabId);
    s = reducer(s, setPaneMuted({ paneId: 'pn-missing', muted: true }));
    expect(JSON.stringify(s.treesByTabId)).toEqual(before);
  });

  // Regression (external review, codex finding 1): splitting a muted pane must
  // carry the mute onto the leaf that keeps the original terminal, start the new
  // sibling unmuted, and never strand the flag on the converted split node.
  it('splitPane carries pane mute to the original terminal, new sibling unmuted, split node clean', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const rootId = s.paneTree!.id;
    s = reducer(s, setPaneMuted({ paneId: rootId, muted: true }));
    s = reducer(s, splitPane({ paneId: rootId, direction: 'vertical', terminalId: 'tm-2' }));

    const root = s.paneTree!;
    expect(root.type).toBe('split');
    expect(root.notifyMuted).toBeUndefined(); // not stranded on the split container
    const original = root.children!.find(c => c.terminalId === 'tb-1');
    const created = root.children!.find(c => c.terminalId === 'tm-2');
    expect(original?.notifyMuted).toBe(true);
    expect(created?.notifyMuted).toBeUndefined();
  });

  it('splitPaneWithTab (thunk fulfilled) also carries pane mute to the original terminal', () => {
    let s = withActive('tb-1');
    s = reducer(s, initializePane({ terminalId: 'tb-1' }));
    const rootId = s.paneTree!.id;
    s = reducer(s, setPaneMuted({ paneId: rootId, muted: true }));
    s = reducer(s, {
      type: splitPaneWithTab.fulfilled.type,
      payload: {
        paneId: rootId,
        direction: 'vertical',
        position: 'after',
        shellType: 'default',
        newTerminalId: 'tm-2',
        uniqueTitle: 'Right',
        uniqueOriginalTitle: 'Left',
      },
    });

    const root = s.paneTree!;
    expect(root.type).toBe('split');
    expect(root.notifyMuted).toBeUndefined();
    const original = root.children!.find(c => c.terminalId === 'tb-1');
    const created = root.children!.find(c => c.terminalId === 'tm-2');
    expect(original?.notifyMuted).toBe(true);
    expect(created?.notifyMuted).toBeUndefined();
  });
});

describe('renamePanes tab scoping', () => {
  // `addTabTree` is the real action for seeding a tab's authoritative tree.
  // `setPaneTree` writes only the active-tab mirror, which would make the
  // non-active-tab case below vacuous.
  const twoTabs = () => {
    let s = reducer(init(), addTabTree({
      tabId: 'tb-alpha',
      tree: { id: 'pn-a', type: 'terminal', terminalId: 'tb-alpha', name: 'alpha' },
    }));
    s = reducer(s, addTabTree({
      tabId: 'tb-beta',
      tree: { id: 'pn-b', type: 'terminal', terminalId: 'tb-beta', name: 'beta' },
    }));
    return reducer(s, setActiveTabId('tb-alpha'));
  };

  it('renames a pane in the ACTIVE tab when tabId is omitted', () => {
    const s = reducer(twoTabs(), renamePanes({ paneId: 'pn-a', name: 'renamed' }));
    expect(s.treesByTabId['tb-alpha'].name).toBe('renamed');
  });

  // The active tab has TWO readers — `treesByTabId[activeTabId]` (authoritative)
  // and the `paneTree` mirror. Under Immer they are distinct draft paths, so a
  // write through one does not appear in the other; both must be asserted or a
  // half-applied rename passes.
  it('updates the paneTree mirror too when the target IS the active tab', () => {
    const s = reducer(twoTabs(), renamePanes({ paneId: 'pn-a', name: 'renamed' }));
    expect(s.paneTree!.name).toBe('renamed');
  });

  it('renames a pane in a NON-active tab when tabId is given', () => {
    const s = reducer(twoTabs(), renamePanes({ paneId: 'pn-b', name: 'renamed', tabId: 'tb-beta' }));
    expect(s.treesByTabId['tb-beta'].name).toBe('renamed');
    expect(s.treesByTabId['tb-alpha'].name).toBe('alpha');
  });

  it('leaves other tabs untouched', () => {
    const s = reducer(twoTabs(), renamePanes({ paneId: 'pn-a', name: 'renamed' }));
    expect(s.treesByTabId['tb-beta'].name).toBe('beta');
  });

  // A rename aimed at a background tab must not disturb the active tab's mirror.
  it('does not touch paneTree when renaming a background tab', () => {
    const s = reducer(twoTabs(), renamePanes({ paneId: 'pn-b', name: 'renamed', tabId: 'tb-beta' }));
    expect(s.paneTree!.name).toBe('alpha');
    expect(s.paneTree!.id).toBe('pn-a');
  });

  it('renames a nested leaf, not just a root leaf', () => {
    let s = reducer(init(), addTabTree({
      tabId: 'tb-split',
      tree: {
        id: 'pn-root',
        type: 'split',
        direction: 'horizontal',
        children: [leaf('pn-l', 'tb-l'), leaf('pn-r', 'tb-r')],
      },
    }));
    s = reducer(s, renamePanes({ paneId: 'pn-r', name: 'right side', tabId: 'tb-split' }));
    const children = s.treesByTabId['tb-split'].children!;
    expect(children.find(c => c.id === 'pn-r')!.name).toBe('right side');
    expect(children.find(c => c.id === 'pn-l')!.name).toBeUndefined();
  });

  it('is a no-op for an unknown tab or an unknown pane', () => {
    const before = twoTabs();
    const unknownTab = reducer(before, renamePanes({ paneId: 'pn-a', name: 'x', tabId: 'tb-nope' }));
    expect(unknownTab.treesByTabId['tb-alpha'].name).toBe('alpha');
    const unknownPane = reducer(before, renamePanes({ paneId: 'pn-nope', name: 'x' }));
    expect(unknownPane.treesByTabId['tb-alpha'].name).toBe('alpha');
  });
});

/**
 * `focusPaneInTab` exists because `focusPane` cannot express "focus a pane in a tab I am
 * not on yet", and Canvas Mode's "open in its tab" affordance needs exactly that.
 *
 * `activePaneId` belongs to whichever tab is active NOW, and `setActiveTabId` overwrites
 * it on arrival from `activePaneByTabId`. So `focusPane` either side of a tab switch is
 * clobbered: before, by that restore; after, because TerminalContainer's activation effect
 * runs a commit later and restores again. Writing the REMEMBERED pane is what survives —
 * which makes these tests about ORDER INDEPENDENCE, not about one write.
 */
describe('focusPaneInTab', () => {
  const twoPaneTab = (): PaneNode => ({
    id: 'pn-root', type: 'split', direction: 'horizontal', children: [
      leaf('pn-left', 'tm-l'), leaf('pn-right', 'tm-r'),
    ],
  });

  const seeded = () => {
    let s = reducer(init(), addTabTree({ tabId: 'tb-target', tree: twoPaneTab() }));
    s = reducer(s, addTabTree({ tabId: 'tb-here', tree: leaf('pn-here', 'tm-h') }));
    return reducer(s, setActiveTabId('tb-here'));
  };

  it('survives the tab switch that follows it', () => {
    let s = reducer(seeded(), focusPaneInTab({ tabId: 'tb-target', paneId: 'pn-right' }));
    // Still on the other tab: the ACTIVE pane must not have moved yet.
    expect(s.activePaneId).toBe('pn-here');

    s = reducer(s, setActiveTabId('tb-target'));
    expect(s.activePaneId).toBe('pn-right');
  });

  // Without this, the reducer could satisfy the case above by writing `activePaneId` and
  // getting lucky with ordering. The `firstLeafId` fallback in `setActiveTabId` would
  // otherwise land on 'pn-left' here.
  it('is what makes the difference — plain focusPane is discarded by the switch', () => {
    let s = reducer(seeded(), focusPane('pn-right'));
    s = reducer(s, setActiveTabId('tb-target'));
    expect(s.activePaneId).toBe('pn-left');
  });

  it('also moves the cursor immediately when the tab is already active', () => {
    let s = reducer(seeded(), setActiveTabId('tb-target'));
    s = reducer(s, focusPaneInTab({ tabId: 'tb-target', paneId: 'pn-right' }));
    expect(s.activePaneId).toBe('pn-right');
    expect(s.activePaneByTabId['tb-target']).toBe('pn-right');
  });

  // A canvas node can name a pane that has just been closed — the projection is a render
  // behind the store. Remembering a dead pane id would make the tab open on nothing,
  // because `setActiveTabId` only falls back when the remembered pane is absent.
  it('ignores a pane that is not in that tab', () => {
    const base = seeded();
    const unknownPane = reducer(base, focusPaneInTab({ tabId: 'tb-target', paneId: 'pn-gone' }));
    expect(unknownPane.activePaneByTabId['tb-target']).toBeUndefined();

    // ...including one that exists, but in a DIFFERENT tab.
    const wrongTab = reducer(base, focusPaneInTab({ tabId: 'tb-target', paneId: 'pn-here' }));
    expect(wrongTab.activePaneByTabId['tb-target']).toBeUndefined();

    const unknownTab = reducer(base, focusPaneInTab({ tabId: 'tb-nope', paneId: 'pn-right' }));
    expect(unknownTab.activePaneByTabId['tb-nope']).toBeUndefined();
  });
});

/**
 * Splitting a pane must carry its identity fields onto the leaf that KEEPS the
 * terminal. Found by external review of PR #49 (fabric `docs/review/169`).
 *
 * Dropping `seededForTabId` here silently undoes `planSeeds` Rule 3: split a
 * tab, drag both panes away, and nothing anywhere still names the emptied tab —
 * so the next restore manufactures it a brand-new shell. That is the
 * resurrection bug, reached by a different route.
 */
describe('splitPane carries identity fields onto the surviving leaf', () => {
  const seeded: PaneNode = {
    id: 'pn-root',
    type: 'terminal',
    terminalId: 'tm-original',
    seededForTabId: 'tb-a',
    sessionKey: 'tb-legacy01',
  };

  /**
   * **Every split entry point, not just one.** There are THREE ways a pane splits and
   * TWO implementations behind them, and the first version of this suite exercised only
   * `splitPaneInTab`. `splitPaneWithTab` — the one the pane split BUTTONS and the pane
   * context menu use, i.e. the way a user actually splits — dropped both fields, and the
   * green suite said nothing. Running one table over all three is what stops a fourth
   * entry point (or a second implementation) drifting again.
   *
   * Keep this table exhaustive: if you add a split action, add it here.
   */
  const ENTRY_POINTS: ReadonlyArray<{ name: string; action: () => unknown }> = [
    {
      // Pane split buttons / pane context menu, via services/paneActions.splitPaneById.
      name: 'splitPaneWithTab (UI split button)',
      action: () => ({
        type: splitPaneWithTab.fulfilled.type,
        payload: {
          paneId: 'pn-root',
          direction: 'horizontal',
          position: 'after',
          shellType: 'default',
          newTerminalId: 'tm-new',
          uniqueTitle: 'Bottom',
          uniqueOriginalTitle: 'Top',
        },
      }),
    },
    {
      // Keyboard shortcut (App.tsx / InputHandler).
      name: 'splitPane (keyboard shortcut)',
      action: () => splitPane({ paneId: 'pn-root', direction: 'horizontal', terminalId: 'tm-new' }),
    },
    {
      // API / MCP split (App.tsx modes 1 and 2).
      name: 'splitPaneInTab (API/MCP)',
      action: () => splitPaneInTab({ tabId: 'tb-a', paneId: 'pn-root', direction: 'horizontal' } as any),
    },
  ];

  const findByTerminal = (node: PaneNode | null, terminalId: string): PaneNode | null => {
    if (!node) return null;
    if (node.terminalId === terminalId) return node;
    for (const c of node.children ?? []) {
      const f = findByTerminal(c, terminalId);
      if (f) return f;
    }
    return null;
  };

  describe.each(ENTRY_POINTS)('$name', ({ action }) => {
    const splitIt = () => {
      let s = reducer(undefined, { type: '@@INIT' } as any);
      s = reducer(s, addTabTree({ tabId: 'tb-a', tree: seeded }));
      s = reducer(s, setActiveTabId('tb-a'));
      return reducer(s, action() as any);
    };

    /**
     * Dropping `seededForTabId` silently undoes `planSeeds` Rule 3 AND the duplicate-leaf
     * ownership tiebreak: after design 014 no leaf carries its tab's id, so this field is
     * the ONLY thing left that names a tab as its terminals' owner. Lose it on split and
     * `claimsItsOwnId` returns false for that tab forever after — the repair falls back to
     * `tabs` order, and an emptied tab is no longer recognised as emptied.
     */
    it('keeps seededForTabId on the pane that keeps the terminal', () => {
      const s = splitIt();
      const original = findByTerminal(s.treesByTabId['tb-a'], 'tm-original');
      expect(original).not.toBeNull();
      expect(original!.seededForTabId).toBe('tb-a');
    });

    /** Dropping `sessionKey` orphans a migrated pane's armed host session (design 014 §A2.1). */
    it('keeps the migrated sessionKey on the pane that keeps the terminal', () => {
      const s = splitIt();
      const original = findByTerminal(s.treesByTabId['tb-a'], 'tm-original');
      expect(original!.sessionKey).toBe('tb-legacy01');
    });

    it('does not copy either field onto the NEW sibling', () => {
      const s = splitIt();
      const tree = s.treesByTabId['tb-a']!;
      const fresh = (tree.children ?? []).find((c) => c.terminalId !== 'tm-original');
      expect(fresh).toBeDefined();
      expect(fresh!.seededForTabId).toBeUndefined();
      expect(fresh!.sessionKey).toBeUndefined();
    });
  });
});
