/** @jest-environment jsdom */
import { store } from '../../store';
import { addTab, setActiveTab, removeTab, clearAllTabs } from '../../store/slices/tabsSlice';
import { findLeafByTerminalId } from '../../store/slices/paneTreeOps';
import { addTabTree, resetPanes, splitPaneInTab, removePaneFromTab } from '../../store/slices/panesSlice';
import { startTabBroadcast, stopBroadcast, selectBroadcastMembers } from '../../store/slices/broadcastSlice';
import { installInputBroadcast } from '../inputBroadcast';
import { deliverBroadcast, setBroadcastSink, type BroadcastUnit } from '@termflow/terminal-core';
import { terminalService } from '../TerminalService';
import { broadcastMenuItems } from '../../components/Panes/broadcastMenuItems';
import { InputHandler, inputHandler } from '../InputHandler';
import { SHORTCUT_ACTIONS } from '../shortcutActions';
import fs from 'fs';
import path from 'path';

jest.mock('../paneOwnership', () => ({ attachPaneOwnershipSync: jest.fn() }));
jest.mock('../terminalLabelSync', () => ({ attachTerminalLabelSync: jest.fn() }));
jest.mock('../terminalTitleColorSync', () => ({ attachTerminalTitleColorSync: jest.fn() }));
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn().mockResolvedValue(() => {}) }));
jest.mock('@termflow/terminal-core', () => ({ setBroadcastSink: jest.fn(), deliverBroadcast: jest.fn(), isBroadcastAvailable: jest.fn(() => true) }));
jest.mock('../TerminalService', () => ({ terminalService: { getProcessId: jest.fn(() => 'pid'), writeToTerminal: jest.fn().mockResolvedValue(undefined) } }));
const leaves = (n: number): any => ({ id: 'root', type: 'split', direction: 'horizontal', children: Array.from({ length: n }, (_, i) => ({ id: `pn-${i}`, type: 'terminal', terminalId: `tm-${i}` })) });
function tree(n: number) { store.dispatch(addTabTree({ tabId: 'tb-broadcast', tree: leaves(n) })); }
beforeEach(() => {
  store.dispatch(stopBroadcast()); store.dispatch(clearAllTabs()); store.dispatch(resetPanes());
  store.dispatch(addTab({ id: 'tb-broadcast', title: 'Broadcast' })); tree(4);
  store.dispatch(setActiveTab('tb-broadcast')); jest.clearAllMocks();
});
afterEach(() => { store.dispatch(stopBroadcast()); });

