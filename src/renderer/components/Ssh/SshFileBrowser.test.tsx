/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../store';
import { sshOwnersChanged, sshSessionObserved } from '../../store/slices/sshSessionSlice';
import { dismissAllToasts } from '../../store/slices/uiSlice';
import type { SshSessionView } from '../../types/ssh';
import { SshBrowserPaneShell } from './SshBrowserPaneShell';
import { SshFileBrowser } from './SshFileBrowser';
import { readReconnectCoordinator, readSshLaunchState, type LaunchSnapshot, type SshPaneTag } from './ssh066Contract';
import type { CwdEvent, FsRequest, RemoteListing } from './sshFileTypes';

jest.mock('./ssh066Contract', () => ({
  ...jest.requireActual('./ssh066Contract'), readSshLaunchState: jest.fn(), readReconnectCoordinator: jest.fn(),
}));

const terminalId = 'tm-browser';
const initialTag: SshPaneTag = { connectionId: 'remote', browserCollapsed: false, browserPath: '/home', followCd: false, hiddenMetrics: ['ram'] };
const snapshot = (sessionGeneration = 1, stage: LaunchSnapshot['stage'] = 'running'): LaunchSnapshot =>
  ({ sessionGeneration, stage, launchSeq: sessionGeneration, revision: 1 });
const view = (state: SshSessionView['state'], generation = 1, revision = 1): SshSessionView =>
  ({ terminalId, connectionId: initialTag.connectionId, state, generation, revision, gate: 'blocked', promptId: 'p', secretKind: 'password' });
const listing = (path = '/home', sessionGeneration = 1): RemoteListing => ({ path, sessionGeneration, entries: [
  { name: '.env', path: `${path}/.env`, kind: 'file' },
  { name: 'logs', path: `${path}/logs`, kind: 'directory' },
] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(callback => { resolve = callback; });
  return { promise, resolve };
}

function createBridge() {
  let cwd: ((event: CwdEvent) => void) | undefined;
  return {
    fsList: jest.fn(async ({ path, expectedGeneration }: FsRequest) => listing(path, expectedGeneration)),
    fsCreate: jest.fn(async (_request: FsRequest) => {}), fsMkdir: jest.fn(async (_request: FsRequest) => {}),
    onFsEditState: jest.fn(async () => () => {}), fsEditList: jest.fn(async () => []),
    onFsCwd: jest.fn(async (cb: (event: CwdEvent) => void) => { cwd = cb; return () => { cwd = undefined; }; }),
    emit(path: string, sessionGeneration = 1) { cwd?.({ terminalId, path, sessionGeneration, host: 'remote' }); },
  };
}
let container: HTMLDivElement, root: ReturnType<typeof createRoot>, api: ReturnType<typeof createBridge>;
let patch: jest.Mock, tag: SshPaneTag;
const originalBridge = Object.getOwnPropertyDescriptor(window, 'electronAPI');
const render = (surfaceActive = true) => root.render(<Provider store={store}>
  <SshFileBrowser terminalId={terminalId} sshTag={tag} surfaceActive={surfaceActive} onPatchTag={patch} />
</Provider>);
const button = (label: string, parent: ParentNode = container) => [...parent.querySelectorAll('button')]
  .find(button => button.textContent === label)!;
const pathBox = () => container.querySelector<HTMLInputElement>('[aria-label="Remote path"]')!;
const input = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const submit = (form: HTMLFormElement) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
async function go(path: string) {
  act(() => input(pathBox(), path));
  await act(async () => { submit(pathBox().form!); });
}
const observe = (session: SshSessionView, launch = snapshot(session.generation)) => {
  jest.mocked(readSshLaunchState).mockReturnValue(launch);
  store.dispatch(sshSessionObserved(session));
};
const toasts = () => store.getState().ui.toasts;

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.mocked(readReconnectCoordinator).mockReset();
  store.dispatch(sshOwnersChanged({ [terminalId]: initialTag.connectionId }));
  store.dispatch(dismissAllToasts());
  observe(view('connected'));
  api = createBridge(); patch = jest.fn(); tag = { ...initialTag };
  Object.defineProperty(window, 'electronAPI', { value: { ssh: api }, configurable: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); store.dispatch(sshOwnersChanged({}));
  if (originalBridge) Object.defineProperty(window, 'electronAPI', originalBridge);
  else Reflect.deleteProperty(window, 'electronAPI');
  jest.useRealTimers();
});

const shell = (session: SshSessionView, reconnect = jest.fn(async () => {})) => root.render(<Provider store={store}>
  <SshBrowserPaneShell view={session} terminalId={terminalId} sshTag={tag} surfaceActive onPatchTag={patch}
    terminal={<div className="terminal-pane-content"><div className="terminal-display" /></div>}
    status={<span>Host metrics</span>} onSecret={async () => {}} onTrust={async () => {}} onCancel={() => {}}
    onReconnect={reconnect} />
</Provider>);

