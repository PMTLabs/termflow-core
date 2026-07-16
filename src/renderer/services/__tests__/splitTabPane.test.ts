/**
 * @jest-environment jsdom
 *
 * Spec 045 §3.2 + §3.6: the tab-header menu must open panes in the same four
 * directions as the pane-header menu, with the same direction→position mapping,
 * and must inherit the source pane's cwd even for a BACKGROUND tab.
 *
 * splitPaneWithTab is a createAsyncThunk, so it is mocked down to a plain action
 * creator here — dispatching the real thunk through a bare jest.fn() captures a
 * function, not an inspectable action.
 */
const dispatch = jest.fn();
const mockState: any = {};
jest.mock('../../store', () => ({ store: { getState: () => mockState, dispatch: (a: unknown) => dispatch(a) } }));
jest.mock('../../store/slices/panesSlice', () => ({
  splitPaneWithTab: (payload: unknown) => ({ type: 'panes/splitPaneWithTab', payload }),
}));
jest.mock('../../store/slices/tabsSlice', () => ({ addTab: (p: unknown) => ({ type: 'tabs/addTab', payload: p }) }));

const getTerminalCwd = jest.fn();
jest.mock('../TerminalService', () => ({
  terminalService: { getProcessId: (id: string) => (id === 'tm-bg' ? 'proc-bg' : undefined) },
}));

import { splitTabPane } from '../paneActions';

const BG_TREE = { id: 'p-bg', type: 'terminal', terminalId: 'tm-bg' };
const ACTIVE_TREE = { id: 'p-active', type: 'terminal', terminalId: 'tm-active' };

beforeEach(() => {
  jest.clearAllMocks();
  (window as any).electronAPI = { getTerminalCwd };
  getTerminalCwd.mockResolvedValue('D:\\from-background-tab');
  mockState.settings = { defaultProfile: 'pwsh', shellProfiles: [{ id: 'pwsh', name: 'PowerShell' }] };
  mockState.tabs = { tabs: [] };
  // 'tb-bg' is a BACKGROUND tab: panes.paneTree mirrors the ACTIVE tab only.
  mockState.panes = {
    treesByTabId: { 'tb-bg': BG_TREE, 'tb-active': ACTIVE_TREE },
    paneTree: ACTIVE_TREE,
    activePaneId: 'p-active',
  };
});

/** The splitPaneWithTab payload dispatched by splitTabPane (it is async). */
async function dispatchedSplit(): Promise<any> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const call = dispatch.mock.calls.find(([a]) => a?.type === 'panes/splitPaneWithTab');
  return call?.[0]?.payload;
}

describe('splitTabPane direction/position (spec 045 §3.2)', () => {
  it('opens a pane to the RIGHT (vertical/after)', async () => {
    splitTabPane('tb-active', 'vertical', 'after');
    expect(await dispatchedSplit()).toMatchObject({ paneId: 'p-active', direction: 'vertical', position: 'after' });
  });

  it('opens a pane to the LEFT (vertical/before)', async () => {
    splitTabPane('tb-active', 'vertical', 'before');
    expect(await dispatchedSplit()).toMatchObject({ paneId: 'p-active', direction: 'vertical', position: 'before' });
  });

  it('opens a pane UP (horizontal/before)', async () => {
    splitTabPane('tb-active', 'horizontal', 'before');
    expect(await dispatchedSplit()).toMatchObject({ paneId: 'p-active', direction: 'horizontal', position: 'before' });
  });

  it('opens a pane DOWN (horizontal/after)', async () => {
    splitTabPane('tb-active', 'horizontal', 'after');
    expect(await dispatchedSplit()).toMatchObject({ paneId: 'p-active', direction: 'horizontal', position: 'after' });
  });

  it('defaults to "after" so the existing caller is unchanged', async () => {
    splitTabPane('tb-active', 'vertical');
    expect(await dispatchedSplit()).toMatchObject({ position: 'after' });
  });

  it('does nothing for a tab with no panes', async () => {
    splitTabPane('tb-missing', 'vertical', 'after');
    expect(await dispatchedSplit()).toBeUndefined();
  });
});

describe('splitTabPane background-tab cwd (spec 045 §3.6)', () => {
  it('inherits the source pane cwd from a BACKGROUND tab, not the active mirror', async () => {
    splitTabPane('tb-bg', 'vertical', 'after');
    const payload = await dispatchedSplit();
    // Falls back to the tab's first leaf (activePaneId belongs to another tab).
    expect(payload).toMatchObject({ paneId: 'p-bg', direction: 'vertical', position: 'after' });
    // The regression this pins: resolving via panes.paneTree (active mirror)
    // finds nothing for a background pane, so cwd silently came back undefined.
    expect(getTerminalCwd).toHaveBeenCalledWith('proc-bg');
    expect(payload.cwd).toBe('D:\\from-background-tab');
  });
});
