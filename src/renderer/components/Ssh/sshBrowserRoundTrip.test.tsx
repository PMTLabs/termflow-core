/** @jest-environment jsdom */
// The store imports TerminalContainer transitively. Leave the browser, hook and slices real.
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../../utils/clipboard', () => ({ writeClipboardText: jest.fn() }));
jest.mock('../../services/TerminalService', () => ({ terminalService: { writeToTerminal: jest.fn() } }));
jest.mock('./ssh066Contract', () => ({
  ...jest.requireActual('./ssh066Contract'), readSshLaunchState: jest.fn(), readReconnectCoordinator: jest.fn(),
}));

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../store';
import { sshOwnersChanged, sshSessionObserved } from '../../store/slices/sshSessionSlice';
import { dismissAllToasts } from '../../store/slices/uiSlice';
import { SshFileBrowser } from './SshFileBrowser';
import { readSshLaunchState, type SshPaneTag } from './ssh066Contract';
import type { FsError, RemoteListing } from './sshFileTypes';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: FsError) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

// This crosses the renderer bridge boundary with controlled replies, not native IPC.
test('folder create waits for ack and listing; denied rename leaves the confirmed directory intact', async () => {
  const terminalId = 'tm-browser-round-trip';
  const tag: SshPaneTag = {
    connectionId: 'remote', browserPath: '/home', browserCollapsed: false, followCd: false, hiddenMetrics: [],
  };
  const request = { terminalId, path: '/home', expectedGeneration: 1 };
  const initial: RemoteListing = { path: '/home', sessionGeneration: 1, entries: [] };
  const opened = deferred<RemoteListing>(), ack = deferred<void>(), refreshed = deferred<RemoteListing>();
  const renameReply = deferred<void>();
  const api = {
    fsList: jest.fn().mockReturnValueOnce(opened.promise).mockReturnValueOnce(refreshed.promise),
    fsMkdir: jest.fn(() => ack.promise),
    fsRename: jest.fn(() => renameReply.promise),
    onFsCwd: jest.fn(async () => () => {}),
  };
  const patch = jest.fn();
  const originalBridge = Object.getOwnPropertyDescriptor(window, 'electronAPI');
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const originalAct = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, 'electronAPI', { value: { ssh: api }, configurable: true });
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  const button = (label: string) => [...document.querySelectorAll('button')].find(el => el.textContent === label)!;
  const row = (name: string) => [...container.querySelectorAll('.ssh-file-name')].find(el => el.lastChild?.textContent === name);
  const renameMenuItem = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find(el => el.querySelector('.context-menu-label')?.textContent === 'Rename')!;
  const nameField = () => document.querySelector<HTMLInputElement>('[role=dialog] input')!;
  const type = (value: string) => {
    const field = nameField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const toasts = () => store.getState().ui.toasts;
  try {
    store.dispatch(dismissAllToasts());
    store.dispatch(sshOwnersChanged({ [terminalId]: tag.connectionId }));
    jest.mocked(readSshLaunchState).mockReturnValue({ sessionGeneration: 1, stage: 'running', launchSeq: 1, revision: 1 });
    store.dispatch(sshSessionObserved({ terminalId, connectionId: tag.connectionId, state: 'connected', generation: 1, revision: 1, gate: 'blocked' }));
    await act(async () => root.render(<Provider store={store}>
      <SshFileBrowser terminalId={terminalId} sshTag={tag} surfaceActive onPatchTag={patch} />
    </Provider>));
    expect(api.fsList.mock.calls).toEqual([[request]]);
    await act(async () => opened.resolve(initial));

    act(() => button('New folder').click());
    act(() => type('reports'));
    act(() => button('Create').click());
    expect(api.fsMkdir.mock.calls).toEqual([[{ ...request, path: '/home/reports' }]]);
    expect(button('Create').disabled).toBe(true);
    expect(api.fsList).toHaveBeenCalledTimes(1);
    expect(row('reports')).toBeUndefined();
    expect(toasts()).toHaveLength(0);

    await act(async () => ack.resolve());
    expect(api.fsList.mock.calls).toEqual([[request], [request]]);
    expect(button('Create').disabled).toBe(true);
    expect(row('reports')).toBeUndefined();
    expect(toasts()).toHaveLength(0);
    await act(async () => refreshed.resolve({ ...initial, entries: [{ name: 'reports', path: '/home/reports', kind: 'directory' }] }));
    expect(row('reports')).toBeDefined();
    expect(document.querySelector('[role=dialog]')).toBeNull();
    const created = [...toasts()];
    expect(created).toEqual([expect.objectContaining({ type: 'success', message: 'Folder created.' })]);

    act(() => { row('reports')!.parentElement!.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })); });
    await act(async () => renameMenuItem().click());
    act(() => type('archive'));
    act(() => button('Rename').click());
    expect(api.fsRename.mock.calls).toEqual([[{ ...request, path: '/home/reports', newPath: '/home/archive' }]]);
    expect(button('Rename').disabled).toBe(true);
    expect(document.querySelector('[role=dialog] [role=alert]')).toBeNull();
    expect(toasts()).toEqual(created);
    await act(async () => renameReply.reject({
      code: 'permissionDenied', operation: 'rename', path: '/home/reports',
      outcome: 'unchanged', message: 'Permission denied; nothing was changed.',
    }));
    expect(document.querySelector('[role=dialog] [role=alert]')?.textContent)
      .toBe('/home/reports: Permission denied; nothing was changed.');
    expect(toasts()).toEqual(created);
    expect(api.fsList).toHaveBeenCalledTimes(2);
    expect(row('reports')).toBeDefined();
    expect(row('archive')).toBeUndefined();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Remote path"]')?.value).toBe('/home');
    expect(container.textContent).toContain('Current directory: /home');
    expect(patch).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    store.dispatch(sshOwnersChanged({}));
    store.dispatch(dismissAllToasts());
    jest.mocked(readSshLaunchState).mockReset();
    if (originalBridge) Object.defineProperty(window, 'electronAPI', originalBridge);
    else Reflect.deleteProperty(window, 'electronAPI');
    env.IS_REACT_ACT_ENVIRONMENT = originalAct;
  }
});