test('real_shell_composition_has_one_host_one_reconnect', async () => {
  await act(async () => shell(view('connected')));
  const host = container.querySelector('.terminal-display');
  expect(host).not.toBeNull(); expect(container.textContent).toContain('Host metrics');
  expect(container.textContent).toContain('.env');
  for (const session of [view('needs-secret', 1, 2), view('disconnected', 1, 3)]) {
    await act(async () => { observe(session, snapshot(1, 'ended')); shell(session); });
    expect(container.querySelectorAll('.terminal-display')).toHaveLength(1);
    expect(container.querySelector('.terminal-display')).toBe(host);
    expect([...container.querySelectorAll('button')].filter(b => b.textContent === 'Reconnect')).toHaveLength(session.state === 'disconnected' ? 1 : 0);
  }
  expect(container.textContent).toContain('Stale');
  act(() => button('Collapse').click());
  tag = { ...tag, browserCollapsed: true };
  act(() => shell(view('disconnected', 1, 3)));
  expect(button('Expand').closest('aside')?.classList.contains('collapsed')).toBe(true);
  expect(container.querySelector('.terminal-display')).toBe(host);
  expect([...container.querySelectorAll('button')].filter(b => b.textContent === 'Reconnect')).toHaveLength(1);
});

test('collapse_only_patches_target_tag_and_never_hidden_metrics', async () => {
  tag = { ...tag, browserCollapsed: true, browserPath: '/saved', followCd: true };
  await act(async () => shell(view('connected')));
  expect(api.fsList).not.toHaveBeenCalled(); expect(api.onFsCwd).toHaveBeenCalledTimes(1); // shell edit-warning subscription only
  act(() => button('Expand').click());
  expect(patch.mock.calls).toEqual([[{ browserCollapsed: false }]]);
  tag = { ...tag, browserCollapsed: false };
  await act(async () => shell(view('connected')));
  expect(api.fsList.mock.calls).toEqual([[{ terminalId, path: '/saved', expectedGeneration: 1 }]]);
  expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked).toBe(true);
  expect(tag.hiddenMetrics).toEqual(['ram']);
});

test('out_of_order_directory_responses_cannot_replace_latest', async () => {
  await act(async () => render());
  const older = deferred<RemoteListing>();
  api.fsList.mockImplementationOnce(() => older.promise);
  await go('/old'); await go('/new');
  await act(async () => older.resolve(listing('/old')));
  expect(pathBox().value).toBe('/new');
  expect(patch.mock.calls).toEqual([[{ browserPath: '/new' }]]);
});

test('failed_path_does_not_persist_or_claim_new_directory', async () => {
  await act(async () => render());
  api.fsList.mockRejectedValueOnce({ code: 'notFound', message: 'Not found' });
  await go('/missing');
  expect(pathBox().value).toBe('/home'); expect(container.textContent).toContain('Current directory: /home');
  expect(container.querySelector('[role=alert]')?.textContent).toContain('/missing');
  expect(patch).not.toHaveBeenCalled();
});

test('empty_directory_differs_from_permission_denied', async () => {
  api.fsList.mockResolvedValueOnce({ ...listing(), entries: [] });
  await act(async () => render());
  expect(container.textContent).toContain('Empty directory');
  api.fsList.mockRejectedValueOnce({ code: 'permissionDenied' });
  await go('/denied');
  expect(container.textContent).not.toContain('Empty directory');
  expect(container.querySelector('[role=alert]')?.textContent).toBe('Permission denied: /denied');
});

async function openCreate() {
  await act(async () => render());
  act(() => button('New file').click());
  const name = document.querySelector<HTMLInputElement>('[role=dialog] input')!;
  act(() => input(name, 'note'));
  return name.form!;
}

test('create_toast_waits_for_server_ack_and_refresh', async () => {
  const form = await openCreate();
  const ack = deferred<void>(), refreshed = deferred<RemoteListing>();
  api.fsCreate.mockReturnValueOnce(ack.promise); api.fsList.mockReturnValueOnce(refreshed.promise);
  act(() => { submit(form); });
  expect(api.fsCreate).toHaveBeenCalledWith({ terminalId, path: '/home/note', expectedGeneration: 1 });
  expect(api.fsList).toHaveBeenCalledTimes(1); expect(toasts()).toHaveLength(0);
  await act(async () => ack.resolve());
  expect(api.fsList).toHaveBeenLastCalledWith({ terminalId, path: '/home', expectedGeneration: 1 });
  expect(toasts()).toHaveLength(0);
  await act(async () => refreshed.resolve(listing()));
  expect(toasts()).toEqual([expect.objectContaining({ type: 'success', message: 'File created.' })]);
  expect(document.querySelector('[role=dialog]')).toBeNull();
});

test('duplicate_submit_sends_one_mutation', async () => {
  const form = await openCreate();
  const ack = deferred<void>(); api.fsCreate.mockReturnValueOnce(ack.promise);
  act(() => { submit(form); submit(form); });
  expect(api.fsCreate).toHaveBeenCalledTimes(1);
  await act(async () => ack.resolve());
});

