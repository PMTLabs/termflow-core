/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../Terminal/TerminalDisplay', () => ({ cleanupTerminalCache: jest.fn() }));
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../../NewTabDropdown', () => ({ NewTabDropdown: () => null }));
jest.mock('../../Automation/AutomationArmedBadge', () => ({ AutomationArmedForTerminals: () => null }));
jest.mock('../../Canvas/CanvasHiddenBadge', () => ({ CanvasHiddenForTerminals: () => null }));
jest.mock('../HostGenerationMarker', () => ({ PreviousHostForTerminals: () => null }));
jest.mock('../../Terminal/ShellProfileIcon', () => ({ ShellProfileIcon: () => <span title="Local profile icon" /> }));
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../../store';
import { addTab, markTabExited } from '../../../store/slices/tabsSlice';
import { addTabTree, focusPaneInTab, setMaximizedPane } from '../../../store/slices/panesSlice';
import { sshLaunchObserved, sshOwnersChanged, sshSessionObserved } from '../../../store/slices/sshSessionSlice';
import { applyView } from '../../../store/slices/sshSlice';
import { SshMetricsStatusBar } from '../../Ssh/SshMetricsStatusBar';
import type { LaunchSnapshot, SshSessionView } from '../../../types/ssh';
import { CanvasSidebar } from '../../Canvas/CanvasSidebar';
import { buildCanvasModel } from '../../Canvas/canvasSelectors';
import { TabManager } from '../TabManager';

