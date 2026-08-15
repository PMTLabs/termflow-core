import { resolveActivityTabId } from '../externalActivity';

// A tab with a root pane and one split leaf.
const trees = {
  'tb-4e8d0c2f1': {
    id: 'pn-root',
    type: 'split' as const,
    direction: 'vertical' as const,
    children: [
      { id: 'pn-a', type: 'terminal' as const, terminalId: 'tb-4e8d0c2f1' },
      { id: 'pn-b', type: 'terminal' as const, terminalId: 'tm-9f2c1a4b7' },
    ],
  },
} as any;
const knownTabIds = new Set(['tb-4e8d0c2f1']);

describe('resolveActivityTabId', () => {
  // The whole point of P0-A's activity fix.
  it('uses owningTabId when the backend supplies one', () => {
    expect(
      resolveActivityTabId(
        { owningTabId: 'tb-4e8d0c2f1', rendererTerminalId: 'tm-9f2c1a4b7' },
        trees,
        knownTabIds,
      ),
    ).toBe('tb-4e8d0c2f1');
  });

  // Correction C4: App.tsx:672-681 did `detail.tabId ?? null` and only fell back
  // when that was falsy. For a split the backend sent a TRUTHY `tm-` leaf, so
  // the fallback never ran and `flagTabActivity` silently no-opped against
  // `state.tabs`, which holds only root tab ids.
  it('never returns a leaf id that no tab owns', () => {
    expect(
      resolveActivityTabId({ tabId: 'tm-9f2c1a4b7' }, trees, knownTabIds),
    ).toBe('tb-4e8d0c2f1');
  });

  it('walks the pane tree when only a renderer leaf is available', () => {
    expect(
      resolveActivityTabId({ rendererTerminalId: 'tm-9f2c1a4b7' }, trees, knownTabIds),
    ).toBe('tb-4e8d0c2f1');
  });

  it('accepts a legacy tabId that IS a real tab', () => {
    expect(
      resolveActivityTabId({ tabId: 'tb-4e8d0c2f1' }, trees, knownTabIds),
    ).toBe('tb-4e8d0c2f1');
  });

  // Correction C4, second half: on the in-process path `terminalId` is the
  // PROCESS id, which matches no pane-tree leaf — so it must never be treated
  // as one.
  it('does not mistake a process id for a leaf', () => {
    expect(
      resolveActivityTabId({ terminalId: 'pc-abc123def' }, trees, knownTabIds),
    ).toBeNull();
  });

  it('returns null rather than guessing when nothing resolves', () => {
    expect(resolveActivityTabId({}, trees, knownTabIds)).toBeNull();
    expect(
      resolveActivityTabId({ owningTabId: 'tb-closed99' }, trees, knownTabIds),
    ).toBeNull();
  });
});