test('drop_disables_all_actions_and_late_listing_stays_stale', async () => {
  await act(async () => render());
  const late = deferred<RemoteListing>(); api.fsList.mockReturnValueOnce(late.promise);
  await go('/late');
  act(() => observe(view('disconnected', 1, 2), snapshot(1, 'ended')));
  expect([...container.querySelectorAll('button, input')].every(el => (el as HTMLButtonElement).disabled)).toBe(true);
  await act(async () => late.resolve(listing('/late')));
  expect(container.querySelector('.ssh-file-rows.stale')?.textContent).toContain('.env');
  expect(container.querySelector('time')).not.toBeNull(); expect(container.textContent).not.toContain('/late');
  expect(patch).not.toHaveBeenCalled();
});

test('reconnect_loads_new_listing_before_live_state', async () => {
  await act(async () => render());
  act(() => observe(view('disconnected', 1, 2), snapshot(1, 'ended')));
  await act(async () => observe(view('connected', 2), snapshot(1)));
  expect(api.fsList).toHaveBeenCalledTimes(1); // An earlier launch cannot authorize generation 2.
  const fresh = deferred<RemoteListing>(); api.fsList.mockReturnValueOnce(fresh.promise);
  await act(async () => observe(view('connected', 2, 2), snapshot(2)));
  expect(api.fsList).toHaveBeenLastCalledWith({ terminalId, path: '/home', expectedGeneration: 2 });
  expect(button('Refresh').disabled).toBe(true); expect(button('New file').disabled).toBe(true);
  expect(container.querySelector('.stale')).not.toBeNull();
  await act(async () => fresh.resolve(listing('/home', 2)));
  expect(container.querySelector('.stale')).toBeNull(); expect(button('New file').disabled).toBe(false);
});

test('follow_off_does_not_list_or_patch_path', async () => {
  jest.useFakeTimers(); tag = { ...tag, followCd: true };
  await act(async () => render());
  act(() => api.emit('/queued'));
  tag = { ...tag, followCd: false }; await act(async () => render());
  await act(async () => { api.emit('/ignored'); jest.advanceTimersByTime(200); });
  expect(api.fsList).toHaveBeenCalledTimes(1); expect(pathBox().value).toBe('/home'); expect(patch).not.toHaveBeenCalled();
});

test('follow_permission_denied_preserves_last_confirmed_path', async () => {
  jest.useFakeTimers(); tag = { ...tag, followCd: true };
  await act(async () => render());
  api.fsList.mockRejectedValueOnce({ code: 'permissionDenied' });
  await act(async () => { api.emit('/first'); api.emit('/denied'); jest.advanceTimersByTime(100); });
  expect(api.fsList).toHaveBeenCalledTimes(2);
  expect(api.fsList).toHaveBeenLastCalledWith({ terminalId, path: '/denied', expectedGeneration: 1 });
  expect(container.textContent).toContain('Permission denied: /denied');
  expect(pathBox().value).toBe('/home'); expect(patch).not.toHaveBeenCalled();
});

test('no_report_shows_manual_hint_without_pwd_polling', async () => {
  jest.useFakeTimers(); tag = { ...tag, followCd: true };
  await act(async () => render());
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(container.textContent).toContain('Remote cwd not reported — use the path box.');
  expect(api.fsList.mock.calls).toEqual([[{ terminalId, path: '/home', expectedGeneration: 1 }]]);
});

test('inactive_surface_does_not_fetch_or_subscribe_and_lazy_expansion_does_not_move_root', async () => {
  tag = { ...tag, followCd: true };
  await act(async () => render(false));
  expect(api.fsList).not.toHaveBeenCalled(); expect(api.onFsCwd).not.toHaveBeenCalled();
  await act(async () => render());
  expect([...container.querySelectorAll('.ssh-file-name')].map(el => el.lastChild?.textContent)).toEqual(['logs', '.env']);
  const expand = container.querySelector<HTMLButtonElement>('[aria-label="Expand logs"]')!;
  await act(async () => expand.click());
  expect(api.fsList).toHaveBeenLastCalledWith({ terminalId, path: '/home/logs', expectedGeneration: 1 });
  expect(pathBox().value).toBe('/home'); expect(patch).not.toHaveBeenCalled();
});

test('shell_reconnect_displays_coordinator_error_without_using_fallback', async () => {
  const fallback = jest.fn(async () => {});
  const reconnect = jest.fn(async () => ({ ok: false as const, error: { code: 'NotAtPrompt', message: 'Return to the local prompt to reconnect' } }));
  jest.mocked(readReconnectCoordinator).mockReturnValue(reconnect);
  await act(async () => { observe(view('connected', 1, 2), snapshot(1, 'ended')); shell(view('connected', 1, 2), fallback); });
  await act(async () => button('Reconnect').click());
  expect(reconnect).toHaveBeenCalledWith(terminalId); expect(fallback).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Return to the local prompt to reconnect');
});