test('SSH tab status, selected pane, and icon precedence', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as any;
  const ids = ['connected', 'connecting', 'disconnected', 'split'] as const;
  store.dispatch(applyView({ revision: 1, view: { revision: 1, folders: [], loadError: null, connections: [{
    id: 'prod', name: 'prod-web', folderId: null, host: 'example.test', port: 22, user: 'test', auth: 'agent',
    identityFile: null, jumpConnectionId: null, extraOptions: [], bookmarked: false, order: 0, lastUsedAt: null, hasSavedSecret: false,
  }] } }));
  for (const id of ids) {
    const leaf = { id: `pn-${id}`, type: 'terminal' as const, terminalId: `tm-${id}`,
      ssh: { connectionId: 'prod', followCd: false, browserCollapsed: true, hiddenMetrics: [] } };
    store.dispatch(addTab({ id, title: `Title ${id}`, icon: '🤖' }));
    store.dispatch(addTabTree({ tabId: id, tree: id === 'split' ? { id: 'pn-group', type: 'split', children: [leaf,
      { id: 'pn-local', type: 'terminal', terminalId: 'tm-local' }] } : leaf }));
  }
  store.dispatch(sshOwnersChanged(Object.fromEntries(ids.map(id => [`tm-${id}`, 'prod']))));
  const observe = (id: string, state: SshSessionView['state'], revision = 1) =>
    store.dispatch(sshSessionObserved({ terminalId: `tm-${id}`, connectionId: 'prod', state, generation: 1, revision, gate: 'verified' }));
  for (const id of ids) if (id !== 'connected') observe(id, id === 'split' ? 'connected' : id);
  let revision = 0;
  const launch = (stage: LaunchSnapshot['stage'], launchSeq = 1) => store.dispatch(sshLaunchObserved({
    terminalId: 'tm-connected', connectionId: 'prod', stage, launchSeq, revision: ++revision,
    attempt: { sessionGeneration: 1, processIncarnation: 'test', ownerIncarnation: { pg: 1, seq: 1 },
      attemptReceipt: { generation: 1, gate: 'verified' } },
  }));
  launch('preparing');
  store.dispatch(focusPaneInTab({ tabId: 'split', paneId: 'pn-split' }));
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const tab = (id: string) => container.querySelector(`[data-tab-target="${id}"]`)!;
  const metricsState = () => container.querySelector('.ssh-metrics-state')?.textContent;
  try {
    await act(async () => root.render(<Provider store={store}><div className="title-bar"><div className="title-bar-tabs"><TabManager /></div></div>
      <SshMetricsStatusBar terminalId="tm-connected" />
      <CanvasSidebar model={buildCanvasModel(store.getState())} vw={900} vh={600} onFlyToNode={jest.fn()} />
    </Provider>));
    const assertPhase = (phase: string, label: string) => {
      expect(tab('connected').querySelector(`.tab-ssh-dot.${phase}`)).not.toBeNull();
      expect(metricsState()).toContain(label);
    };
    assertPhase('connecting', 'Connecting…');
    act(() => { observe('connected', 'connecting', 1); });
    assertPhase('connecting', 'Connecting');
    act(() => { observe('connected', 'needs-hostkey', 2); });
    assertPhase('connecting', 'Waiting for host key approval');
    act(() => { observe('connected', 'needs-secret', 3); });
    assertPhase('connecting', 'Waiting for credentials');
    act(() => { launch('running'); observe('connected', 'connected', 4); });
    assertPhase('connected', 'Collecting first sample');
    const sidebar = container.querySelector('.canvas-sidebar')!;
    expect(sidebar.querySelector('.canvas-srow .tab-ssh-dot.connected')).not.toBeNull();
    for (const id of ids) {
      const status = id === 'split' ? 'connected' : id;
      expect(tab(id).querySelector(`.tab-ssh-dot.${status}`)).not.toBeNull();
      const image = tab(id).querySelector('.tab-ssh-icon[role="img"]');
      expect(image?.getAttribute('title')).toBe(`prod-web — ${status[0].toUpperCase()}${status.slice(1)}`);
      expect(image?.getAttribute('aria-label')).toBe(image?.getAttribute('title'));
      expect(tab(id).querySelector('.tab-title')?.textContent).toBe(`Title ${id}`);
      expect(tab(id).querySelector('[title="Local profile icon"]')).toBeNull();
    }
    act(() => { observe('connected', 'disconnected', 5); });
    assertPhase('disconnected', 'Disconnected');
    act(() => { launch('waiting-ready', 2); });
    assertPhase('connecting', 'Connecting…');
    for (const [index, stage] of (['error', 'cancelled', 'blocked', 'ended'] as const).entries()) {
      act(() => { observe('connected', 'connecting', 6 + index); launch(stage, 3 + index); });
      assertPhase('disconnected', stage === 'ended' ? 'SSH session ended' : 'Disconnected');
    }
    act(() => { store.dispatch(markTabExited({ tabId: 'connected', exitCode: 0 })); });
    const exitedLabel = 'prod-web — Disconnected — process exited, kept open for review';
    expect(tab('connected').querySelector('.tab-ssh-icon')?.getAttribute('title')).toBe(exitedLabel);
    expect(tab('connected').querySelector('.tab-ssh-icon')?.getAttribute('aria-label')).toBe(exitedLabel);
    expect(tab('connected').querySelector('.tab-exited-icon')).toBeNull();
    act(() => { store.dispatch(applyView({ revision: 2, view: { revision: 2, connections: [], folders: [], loadError: null } })); });
    expect(tab('split').querySelector('.tab-ssh-icon')?.getAttribute('title')).toBe('SSH connection — Connected');
    act(() => { store.dispatch(setMaximizedPane({ tabId: 'split', paneId: 'pn-local' })); });
    expect(tab('split').querySelector('.tab-ssh-icon')).toBeNull();
    act(() => { store.dispatch(setMaximizedPane({ tabId: 'split', paneId: null })); });
    expect(tab('split').querySelector('.tab-ssh-dot.connected')).not.toBeNull();
    act(() => { store.dispatch(focusPaneInTab({ tabId: 'split', paneId: 'pn-local' })); });
    expect(tab('split').querySelector('.tab-ssh-icon')).toBeNull();
    expect(tab('split').querySelector('[title="Local profile icon"]')).not.toBeNull();
    // An exited tab is gray even while its SSH session still reads connected.
    act(() => { store.dispatch(focusPaneInTab({ tabId: 'split', paneId: 'pn-split' })); });
    expect(tab('split').querySelector('.tab-ssh-dot.connected')).not.toBeNull();
    act(() => { store.dispatch(markTabExited({ tabId: 'split', exitCode: 0 })); });
    expect(tab('split').querySelector('.tab-ssh-dot.disconnected')).not.toBeNull();
    expect(tab('split').querySelector('.tab-ssh-icon')?.getAttribute('aria-label'))
      .toBe('SSH connection — Disconnected — process exited, kept open for review');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
