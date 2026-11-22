/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
import { store } from '../../../../store';
import { addTab, clearAllTabs } from '../../../../store/slices/tabsSlice';
import { addTabTree, resetPanes } from '../../../../store/slices/panesSlice';
import { PaneIncarnations, describePanes, installPaneIncarnations, type PaneBridge, type PaneRequest } from '../../../../services/paneIncarnations';
import { terminalService } from '../../../../services/TerminalService';
import { applyCrossWindowPayload, applyReattachByToken, reconstructDetachedWindow } from '../detach';
import type { DetachPayload } from '../types';
import { expectPaneTags, pane, sentinel, taggedTree, tags } from '../../../../__testFixtures__/sshPaneCensus';

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

test.each(['token new tab', 'token pane drop', 'detached boot'] as const)(
  'all_reattach_destinations_preserve_tag_without_retyping (%s)', async destination => {
    const isDrop = destination === 'token pane drop';
    const tree = isDrop ? pane('ssh', sentinel) : taggedTree();
    const descriptors = describePanes(tree);
    const payload: DetachPayload = {
      kind: isDrop ? 'pane' : 'tab', tabId: 'tb-moved', tabTitle: 'Moved', paneTree: tree,
      terminals: descriptors.map(({ leaf }) => ({ terminalId: leaf, processId: 'pc-' + leaf, promptGate: null })),
    };
    const { client, requests } = install({ status: 'Taken', payload: {
      panes: descriptors, ui: JSON.parse(JSON.stringify(payload)),
    } });
    client.attachStore(store);
    const detect = document.elementFromPoint;
    const destinationDom = document.createElement('div');
    const attach = jest.spyOn(terminalService, 'attachExistingTerminal');
    const create = jest.spyOn(terminalService, 'createTerminal');
    try {
      if (isDrop) {
        destinationDom.setAttribute('data-tab-id', 'tb-target');
        destinationDom.innerHTML = '<div data-pane-id="pn-local"></div>';
        const target = destinationDom.firstElementChild!;
        jest.spyOn(target, 'getBoundingClientRect').mockReturnValue({
          left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {},
        });
        document.elementFromPoint = () => target;
        document.body.appendChild(destinationDom);
        store.dispatch(addTabTree({ tabId: 'tb-target', tree: taggedTree().children![1] }));
        store.dispatch(addTab({ id: 'tb-target', title: 'Target', shellType: 'default', icon: '' }));
      }

      if (isDrop) await applyCrossWindowPayload(payload, 99, 50, 'move');
      else if (destination === 'detached boot') expect(await reconstructDetachedWindow()).toBe(true);
      else await applyReattachByToken('move');

      const trees = store.getState().panes.treesByTabId;
      expectPaneTags(Object.values(trees), tags, ['tm-local']);
      expect(Object.keys(trees)).toEqual([isDrop ? 'tb-target' : 'tb-moved']);
      expect(attach.mock.calls.map(([id, pc]) => [id, pc])).toEqual(descriptors.map(({ leaf }) => [leaf, 'pc-' + leaf]));
      expect(requests.filter(request => request.op.kind === 'adopt')).toHaveLength(1);
      expect(requests.filter(request => request.op.kind === 'bind')).toHaveLength(descriptors.length);
      expect(create).not.toHaveBeenCalled();
    } finally {
      destinationDom.remove();
      document.elementFromPoint = detect;
      for (const { leaf } of descriptors) terminalService.detachTerminal(leaf);
      attach.mockRestore();
      create.mockRestore();
    }
  },
);

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
