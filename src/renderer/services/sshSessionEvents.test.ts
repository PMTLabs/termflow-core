import { configureStore } from '@reduxjs/toolkit';
import reducer from '../store/slices/sshSessionSlice';
import { installSshSessionEvents } from './sshSessionEvents';
import type { SshAPI, SshSessionView } from '../types/ssh';
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
test('restore_hydrates_same_terminalId_not_new_paneId; delayed snapshot cannot undo disconnect', async () => {
  let listener: (v: SshSessionView) => void = () => {};
  let resolveSnapshot: (v: SshSessionView) => void = () => {};
  const unlisten = jest.fn();
  const api = { onSshSessionState: jest.fn(async (cb: typeof listener) => { listener = cb; return unlisten; }), sshSessionState: jest.fn(() => new Promise<SshSessionView>(r => { resolveSnapshot = r; })) } as unknown as SshAPI;
  const trees = { hidden: { id: 'pn-different', type: 'terminal' as const, terminalId: 'tm-stable', ssh: { connectionId: 'c-original' } } };
  const state = configureStore({ reducer: { sshSession: reducer } });
  const store = { getState: () => ({ panes: { treesByTabId: trees } }), dispatch: state.dispatch, subscribe: state.subscribe };
  const stop = installSshSessionEvents(store, api); await flush();
  expect(api.sshSessionState).toHaveBeenCalledWith('tm-stable');
  listener({ terminalId: 'tm-stable', connectionId: 'c-original', state: 'disconnected', generation: 1, revision: 5, gate: 'blocked' });
  resolveSnapshot({ terminalId: 'tm-stable', connectionId: 'c-original', state: 'connected', generation: 1, revision: 4, gate: 'verified' }); await flush();
  expect(state.getState().sshSession.byTerminal['tm-stable'].session?.state).toBe('disconnected');
  stop(); stop(); expect(unlisten).toHaveBeenCalledTimes(1);
});
test('unmounted_window_listener_released_once even when registration is delayed', async () => {
  let resolve: (stop: () => void) => void = () => {};
  const api = { onSshSessionState: () => new Promise<() => void>(r => { resolve = r; }) } as unknown as SshAPI;
  const stop = installSshSessionEvents({ getState: () => ({ panes: { treesByTabId: {} } }), dispatch: jest.fn(), subscribe: jest.fn() }, api);
  stop(); stop(); const unlisten = jest.fn(); resolve(unlisten); await flush(); expect(unlisten).toHaveBeenCalledTimes(1);
});
