/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';

jest.mock('../TerminalPane.css', () => ({}));
jest.mock('../dnd/usePaneDrag', () => ({ usePaneDrag: () => () => {} }));
jest.mock('../../Terminal/TerminalDisplay', () => ({ TerminalDisplay: () => <div /> }));

const createTerminal = jest.fn();
const closeTerminal = jest.fn();
jest.mock('../../../services/TerminalService', () => ({
  terminalService: {
    getProcessId: () => undefined,
    createTerminal,
    closeTerminal,
    writeToTerminal: jest.fn(),
    resizeTerminal: jest.fn(),
    stashPromptGate: jest.fn(),
  },
}));

import { TerminalPane } from '../TerminalPane';
import { store } from '../../../store';
import { addTab, clearAllTabs } from '../../../store/slices/tabsSlice';
import { addTabTree, resetPanes } from '../../../store/slices/panesSlice';
import { markProvisionalRecovery } from '../../../services/provisionalRecovery';

let container: HTMLDivElement;
let root: Root;

const mount = (terminalId: string) => {
  root.render(<Provider store={store}><TerminalPane paneId={terminalId} terminalId={terminalId} isActive onSplit={() => {}} onClose={() => {}} onFocus={() => {}} /></Provider>);
};

const addRecoveryTab = (tabId: string, terminalId: string, multiPane = false, title = 'Recovered terminal') => {
  store.dispatch(addTab({ id: tabId, title, shellType: 'default' }));
  store.dispatch(addTabTree({ tabId, tree: multiPane ? {
    id: 'split', type: 'split', direction: 'horizontal', children: [
      { id: terminalId, type: 'terminal', terminalId, sessionKey: 'S' },
      { id: 'tm-other', type: 'terminal', terminalId: 'tm-other' },
    ],
  } : { id: terminalId, type: 'terminal', terminalId, sessionKey: 'S' } }));
};

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  store.dispatch(clearAllTabs());
  store.dispatch(resetPanes());
  (window as any).terminalInitMap?.clear();
  (window as any).terminalInitPromises?.clear();
  (window as any).terminalInitLock?.clear();
  createTerminal.mockReset();
  closeTerminal.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('recovery create contention', () => {
  it('removes the losing recovery tab and never closes a host session', async () => {
    addRecoveryTab('tb-loser', 'tm-loser');
    markProvisionalRecovery('tm-loser');
    createTerminal.mockRejectedValueOnce(new Error('host-session-contended: host session S is already registered'));
    act(() => mount('tm-loser'));
    await settle();

    expect(store.getState().tabs.tabs.find(tab => tab.id === 'tb-loser')).toBeUndefined();
    expect(store.getState().panes.treesByTabId['tb-loser']).toBeUndefined();
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it('keeps a migrated pane with a session key after contention', async () => {
    addRecoveryTab('tb-migrated', 'tm-migrated', false, 'Migrated user tab');
    createTerminal.mockRejectedValueOnce(new Error('host-session-contended: host session S is already registered'));
    act(() => mount('tm-migrated'));
    await settle();

    expect(store.getState().tabs.tabs.find(tab => tab.id === 'tb-migrated')).toMatchObject({
      id: 'tb-migrated', title: 'Migrated user tab',
    });
    expect(store.getState().panes.treesByTabId['tb-migrated']).toMatchObject({
      type: 'terminal', terminalId: 'tm-migrated', sessionKey: 'S',
    });
    expect(container.textContent).toContain('Failed to start shell');
  });

  it('keeps a tab and shows startup failure for an ordinary create error', async () => {
    addRecoveryTab('tb-spawn-error', 'tm-spawn-error');
    createTerminal.mockRejectedValueOnce(new Error('spawn failed'));
    act(() => mount('tm-spawn-error'));
    await settle();

    expect(store.getState().tabs.tabs.find(tab => tab.id === 'tb-spawn-error')).toBeDefined();
    expect(store.getState().panes.treesByTabId['tb-spawn-error']).toBeDefined();
    expect(container.textContent).toContain('Failed to start shell');
  });

  it('keeps a provisional tab when a spawn error merely embeds the contention marker', async () => {
    addRecoveryTab('tb-embedded-marker', 'tm-embedded-marker');
    markProvisionalRecovery('tm-embedded-marker');
    createTerminal.mockRejectedValueOnce(new Error('spawn failed for C:\\host-session-contended: \\shell.exe'));
    act(() => mount('tm-embedded-marker'));
    await settle();

    expect(store.getState().tabs.tabs.find(tab => tab.id === 'tb-embedded-marker')).toBeDefined();
    expect(store.getState().panes.treesByTabId['tb-embedded-marker']).toMatchObject({
      type: 'terminal', terminalId: 'tm-embedded-marker',
    });
    expect(container.textContent).toContain('Failed to start shell');
  });

  it('does not remove a multi-pane tab after a contention loss', async () => {
    addRecoveryTab('tb-split', 'tm-split', true);
    createTerminal.mockRejectedValueOnce(new Error('host-session-contended: host session S is claimed by another recovery'));
    act(() => mount('tm-split'));
    await settle();

    expect(store.getState().tabs.tabs.find(tab => tab.id === 'tb-split')).toBeDefined();
    expect(store.getState().panes.treesByTabId['tb-split']).toBeDefined();
  });
});
