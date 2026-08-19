/**
 * @jest-environment jsdom
 *
 * The one rename chain, shared by the tab strip and Canvas Mode.
 *
 * Renaming a tab has always been three things, not one — the store title, the backend name of
 * every live leaf process, and a save so it survives a restart — and until now all three lived
 * inline in `TabManager.handleEditTitle`. Canvas Mode renames the same tabs (a group IS a tab),
 * so a second copy of that chain is a second chance to forget one of the three. The half that
 * was already forgotten is visible in `CanvasSidebar`: renaming a solo terminal dispatched
 * `updateTabTitle` and never touched the backend, so the tab strip and the process name
 * disagreed until the next restart.
 *
 * `renameTabProcesses` is exercised for real here, not mocked: the whole point of the service
 * is that the backend half actually runs, and a mocked one would pass with it deleted.
 */
jest.mock('../TerminalService', () => ({
  terminalService: { getProcessIdForTerminal: jest.fn() },
}));
jest.mock('../StateManager', () => ({
  StateManager: { saveState: jest.fn().mockResolvedValue(undefined) },
}));

import tabsReducer, { addTab, setAutoTabTitle } from '../../store/slices/tabsSlice';
import type { PaneNode } from '../../store/slices/panesSlice';

type TabsState = ReturnType<typeof tabsReducer>;
let tabs: TabsState = tabsReducer(undefined, { type: '@@init' });
let trees: Record<string, PaneNode> = {};

const dispatch = jest.fn((action: { type: string; payload?: unknown }) => {
  tabs = tabsReducer(tabs, action as never);
  return action;
});

jest.mock('../../store', () => ({
  store: {
    getState: () => ({ tabs, panes: { treesByTabId: trees } }),
    dispatch: (a: never) => dispatch(a),
  },
}));

// eslint-disable-next-line import/first
import { renameTab } from '../renameTab';
// eslint-disable-next-line import/first
import { terminalService } from '../TerminalService';
// eslint-disable-next-line import/first
import { StateManager } from '../StateManager';

const leaf = (id: string, terminalId: string): PaneNode => ({ id, type: 'terminal', terminalId });
const split = (id: string, a: PaneNode, b: PaneNode): PaneNode =>
  ({ id, type: 'split', direction: 'horizontal', size: 50, children: [a, b] });

const titleOf = (id: string) => tabs.tabs.find((t) => t.id === id)?.title;
const tabAt = (id: string) => tabs.tabs.find((t) => t.id === id);

let updateTerminalName: jest.Mock;

beforeEach(() => {
  tabs = tabsReducer(undefined, { type: '@@init' });
  tabs = tabsReducer(tabs, addTab({ id: 'tb-a', title: 'api', shellType: 'bash' } as never));
  trees = { 'tb-a': split('pn-1', leaf('pn-2', 'tm-1'), leaf('pn-3', 'tm-2')) };

  dispatch.mockClear();
  (terminalService.getProcessIdForTerminal as jest.Mock).mockReset();
  (terminalService.getProcessIdForTerminal as jest.Mock).mockImplementation(
    (terminalId: string) => `proc-${terminalId}`,
  );
  (StateManager.saveState as jest.Mock).mockClear();

  updateTerminalName = jest.fn().mockResolvedValue(true);
  (window as unknown as { electronAPI: unknown }).electronAPI = { updateTerminalName };
});

describe('renameTab', () => {
  it('puts the new title on the tab', async () => {
    await renameTab('tb-a', 'gateway');
    expect(titleOf('tb-a')).toBe('gateway');
  });

  /**
   * The reason `updateTabTitle` is the right action and a hand-rolled title write is not.
   * `cmd.exe` announces its own path as an OSC title a frame after opening, so without the
   * custom flag a tab you just named renames itself back out from under you.
   */
  it('pins the title against the shell\'s own OSC auto-title', async () => {
    await renameTab('tb-a', 'gateway');
    tabs = tabsReducer(tabs, setAutoTabTitle({ id: 'tb-a', title: 'C:\\WINDOWS\\system32\\cmd.exe' }));

    expect(tabAt('tb-a')?.titleIsCustom).toBe(true);
    expect(titleOf('tb-a')).toBe('gateway');
  });

  /** A tab title is tab-level, so a SPLIT tab renames all of its panes — the bug re-review 111
   *  found in the tab strip, which any second copy of this chain would reintroduce. */
  it('names every live leaf process of a split tab', async () => {
    await renameTab('tb-a', 'gateway');

    expect(updateTerminalName.mock.calls).toEqual([
      ['proc-tm-1', 'gateway'],
      ['proc-tm-2', 'gateway'],
    ]);
  });

  it('saves state so the rename survives a restart', async () => {
    await renameTab('tb-a', 'gateway');
    expect(StateManager.saveState).toHaveBeenCalledTimes(1);
  });

  /** The store keeps the trimmed title, so the backend must be given the same string — two
   *  spellings of one name is how the tab strip and the process list drift apart. */
  it('trims the title once, for the store and the backend alike', async () => {
    await renameTab('tb-a', '  gateway  ');

    expect(titleOf('tb-a')).toBe('gateway');
    expect(updateTerminalName).toHaveBeenCalledWith('proc-tm-1', 'gateway');
  });

  /**
   * An empty name is a cancel, not a rename to "". Every caller here commits on blur, so this
   * is reached by clearing the box and clicking away — and a tab called "" is unclickable in
   * the strip and invisible as a canvas group label.
   */
  it('refuses a blank title entirely', async () => {
    await renameTab('tb-a', '   ');

    expect(titleOf('tb-a')).toBe('api');
    expect(updateTerminalName).not.toHaveBeenCalled();
    expect(StateManager.saveState).not.toHaveBeenCalled();
  });

  /** A tab with no tree at all still has a process under its own id — `tabLeafIds`' fallback.
   *  Dropping it would make rename a silent no-op for a tab whose pane tree has not seeded. */
  it('still names the process of a tab that has no pane tree', async () => {
    trees = {};
    await renameTab('tb-a', 'gateway');

    expect(updateTerminalName).toHaveBeenCalledWith('proc-tb-a', 'gateway');
  });
});