test('live membership 4 → split 5 → close 4, switch/remove/empty/Canvas auto-stop', () => {
  store.dispatch(startTabBroadcast('tb-broadcast'));
  expect(selectBroadcastMembers(store.getState())).toHaveLength(4);
  store.dispatch(splitPaneInTab({ tabId: 'tb-broadcast', paneId: 'pn-0', direction: 'vertical', terminalId: 'tm-split' }));
  expect(selectBroadcastMembers(store.getState())).toHaveLength(5);
  const added = findLeafByTerminalId(store.getState().panes.treesByTabId, 'tm-split')!;
  store.dispatch(removePaneFromTab({ tabId: 'tb-broadcast', paneId: added.id }));
  expect(selectBroadcastMembers(store.getState())).toHaveLength(4);
  store.dispatch(addTab({ id: 'tb-other', title: 'Other' })); store.dispatch(setActiveTab('tb-other'));
  expect(store.getState().broadcast.mode).toBe('off');
  store.dispatch(setActiveTab('tb-broadcast')); store.dispatch(startTabBroadcast('tb-broadcast')); tree(0);
  expect(store.getState().broadcast.mode).toBe('off');
  tree(4); store.dispatch(startTabBroadcast('tb-broadcast')); store.dispatch(removeTab('tb-broadcast'));
  expect(store.getState().broadcast.mode).toBe('off');
  store.dispatch(addTab({ id: 'tb-broadcast', title: 'Broadcast' })); tree(4);
  store.dispatch(setActiveTab('tb-broadcast')); store.dispatch(startTabBroadcast('tb-broadcast'));
  store.dispatch(addTab({ id: 'tb-canvas', title: 'Canvas', shellType: 'canvas' })); store.dispatch(setActiveTab('tb-canvas'));
  expect(store.getState().broadcast.mode).toBe('off');
});
test('sink uses live members, excludes source and outsiders, skips processless targets and unsets when off', () => {
  const dispose = installInputBroadcast(store);
  expect(setBroadcastSink).toHaveBeenLastCalledWith(null, null);
  store.dispatch(startTabBroadcast('tb-broadcast'));
  const sink = jest.mocked(setBroadcastSink).mock.calls.at(-1)![0]!;
  const unit: BroadcastUnit = { kind: 'text', data: 'x' };
  sink('outside', unit); expect(deliverBroadcast).not.toHaveBeenCalled();
  sink('tm-0', unit); expect(deliverBroadcast).toHaveBeenCalledTimes(3);
  tree(5); jest.mocked(deliverBroadcast).mockClear(); sink('tm-0', unit);
  expect(deliverBroadcast).toHaveBeenCalledTimes(4);
  jest.mocked(terminalService.getProcessId).mockReturnValueOnce(undefined);
  jest.mocked(deliverBroadcast).mockClear(); sink('tm-0', unit);
  expect(deliverBroadcast).toHaveBeenCalledTimes(3);
  store.dispatch(stopBroadcast()); expect(setBroadcastSink).toHaveBeenLastCalledWith(null, null);
  dispose(); expect(setBroadcastSink).toHaveBeenLastCalledWith(null);
});
test('shared menus start owning tab, stop with shortcut hint, disable single and unavailable', () => {
  const item = () => broadcastMenuItems(store.getState(), 'tb-broadcast', store.dispatch)[0];
  expect(item().label).toBe('Focus all panes in this tab'); item().click();
  expect(store.getState().broadcast).toEqual({ mode: 'tab', tabId: 'tb-broadcast' });
  expect(item()).toMatchObject({ label: 'Stop focusing all panes', accelerator: 'Ctrl+Shift+B' });
  item().click(); tree(1); expect(item().enabled).toBe(false);
  const { isBroadcastAvailable } = require('@termflow/terminal-core'); isBroadcastAvailable.mockReturnValueOnce(false);
  expect(item()).toMatchObject({ label: 'Focus all panes in this tab — Unavailable', enabled: false });
  for (const file of ['Panes/PaneContextMenu.tsx', 'Terminal/TerminalDisplay.tsx']) {
    expect(fs.readFileSync(path.join(__dirname, '../../components', file), 'utf8')).toContain('broadcastMenuItems(');
  }
});
test('clear-terminal fans form-feed to each ready member; stop shortcut is capture-only and never starts broadcast', async () => {
  inputHandler.destroy();
  const handler = new InputHandler(); await Promise.resolve();
  const child = document.createElement('div'); document.body.appendChild(child);
  const ptyKey = jest.fn(); child.addEventListener('keydown', ptyKey);
  const press = (key: string, code: string, shiftKey = true) => child.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
  store.dispatch(startTabBroadcast('tb-broadcast'));
  handler.applyKeybindingOverrides({ clearTerminal: 'Ctrl+L' });
  press('l', 'KeyL', false);
  expect(terminalService.writeToTerminal).toHaveBeenCalledTimes(4);
  for (let i = 0; i < 4; i++) expect(terminalService.writeToTerminal).toHaveBeenCalledWith(`tm-${i}`, '\x0c');
  jest.mocked(terminalService.getProcessId).mockReturnValueOnce(undefined);
  press('l', 'KeyL', false);
  expect(terminalService.writeToTerminal).toHaveBeenCalledTimes(7);
  press('B', 'KeyB'); expect(store.getState().broadcast.mode).toBe('off');
  press('B', 'KeyB'); expect(store.getState().broadcast.mode).toBe('off');
  expect(ptyKey).not.toHaveBeenCalled();
  expect(SHORTCUT_ACTIONS).toContainEqual(expect.objectContaining({ id: 'stopBroadcastInput', defaultCombo: 'Ctrl+Shift+B' }));
  handler.destroy(); child.remove();
});
