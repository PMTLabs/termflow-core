/** @jest-environment jsdom */
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map(), refreshGlyphAtlases: jest.fn() }));
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn().mockResolvedValue(() => {}) }));
jest.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));
jest.mock('../TitleBar', () => ({ TitleBar: () => null }));
jest.mock('../TerminalContainer', () => ({ TerminalContainer: () => null, clearTabPanes: jest.fn() }));
jest.mock('../Panes/dnd/PaneDragController', () => ({ PaneDragProvider: ({ children }: any) => children }));
jest.mock('../LayoutManager', () => ({ LayoutManager: () => null }));
jest.mock('../UI/GlobalDialog', () => ({ GlobalDialog: () => null }));
jest.mock('../UI/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
jest.mock('../UI/ToastContainer', () => ({ ToastContainer: () => null }));
jest.mock('../GlobalPeerRequests', () => ({ GlobalPeerRequests: () => null }));
jest.mock('../EulaAcceptModal', () => ({ EulaAcceptModal: () => null }));
jest.mock('../Automation/GlobalAutomationEditor', () => ({ GlobalAutomationEditor: () => null }));
jest.mock('../../services/RunningActivityTracker', () => ({ runningActivityTracker: { start: jest.fn(), stop: jest.fn() } }));
jest.mock('../../services/NotificationService', () => ({ notificationService: { start: jest.fn(), stop: jest.fn() } }));
jest.mock('../../services/AgentSchemeTracker', () => ({ agentSchemeTracker: { start: jest.fn(), stop: jest.fn(), getAgentForTerminal: () => null } }));
jest.mock('../../store/terminalTheme', () => ({ applyEffectiveThemes: jest.fn(), applyActivePaneBackground: jest.fn() }));
jest.mock('../../services/InputHandler', () => ({ inputHandler: { enable: jest.fn(), destroy: jest.fn() } }));
jest.mock('../../services/commandHistoryService', () => ({ commandHistoryService: { hydrate: jest.fn().mockResolvedValue(undefined) } }));
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import App from '../../App';
import { store } from '../../store';
import { addTab, clearAllTabs } from '../../store/slices/tabsSlice';
import { addTabTree, resetPanes, splitPaneInTab } from '../../store/slices/panesSlice';
import { PaneIncarnations, installPaneIncarnations, describePanes, type PaneBridge } from '../../services/paneIncarnations';
import { terminalService } from '../../services/TerminalService';
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
test.each([1, 2])('mounted API mode %s reports its installed pane rather than a concurrent sibling', async mode => {
  jest.useFakeTimers(); localStorage.clear(); store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
  const client = new PaneIncarnations((async (command: string) => command === 'register_page' ? { status: 'Registered', wi: 4, pg: 44 } : { status: 'Ack', result: { status: 'Ok' } }) as PaneBridge);
  installPaneIncarnations(client); client.attachStore(store);
  store.dispatch(addTab({ id: 'tb-subject', title: 'Subject' }));
  store.dispatch(addTabTree({ tabId: 'tb-subject', tree: { id: 'split', type: 'split', direction: 'vertical', children: [
    { id: 'pn-source', type: 'terminal', terminalId: 'tm-source' }, { id: 'pn-other', type: 'terminal', terminalId: 'tm-other' },
  ] } }));
  const response = jest.fn();
  (window as any).terminalService = terminalService;
  (window as any).electronAPI = { getConfig: jest.fn().mockResolvedValue({ restoreLastSession: false }), getShellProfiles: jest.fn().mockResolvedValue([{ id: 'default', name: 'Default' }]), getDefaultProfile: jest.fn().mockResolvedValue('default'), sendToMain: response, adoptConsoleWindow: jest.fn().mockResolvedValue(undefined) };
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => { root.render(<Provider store={store}><App /></Provider>); await flush(); });
    await act(async () => { window.dispatchEvent(new CustomEvent('api:createTerminalTab', { detail: { processId: 'pc-api-subject', rendererTerminalId: 'tm-api-subject', owningTabId: 'tb-subject', ...(mode === 1 ? { paneId: 'pn-source' } : {}) } })); await flush(); });
    const installed = describePanes(store.getState().panes.treesByTabId['tb-subject']).find(pane => pane.leaf === 'tm-api-subject')!;
    expect(installed).toBeDefined();
    expect(terminalService.getProcessId('tm-api-subject')).toBe('pc-api-subject');
    expect(response).not.toHaveBeenCalled();
    act(() => store.dispatch(splitPaneInTab({ tabId: 'tb-subject', paneId: 'pn-other', direction: 'horizontal', terminalId: 'tm-sibling' })));
    terminalService.registerExistingTerminal('tm-sibling', 'pc-sibling');
    expect(describePanes(store.getState().panes.treesByTabId['tb-subject']).map(pane => pane.leaf)).toEqual(['tm-source', 'tm-api-subject', 'tm-other', 'tm-sibling']);
    await act(async () => { await jest.advanceTimersByTimeAsync(1100); await flush(); });
    expect(response).toHaveBeenCalledTimes(1);
    expect(response).toHaveBeenCalledWith('api:terminalTabCreated', expect.objectContaining({ success: true, tabId: 'tb-subject', paneId: installed.paneId, terminalId: 'tm-api-subject', processId: 'pc-api-subject' }));
    expect(terminalService.getProcessId('tm-sibling')).toBe('pc-sibling');
  } finally {
    await act(async () => { root.unmount(); client.stop(); }); container.remove(); installPaneIncarnations(new PaneIncarnations());
    terminalService.detachTerminal('tm-api-subject'); terminalService.detachTerminal('tm-sibling'); delete (window as any).electronAPI; delete (window as any).terminalService;
    await jest.advanceTimersByTimeAsync(0); jest.useRealTimers();
  }
});
