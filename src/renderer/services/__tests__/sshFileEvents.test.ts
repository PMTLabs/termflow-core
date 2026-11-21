import type { CwdEvent, EditNotice } from '../../components/Ssh/sshFileTypes';
import { sshFileEvents } from '../sshFileEvents';

const notice: EditNotice = { terminalId: 'tm-a', editId: 'edit-a', path: '/a', state: 'watching', sessionGeneration: 7 };
const cwd: CwdEvent = { terminalId: 'tm-a', path: '/remote', host: 'host.test', sessionGeneration: 7 };

function fixture() {
  let edit: (event: EditNotice) => void = () => {};
  let cd: (event: CwdEvent) => void = () => {};
  const stopEdit = jest.fn(), stopCwd = jest.fn();
  const api = {
    onFsEditState: jest.fn(async (listener: typeof edit) => { edit = listener; return stopEdit; }),
    onFsCwd: jest.fn(async (listener: typeof cd) => { cd = listener; return stopCwd; }),
    fsEditList: jest.fn(async () => []),
  };
  return { api, edit: (event: EditNotice) => edit(event), cwd: (event: CwdEvent) => cd(event), stopEdit, stopCwd };
}

test('events_filter_terminal_owner_and_unlisten_after_unmount', async () => {
  const f = fixture();
  const onEdit = jest.fn(), onCwd = jest.fn(), other = jest.fn();
  const session = () => ({ connected: true, generation: 7 });
  const a = sshFileEvents(f.api).register('tm-a', { session, onEdit, onCwd });
  const b = sshFileEvents(f.api).register('tm-b', { session, onEdit: other, onCwd: other });
  await Promise.all([a.ready, b.ready]);
  expect(f.api.onFsEditState).toHaveBeenCalledTimes(1);
  expect(f.api.onFsCwd).toHaveBeenCalledTimes(1);
  f.edit({ ...notice, sessionGeneration: 6 });
  f.cwd({ ...cwd, sessionGeneration: 6 });
  f.edit(notice);
  f.cwd(cwd);
  expect(onEdit.mock.calls).toEqual([[notice]]);
  expect(onCwd.mock.calls).toEqual([[cwd]]);
  expect(other).not.toHaveBeenCalled();
  a.unregister();
  f.edit(notice);
  f.cwd(cwd);
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onCwd).toHaveBeenCalledTimes(1);
  expect(f.stopEdit).not.toHaveBeenCalled();
  b.unregister();
  expect(f.stopEdit).toHaveBeenCalledTimes(1);
  expect(f.stopCwd).toHaveBeenCalledTimes(1);
  const early = sshFileEvents(f.api).register('tm-a', { session, onEdit });
  early.unregister(); // Native listen promises have not resolved yet.
  await early.ready;
  expect(f.stopEdit).toHaveBeenCalledTimes(2);
  expect(f.stopCwd).toHaveBeenCalledTimes(2);
});

test('late_ack_after_disconnect_never_toasts_success', async () => {
  const f = fixture();
  const toastSuccess = jest.fn();
  let connected = true;
  const a = sshFileEvents(f.api).register('tm-a', {
    session: () => ({ connected, generation: 7 }),
    onEdit(event) { if (event.state === 'uploaded') toastSuccess(); },
  });
  const otherWindow = fixture();
  const b = sshFileEvents(otherWindow.api).register('tm-b', {
    session: () => ({ connected: true, generation: 7 }),
    onEdit: toastSuccess,
  });
  await Promise.all([a.ready, b.ready]);
  const uploaded = { ...notice, state: 'uploaded' };
  f.edit(uploaded);
  otherWindow.edit(uploaded);
  expect(toastSuccess).toHaveBeenCalledTimes(1);
  connected = false;
  f.edit(uploaded);
  expect(toastSuccess).toHaveBeenCalledTimes(1);
  a.unregister();
  b.unregister();
});

test('retiring_generation_final_edit_states_still_reach_the_owner', async () => {
  const f = fixture();
  const onEdit = jest.fn(), onCwd = jest.fn();
  const a = sshFileEvents(f.api).register('tm-a', { session: () => ({ connected: true, generation: 8 }), onEdit, onCwd });
  await a.ready;
  const old = { ...notice, sessionGeneration: 7 };
  for (const state of ['watching', 'uploading', 'uploaded']) f.edit({ ...old, state });
  f.cwd({ ...cwd, sessionGeneration: 7 });
  expect(onEdit).not.toHaveBeenCalled();
  expect(onCwd).not.toHaveBeenCalled();
  const finals = ['stopped', 'paused', 'conflict', 'error'].map(state => ({ ...old, state, localPath: '/kept' }));
  finals.forEach(event => f.edit(event));
  expect(onEdit.mock.calls).toEqual(finals.map(event => [event]));
  a.unregister();
});
