import reducer, { sshOwnersChanged, sshAttachmentResolved, sshSessionObserved, sshLiveData, sshFilesEnabled } from './sshSessionSlice';
import type { SshSessionView } from '../../types/ssh';
const view = (state: SshSessionView['state'], generation = 1, revision = 1): SshSessionView => ({ terminalId: 'tm-a', connectionId: 'c-a', state, generation, revision, gate: 'verified' });
test('old_snapshot_cannot_overwrite_new_disconnect', () => {
  let state = reducer(undefined, sshOwnersChanged({ 'tm-a': 'c-a' }));
  state = reducer(state, sshSessionObserved(view('disconnected', 1, 3)));
  state = reducer(state, sshSessionObserved(view('connected', 1, 2)));
  expect(state.byTerminal['tm-a'].session?.state).toBe('disconnected');
});
test('old_generation_event_cannot_clear_new_connection', () => {
  let state = reducer(undefined, sshOwnersChanged({ 'tm-a': 'c-a' }));
  state = reducer(state, sshSessionObserved(view('connected', 2, 1)));
  state = reducer(state, sshSessionObserved(view('disconnected', 1, 99)));
  expect(state.byTerminal['tm-a'].session?.state).toBe('connected');
});
test('disconnect_clears_metrics_and_disables_file_selectors_same_dispatch', () => {
  let state = reducer(undefined, sshOwnersChanged({ 'tm-a': 'c-a' }));
  state = reducer(state, sshSessionObserved(view('connected')));
  state = reducer(state, sshLiveData({ terminalId: 'tm-a', generation: 1, metrics: { cpu: 90 }, files: ['live'] }));
  expect(state.byTerminal['tm-a'].files).toEqual(['live']);
  state = reducer(state, sshSessionObserved(view('disconnected', 1, 2)));
  expect(state.byTerminal['tm-a'].files).toBeUndefined(); expect(state.byTerminal['tm-a'].metrics).toBeUndefined(); expect(sshFilesEnabled(state, 'tm-a')).toBe(false);
  state = reducer(state, sshLiveData({ terminalId: 'tm-a', generation: 1, files: ['late'] }));
  expect(state.byTerminal['tm-a'].files).toBeUndefined();
});
test('unknown_terminal_event_cannot_create_live_ui', () => {
  let state = reducer(undefined, sshSessionObserved(view('connected'))); expect(state.byTerminal).toEqual({});
  state = reducer(state, sshOwnersChanged({ 'tm-b': 'c-b' }));
  state = reducer(state, sshSessionObserved({ ...view('connected'), terminalId: 'tm-b' })); expect(state.byTerminal['tm-b'].session).toBeUndefined();
});
test('reattached_flag_survives_resolving_before_the_owner_sync', () => {
  // P068-10: createTerminal can resolve before the owner sync creates the entry.
  let state = reducer(undefined, sshAttachmentResolved({ terminalId: 'tm-a', connectionId: 'c-a', reattachedProcessId: 'pc-1' }));
  state = reducer(state, sshOwnersChanged({ 'tm-a': 'c-a' }));
  expect(state.byTerminal['tm-a'].reattachedProcessId).toBe('pc-1');
  state = reducer(state, sshAttachmentResolved({ terminalId: 'tm-a', connectionId: 'c-other', reattachedProcessId: 'pc-2' }));
  expect(state.byTerminal['tm-a'].reattachedProcessId).toBe('pc-1');
  state = reducer(state, sshOwnersChanged({}));
  expect(state.byTerminal['tm-a']).toBeUndefined();
});
