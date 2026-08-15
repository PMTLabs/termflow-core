import { groupLiveTerminalsByLeaf } from '../reconcileTerminals';

const wanted = new Set(['tb-4e8d0c2f1', 'tm-9f2c1a4b7']);

describe('groupLiveTerminalsByLeaf', () => {
  // THE REAPING REGRESSION (design 011 §7 test 6). Two API splits in one tab
  // used to arrive with the SAME `tabId`, so reconcile grouped them together,
  // kept the newest by createdAt and CLOSED the other — killing a live PTY.
  // Correlating on the leaf keeps both.
  it('keeps two splits that share an owning tab', () => {
    const groups = groupLiveTerminalsByLeaf(
      [
        { id: 'pc-aaa', terminalId: 'tb-4e8d0c2f1', owningTabId: 'tb-4e8d0c2f1', createdAt: '2026-08-14T10:00:00Z' },
        { id: 'pc-bbb', terminalId: 'tm-9f2c1a4b7', owningTabId: 'tb-4e8d0c2f1', createdAt: '2026-08-14T10:00:01Z' },
      ],
      wanted,
    );
    expect(groups.size).toBe(2);
    expect(groups.get('tb-4e8d0c2f1')!.map(t => t.processId)).toEqual(['pc-aaa']);
    expect(groups.get('tm-9f2c1a4b7')!.map(t => t.processId)).toEqual(['pc-bbb']);
  });

  // Genuine duplicates — a reload that failed to reattach leaves several PTYs on
  // ONE leaf. Those must still group so the older ones are reaped.
  it('still groups genuine duplicates of one leaf, newest first', () => {
    const groups = groupLiveTerminalsByLeaf(
      [
        { id: 'pc-old', terminalId: 'tb-4e8d0c2f1', createdAt: '2026-08-14T10:00:00Z' },
        { id: 'pc-new', terminalId: 'tb-4e8d0c2f1', createdAt: '2026-08-14T11:00:00Z' },
      ],
      wanted,
    );
    expect(groups.get('tb-4e8d0c2f1')!.map(t => t.processId)).toEqual(['pc-new', 'pc-old']);
  });

  it('ignores terminals the restore is not about to recreate', () => {
    const groups = groupLiveTerminalsByLeaf(
      [{ id: 'pc-other', terminalId: 'tb-someoneelse', createdAt: '' }],
      wanted,
    );
    expect(groups.size).toBe(0);
  });

  // A headless API/fleet PTY now reports `terminalId: null` (correction C1).
  it('skips a terminal with no renderer identity', () => {
    const groups = groupLiveTerminalsByLeaf(
      [{ id: 'pc-headless', terminalId: null, owningTabId: null, createdAt: '' }],
      wanted,
    );
    expect(groups.size).toBe(0);
  });

  it('accepts processId when id is absent, and carries promptHook through', () => {
    const groups = groupLiveTerminalsByLeaf(
      [{ processId: 'pc-ccc', terminalId: 'tb-4e8d0c2f1', createdAt: '', promptHook: true }],
      wanted,
    );
    expect(groups.get('tb-4e8d0c2f1')![0]).toMatchObject({ processId: 'pc-ccc', promptHook: true });
  });
});
