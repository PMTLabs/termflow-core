/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../../store';
import { addTab, setActiveTab } from '../../../store/slices/tabsSlice';
import { buildApiFallbackPane, runApiCreateMode0 } from '../../../services/apiCreatedTab';
import { addTabRootedAt } from '../../../services/folderTab';
import { fetchLiveTerminalRows } from '../../../services/hiddenAgentTerminals';
import { restoreHiddenAgentTerminals } from '../../../services/restoreHiddenAgentTerminals';
import { addTabTree, initializePane, resetPanes, setActiveTabId, setPaneTree, splitPane, splitPaneInTab, splitPaneWithTab, type PaneNode } from '../../../store/slices/panesSlice';
import { sshOwnersChanged, sshSessionObserved } from '../../../store/slices/sshSessionSlice';
import { installSshMetricsWatch } from '../../../services/sshMetricsWatch';
import { planSeeds } from '../../../services/tabTreeSeed';
import { sanitizePaneTreeSshFields } from '../../../services/sshPanePersistence';
import { pane, sentinel } from '../../../__testFixtures__/sshPaneCensus';
import { PaneManager } from '../PaneManager';
import { planCanvasSpawn } from '../../Canvas/canvasSpawn';

jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map(), isBroadcastAvailable: () => true }));
jest.mock('../../../services/paneOwnership', () => ({ attachPaneOwnershipSync: jest.fn() }));
jest.mock('../../../services/terminalLabelSync', () => ({ attachTerminalLabelSync: jest.fn() }));
jest.mock('../../../services/terminalTitleColorSync', () => ({ attachTerminalTitleColorSync: jest.fn() }));
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn().mockResolvedValue(() => {}) }));
jest.mock('../../Terminal/TerminalDisplay', () => ({ TerminalDisplay: ({ isActive }: { isActive: boolean }) => <div data-engine-active={String(isActive)} /> }));
jest.mock('../dnd/usePaneDrag', () => ({ usePaneDrag: () => () => {} }));
jest.mock('../../../services/hiddenAgentTerminals', () => ({
  ...jest.requireActual('../../../services/hiddenAgentTerminals'), fetchLiveTerminalRows: jest.fn(),
}));
jest.mock('../../../services/TerminalService', () => ({ terminalService: {
  attachExistingTerminal: jest.fn(), markReattachedSession: jest.fn(),
  getProcessId: () => 'pc-1', createTerminal: jest.fn(), writeToTerminal: jest.fn().mockResolvedValue(undefined),
  resizeTerminal: jest.fn().mockResolvedValue(undefined), stashPromptGate: jest.fn(),
} }));
jest.mock('../../../services/AgentSchemeTracker', () => ({ agentSchemeTracker: {
  getAgentForTerminal: () => null, getDetectedAgentForTerminal: () => null,
  getDetectedAgentExeForTerminal: () => null, refreshNow: () => Promise.resolve(), subscribe: () => () => {},
} }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

const leaves = (node: PaneNode | null | undefined): PaneNode[] =>
  !node ? [] : node.type === 'terminal' ? [node] : (node.children ?? []).flatMap(leaves);
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

test('local_split_never_mounts_metrics_or_watches', async () => {
  const st = store.dispatch;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const watch = jest.fn(async (_terminalId: string) => ({
    generation: 1, sampleFloor: Date.now(), pauseSeq: 0, pausedReason: null,
  }));
  const dispose = installSshMetricsWatch(store, {
    sshMetricsWatch: watch, sshMetricsUnwatch: async () => {},
    sshMetricsResume: async () => { throw Error('unexpected resume'); },
    onSshMetricsControl: async () => () => {}, onSshMetricsSample: async () => () => {},
  }, { ended: false, pageIdentity: async () => ({ wi: 1, pg: 2 }), subscribe: () => () => {} });
  try {
    st(resetPanes());
    const factories = ['split', 'split-in-tab', 'before', 'after'] as const;
    for (const factory of factories) {
      const tabId = `tb-${factory}`, paneId = `pn-ssh-${factory}`, terminalId = `tm-local-${factory}`;
      st(setActiveTabId(tabId));
      st(setPaneTree(pane(`ssh-${factory}`, sentinel)));
      const args = { paneId, direction: 'horizontal' as const, terminalId };
      if (factory === 'split') st(splitPane(args));
      else if (factory === 'split-in-tab') st(splitPaneInTab({ ...args, tabId }));
      else st({ type: splitPaneWithTab.fulfilled.type, payload: {
        ...args, position: factory, newTerminalId: terminalId, shellType: 'default',
        uniqueTitle: factory, uniqueOriginalTitle: 'ssh',
      } });
    }
    st(setActiveTabId('tb-initialize'));
    st(initializePane({ terminalId: 'tm-initial' }));
    st(addTabTree({ tabId: 'tb-null', tree: null }));
    st(splitPaneInTab({ tabId: 'tb-null', paneId: '', direction: 'vertical', terminalId: 'tm-null' }));
    const [seed] = planSeeds([{ id: 'tb-seed', shellType: 'default' }], store.getState().panes.treesByTabId, {});
    st(addTabTree(seed));
    st(addTabTree({ tabId: 'tb-restored', tree: sanitizePaneTreeSshFields(JSON.parse(JSON.stringify(pane('restored')))) }));
    const canvas = planCanvasSpawn({ id: 'default', name: 'Terminal' }, [], { x: 0, y: 0, w: 400, h: 300 });
    st(addTabTree({ tabId: canvas.tab.id, tree: canvas.tree }));
    st(addTabTree({ tabId: 'tb-api-fallback', tree: buildApiFallbackPane('pn-api-fallback', 'tb-api-fallback', 'API', 'default') }));
    runApiCreateMode0({ processId: 'pc-api', rendererTerminalId: 'tm-api' }, {
      dispatch: st, generateId: prefix => `${prefix}-api-mode0`, defaultProfile: 'default',
      registerExistingTerminal: jest.fn(), tabPanes: {}, tabExists: () => false,
      activateOnApiCreate: false, tabCount: 1, addTab, addTabTree, setActiveTab, setActiveTabId,
      titleColorForTerminal: () => undefined,
    });
    addTabRootedAt(st, { id: 'tb-folder', title: 'Folder', shellType: 'default' }, '/work');
    const agent = { terminalId: 'tm-agent', processId: 'pc-agent', agent: 'claude', name: 'Agent' };
    jest.mocked(fetchLiveTerminalRows).mockResolvedValue({
      processes: [{ id: 'pc-agent', agent: 'claude', name: 'Agent' }],
      identities: [{ id: 'pc-agent', processId: 'pc-agent', terminalId: 'tm-agent' }],
    });
    expect((await restoreHiddenAgentTerminals([agent], st)).restored).toEqual([agent]);
    const trees = Object.entries(store.getState().panes.treesByTabId);
    const nodes = trees.flatMap(([, tree]) => leaves(tree));
    const tagged = factories.map(factory => `tm-ssh-${factory}`).sort();
    expect(nodes).toHaveLength(17);
    expect(nodes.filter(n => n.ssh).map(n => n.terminalId).sort()).toEqual(tagged);
    // Even an erroneously populated session slice is not permission to watch
    // an untagged leaf. Only the tree's SSH tag can opt in.
    st(sshOwnersChanged(Object.fromEntries(nodes.map(n => [n.terminalId!, n.ssh?.connectionId ?? 'noise']))));
    for (const n of nodes) st(sshSessionObserved({
      terminalId: n.terminalId, connectionId: n.ssh?.connectionId ?? 'noise',
      generation: 1, revision: 1, gate: 'verified', state: 'connected',
    }));
    const maximizedLocalId = nodes.find(n => n.terminalId === 'tm-local-split')!.id;
    const render = (isTabActive: boolean, maximizedPaneId?: string) => root.render(<Provider store={store}>
      {trees.map(([tabId, paneTree]) => <PaneManager key={tabId} tabId={tabId} paneTree={paneTree}
        activePaneId={null} isTabActive={isTabActive} maximizedPaneId={tabId === 'tb-split' ? maximizedPaneId : undefined} />)}
    </Provider>);
    await act(async () => { render(false); await flush(); });
    await act(flush);
    const bars = container.querySelectorAll('[aria-label="Remote host metrics"]');
    expect(bars).toHaveLength(tagged.length);
    const column = bars[0].closest('.terminal-pane')!;
    expect(bars[0].parentElement).toBe(column);
    expect(column.querySelector('.terminal-pane-body > .terminal-pane-content [data-engine-active="false"]')).not.toBeNull();
    expect(watch.mock.calls.map(([id]) => id).sort()).toEqual(tagged);
    await act(async () => { render(true, maximizedLocalId); await flush(); });
    expect(column.querySelector('[data-engine-active="false"]')).not.toBeNull();
    expect(container.querySelector(`[data-pane-id="${maximizedLocalId}"] [data-engine-active="true"]`)).not.toBeNull();
    await act(async () => { render(true); await flush(); });
    expect(column.querySelector('[data-engine-active="true"]')).not.toBeNull();
    expect(watch).toHaveBeenCalledTimes(tagged.length);
  } finally {
    await act(async () => { root.unmount(); dispose(); await flush(); });
    hidden.mockRestore();
    container.remove();
  }
});
