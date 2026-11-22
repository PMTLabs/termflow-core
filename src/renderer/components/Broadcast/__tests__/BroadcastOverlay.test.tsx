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
const live = new Set<string>();
jest.mock('../../../services/TerminalService', () => ({ terminalService: { getProcessId: (id: string) => live.has(id) ? 'pid' : undefined } }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
test('window banner counts only process-backed members across tabs, custom stop hint and button; hidden off/tab', () => {
  store.dispatch(stopBroadcast()); store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
  for (const [id, terminalId] of [['tb-one', 'tm-one'], ['tb-two', 'tm-two'], ['tb-three', 'tm-no-process']]) {
    store.dispatch(addTab({ id, title: id }));
    store.dispatch(addTabTree({ tabId: id, tree: { id: `pn-${id}`, type: 'terminal', terminalId } }));
  }
  store.dispatch(setActiveTab('tb-one'));
  live.clear(); live.add('tm-one'); live.add('tm-two');
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  act(() => root.render(<Provider store={store}><BroadcastOverlay /></Provider>));
  try {
    expect(container.textContent).toBe('');
    act(() => store.dispatch(startTabBroadcast('tb-one'))); expect(container.textContent).toBe('');
    act(() => store.dispatch(startWindowBroadcast()));
    expect(container.textContent).toBe('Typing into all 2 open terminals across tabs · Ctrl+Shift+B to stopStop');
    expect(container.querySelector('.broadcast-window-border')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.broadcast-banner')!.getAttribute('role')).toBe('status');
    // A process starting or exiting changes no store state; the service's events must re-count.
    live.add('tm-no-process'); act(() => { window.dispatchEvent(new CustomEvent('pty:spawn')); });
    expect(container.textContent).toContain('all 3 open terminals');
    live.delete('tm-two'); act(() => { window.dispatchEvent(new CustomEvent('pty:exit')); });
    expect(container.textContent).toContain('all 2 open terminals');
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
  const rule = (selector: string) => `\n${css.replace(/\r/g, '')}`.split(`\n${selector} {`)[1].split('}')[0];
  const border = rule('.broadcast-window-border');
  for (const decl of [/position: fixed;/, /inset: 0;/, /pointer-events: none;/, /z-index: 90;/]) expect(border).toMatch(decl);
  expect(rule('.broadcast-banner')).not.toMatch(/position:/);
  // --bg-secondary is dark-only; the light banner must bring its own surface.
  expect(rule('.light-theme .broadcast-banner')).toMatch(/background: #f3f3f3;/);
  // The window scope is violet in both themes, distinct from the amber tab scope (#e5a832 / #956000).
  expect(border).toMatch(/var\(--broadcast-ring, #c586f0\)/);
  expect(rule('.light-theme .broadcast-window-border')).toMatch(/--broadcast-ring: #7b2fb5;/);
  expect(rule('.light-theme .broadcast-banner')).toMatch(/--broadcast-ring: #7b2fb5;/);
  const pane = fs.readFileSync(path.join(__dirname, '../../Panes/TerminalPane.css'), 'utf8');
  expect(pane).toMatch(/\.terminal-pane\.broadcast-window \{ --broadcast-ring: #c586f0; \}/);
  expect(pane).toMatch(/\.light-theme \.terminal-pane\.broadcast-window \{ --broadcast-ring: #7b2fb5; \}/);
  const app = fs.readFileSync(path.join(__dirname, '../../../App.tsx'), 'utf8');
  expect(app).toMatch(/<TitleBar\s*\/>\s*<BroadcastOverlay\s*\/>\s*<div className="app-body">/);
});
