/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../../store';
import { addTab, clearAllTabs, setActiveTab } from '../../../store/slices/tabsSlice';
import { addTabTree, resetPanes } from '../../../store/slices/panesSlice';
import { startWindowBroadcast, startTabBroadcast, stopBroadcast } from '../../../store/slices/broadcastSlice';
import { setCustomKeybindings } from '../../../store/slices/settingsSlice';
import { BroadcastOverlay } from '../BroadcastOverlay';
import fs from 'fs';
import path from 'path';

jest.mock('../../../services/paneOwnership', () => ({ attachPaneOwnershipSync: jest.fn() }));
jest.mock('../../../services/terminalLabelSync', () => ({ attachTerminalLabelSync: jest.fn() }));
jest.mock('../../../services/terminalTitleColorSync', () => ({ attachTerminalTitleColorSync: jest.fn() }));
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn().mockResolvedValue(() => {}) }));
jest.mock('../../../services/TerminalService', () => ({ terminalService: { getProcessId: (id: string) => id === 'tm-no-process' ? undefined : 'pid' } }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
test('window banner counts only process-backed members across tabs, custom stop hint and button; hidden off/tab', () => {
  store.dispatch(stopBroadcast()); store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
  for (const [id, terminalId] of [['tb-one', 'tm-one'], ['tb-two', 'tm-two'], ['tb-three', 'tm-no-process']]) {
    store.dispatch(addTab({ id, title: id }));
    store.dispatch(addTabTree({ tabId: id, tree: { id: `pn-${id}`, type: 'terminal', terminalId } }));
  }
  store.dispatch(setActiveTab('tb-one'));
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  act(() => root.render(<Provider store={store}><BroadcastOverlay /></Provider>));
  try {
    expect(container.textContent).toBe('');
    act(() => store.dispatch(startTabBroadcast('tb-one'))); expect(container.textContent).toBe('');
    act(() => store.dispatch(startWindowBroadcast()));
    expect(container.textContent).toBe('Typing into all 2 open terminals across tabs · Ctrl+Shift+B to stopStop');
    act(() => store.dispatch(setCustomKeybindings({ stopBroadcastInput: 'Alt+B' })));
    expect(container.textContent).toContain('Alt+B to stop');
    expect(container.querySelector('.broadcast-window-border')).not.toBeNull();
    act(() => container.querySelector('button')!.click());
    expect(store.getState().broadcast.mode).toBe('off'); expect(container.textContent).toBe('');
  } finally {
    act(() => root.unmount()); container.remove(); store.dispatch(stopBroadcast()); store.dispatch(setCustomKeybindings({}));
  }
});
test('border is fixed, non-interactive and below menus; banner is in flow below titlebar', () => {
  const css = fs.readFileSync(path.join(__dirname, '../BroadcastOverlay.css'), 'utf8');
  expect(css).toMatch(/position: fixed/); expect(css).toMatch(/pointer-events: none/); expect(css).toMatch(/z-index: 90/);
  expect(css.split('.broadcast-banner {')[1].split('}')[0]).not.toMatch(/position:/);
  const app = fs.readFileSync(path.join(__dirname, '../../../App.tsx'), 'utf8');
  expect(app).toMatch(/<TitleBar\s*\/>\s*<BroadcastOverlay\s*\/>\s*<div className="app-body">/);
});
