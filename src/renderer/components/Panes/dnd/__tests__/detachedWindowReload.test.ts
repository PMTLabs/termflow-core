/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
import { store } from '../../../../store';
import { clearAllTabs } from '../../../../store/slices/tabsSlice';
import { resetPanes } from '../../../../store/slices/panesSlice';
import { PaneIncarnations, installPaneIncarnations, type PaneBridge, type PaneRequest } from '../../../../services/paneIncarnations';
import { reconstructDetachedWindow } from '../detach';

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function install(takeResult: unknown) {
  const requests: PaneRequest[] = [];
  const client = new PaneIncarnations((async (name: string, args: any) => {
    if (name === 'register_page') return { status: 'Registered', wi: 7, pg: 81 };
    requests.push(args.request);
    return { status: 'Ack', result: args.request.op.kind === 'take' ? takeResult : { status: 'Ok' } };
  }) as PaneBridge);
  installPaneIncarnations(client);
  (window as any).electronAPI = { getWindowLabel: () => 'detach-spent-token' };
  return { client, requests };
}

beforeEach(() => { store.dispatch(clearAllTabs()); store.dispatch(resetPanes()); });
afterEach(() => {
  installPaneIncarnations(new PaneIncarnations());
  delete (window as any).electronAPI;
  store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
});

test('a reloaded detached window whose transfer token is spent falls back to its own session restore', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { client, requests } = install({ status: 'Rejected', message: 'transfer has ended' });
  client.attachStore(store);
  try {
    const result = reconstructDetachedWindow();
    await flush();
    expect(requests.map(request => request.op.kind)).toEqual(['take']);
    await expect(result).resolves.toBe(false);
    expect(store.getState().tabs.tabs).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('Detach: no transfer to take', 'transfer take Rejected');
  } finally {
    client.stop();
    warn.mockRestore();
  }
});

test('a take that fails for any other reason after adoption began is not swallowed', async () => {
  // A malformed UI payload throws after the take succeeded: the caller must see it, not restore over it.
  const { client } = install({ status: 'Taken', payload: { panes: [], ui: undefined } });
  client.attachStore(store);
  try {
    const result = reconstructDetachedWindow().catch(error => (error as Error).message);
    await flush();
    await expect(result).resolves.toBe('transfer has no UI payload');
  } finally {
    client.stop();
  }
});
