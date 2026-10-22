/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../../store';
import { addTab, setActiveTab } from '../../../store/slices/tabsSlice';
import { addTabTree } from '../../../store/slices/panesSlice';
import { setNonFocusedPaneOpacity } from '../../../store/slices/settingsSlice';
import { startTabBroadcast, startWindowBroadcast, stopBroadcast } from '../../../store/slices/broadcastSlice';
import { TerminalPane } from '../TerminalPane';

jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map(), isBroadcastAvailable: () => true }));
jest.mock('../../../services/paneOwnership', () => ({ attachPaneOwnershipSync: jest.fn() }));
jest.mock('../../../services/terminalLabelSync', () => ({ attachTerminalLabelSync: jest.fn() }));
jest.mock('../../../services/terminalTitleColorSync', () => ({ attachTerminalTitleColorSync: jest.fn() }));
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn().mockResolvedValue(() => {}) }));
jest.mock('../../Terminal/TerminalDisplay', () => ({ TerminalDisplay: () => <div /> }));
jest.mock('../dnd/usePaneDrag', () => ({ usePaneDrag: () => () => {} }));
jest.mock('../../../services/TerminalService', () => ({ terminalService: {
  getProcessId: () => 'pc-1', createTerminal: jest.fn(), writeToTerminal: jest.fn().mockResolvedValue(undefined),
  resizeTerminal: jest.fn().mockResolvedValue(undefined), stashPromptGate: jest.fn(),
} }));
jest.mock('../../../services/AgentSchemeTracker', () => ({ agentSchemeTracker: {
  getAgentForTerminal: () => null, getDetectedAgentForTerminal: () => null,
  getDetectedAgentExeForTerminal: () => null, refreshNow: () => Promise.resolve(), subscribe: () => () => {},
} }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
test.each(['tab', 'window'] as const)('%s member ring/chip and undim; primary content cancels, secondary and all header controls do not', mode => {
  store.dispatch(addTab({ id: 'tb-pane-broadcast', title: 'Broadcast' }));
  store.dispatch(setActiveTab('tb-pane-broadcast'));
  store.dispatch(addTabTree({ tabId: 'tb-pane-broadcast', tree: { id: 'root', type: 'split', direction: 'horizontal', children: [
    { id: 'pn-broadcast', type: 'terminal', terminalId: 'tm-broadcast' },
    { id: 'pn-other', type: 'terminal', terminalId: 'tm-other' },
  ] } }));
  store.dispatch(setNonFocusedPaneOpacity(60));
  if (mode === 'window') {
    store.dispatch(addTab({ id: 'tb-background-active', title: 'Other' }));
    store.dispatch(setActiveTab('tb-background-active'));
    store.dispatch(startWindowBroadcast());
  } else store.dispatch(startTabBroadcast('tb-pane-broadcast'));
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  act(() => root.render(<Provider store={store}><TerminalPane paneId="pn-broadcast" terminalId="tm-broadcast"
    isActive={false} onSplit={() => {}} onClose={() => {}} onFocus={() => {}} /></Provider>));
  try {
    const pane = container.querySelector('.terminal-pane') as HTMLElement;
    expect(pane.classList.contains('broadcasting')).toBe(true);
    expect(pane.style.opacity).toBe('');
    expect(pane.querySelector('.broadcast-chip')!.textContent).toContain('broadcast');
    const pointer = (target: Element, button: number) => act(() => {
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button }));
    });
    for (const button of container.querySelectorAll('.pane-control-button')) {
      pointer(button, 0); expect(store.getState().broadcast.mode).toBe(mode);
    }
    const content = container.querySelector('.terminal-pane-content')!;
    pointer(content, 2); expect(store.getState().broadcast.mode).toBe(mode);
    pointer(content, 0); expect(store.getState().broadcast.mode).toBe('off');
    expect(pane.classList.contains('broadcasting')).toBe(false);
    expect(pane.style.opacity).toBe('0.6');
    act(() => container.querySelector('.terminal-pane-header')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    const row = [...document.querySelectorAll<HTMLButtonElement>('.pane-context-menu button')]
      .find(button => button.textContent?.includes('Focus all panes in this tab'))!;
    expect(row.disabled).toBe(false);
    act(() => { store.dispatch(setActiveTab('tb-pane-broadcast')); row.click(); });
    expect(store.getState().broadcast).toEqual({ mode: 'tab', tabId: 'tb-pane-broadcast' });
    act(() => container.querySelector('.terminal-pane-header')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(document.querySelector('.pane-context-menu')!.textContent).toContain('Stop focusing all panes');
    expect(document.querySelector('.pane-context-menu')!.textContent).toContain('Ctrl+Shift+B');
  } finally { act(() => root.unmount()); container.remove(); store.dispatch(stopBroadcast()); }
});
