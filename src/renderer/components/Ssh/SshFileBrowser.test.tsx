/** @jest-environment jsdom */
// The real store pulls TerminalContainer -> tauri-bridge; cut that chain like the pane transfer tests.
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
import path from 'path';
import { readSource } from '../../utils/readSource';
import { SSH_PANE_CHROME_H } from './SshPaneShell';
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
import type { CwdEvent, EditNotice, EditOpen, FsRequest, RemoteListing, RemoteStat } from './sshFileTypes';
import { writeClipboardText } from '../../utils/clipboard';
import { terminalService } from '../../services/TerminalService';

jest.mock('../../utils/clipboard', () => ({ writeClipboardText: jest.fn() }));
jest.mock('../../services/TerminalService', () => ({ terminalService: { writeToTerminal: jest.fn() } }));

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
  { name: '.env', path: `${path}/.env`, kind: 'file', size: '1', mtime: 1 },
  { name: 'logs', path: `${path}/logs`, kind: 'directory' },
] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(callback => { resolve = callback; });
  return { promise, resolve };
}

function createBridge() {
  let editListener: ((event: EditNotice) => void) | undefined;
  let cwd: ((event: CwdEvent) => void) | undefined;
  return {
    fsList: jest.fn(async ({ path, expectedGeneration }: FsRequest) => listing(path, expectedGeneration)),
    fsCreate: jest.fn(async (_request: FsRequest) => {}), fsMkdir: jest.fn(async (_request: FsRequest) => {}),
    fsStat: jest.fn(async ({ path }: FsRequest): Promise<RemoteStat> => ({
      name: path.split('/').pop()!, path, kind: 'file', mode: 0o104640, uid: 100, gid: 200,
    })),
    fsChown: jest.fn(async (_request: FsRequest & { uid?: number; gid?: number }) => {}),
    fsChmod: jest.fn(async (_request: FsRequest & { mode: number }) => {}),
    fsRename: jest.fn(async (_request: FsRequest & { newPath: string }) => {}),
    fsDelete: jest.fn(async (_request: FsRequest & { recursive: boolean; confirmed: boolean }) => {}),
    fsOpen: jest.fn(async (_request: FsRequest): Promise<EditOpen> => ({ state: 'cancelled' })),
    fsOpenWith: jest.fn(async (_request: FsRequest): Promise<EditOpen> => ({ state: 'cancelled' })),
    fsDownload: jest.fn(async (_request: FsRequest) => ({ status: 'cancelled' as const })),
    fsInsertPath: jest.fn(async (_request: FsRequest) => ({ written: true })),
    onFsEditState: jest.fn(async (cb: (event: EditNotice) => void) => { editListener = cb; return () => { editListener = undefined; }; }),
    emitEdit(event: EditNotice) { editListener?.(event); },
    fsEditList: jest.fn(async () => []),
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
  .find(button => button.getAttribute('aria-label') === label || button.textContent === label)!;
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
  jest.mocked(writeClipboardText).mockReset().mockResolvedValue(undefined);
  jest.mocked(terminalService.writeToTerminal).mockClear();
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
    expect(button('Reconnect')).toBeUndefined();
    if (session.state === 'disconnected') act(() => button('Details').click());
    expect([...container.querySelectorAll('button')].filter(b => b.textContent === 'Reconnect')).toHaveLength(session.state === 'disconnected' ? 1 : 0);
  }
  expect(container.textContent).toContain('Stale');
  act(() => button('Collapse file browser').click());
  tag = { ...tag, browserCollapsed: true };
  act(() => shell(view('disconnected', 1, 3)));
  expect(button('Expand file browser').closest('aside')?.classList.contains('collapsed')).toBe(true);
  expect(container.querySelector('.terminal-display')).toBe(host);
  act(() => button('Details').click());
  expect([...container.querySelectorAll('button')].filter(b => b.textContent === 'Reconnect')).toHaveLength(1);
});

test('SSH notice strip CSS reserves one fixed in-flow row', () => {
  const css = readSource(path.join(__dirname, 'SshPaneShell.css'));
  const row = css.match(/\.ssh-pane-chrome\s*\{([^}]+)\}/)![1];
  expect(row).not.toMatch(/position:\s*(absolute|fixed)|(?:min|max)-height:/);
  expect(row).toMatch(/box-sizing:\s*border-box/);
  expect(row).toMatch(/flex:\s*none/);
  expect(row).toContain(`height:${SSH_PANE_CHROME_H}px;`);
  expect(css).not.toMatch(/\.ssh-pane-chrome:empty/);
});

test('three SSH edits cannot cover toolbar; zero to three to zero preserves the host layout', async () => {
  await act(async () => shell(view('connected')));
  const chrome = container.querySelector('.ssh-pane-chrome')!;
  const host = container.querySelector('.ssh-terminal-host')!;
  const layout = (el: Element) => [el.className, el.getAttribute('style')];
  const baseline = [layout(chrome), layout(host)];
  const edits = [1, 2, 3].map(n => ({
    terminalId, editId: `edit-${n}`, path: `/home/file-${n}`, state: 'watching' as const, sessionGeneration: 1,
  }));
  const expectStable = () => {
    expect(container.querySelector('.ssh-pane-chrome')).toBe(chrome);
    expect(container.querySelector('.ssh-terminal-host')).toBe(host);
    expect([layout(chrome), layout(host)]).toEqual(baseline);
  };
  act(() => edits.forEach(edit => api.emitEdit(edit)));
  expectStable();
  const body = chrome.nextElementSibling!;
  expect(body.className).toBe('ssh-pane-body');
  for (const control of [button('Refresh'), pathBox(), [...container.querySelectorAll('label')].find(label => label.textContent?.includes('Follow cd'))?.control]) {
    expect(control).toBeTruthy();
    expect(body.contains(control!)).toBe(true);
  }
  expect(container.querySelector('.ssh-pane-popover')).toBeNull();
  expect(chrome.textContent).toContain('/home/file-3 — watching');
  expect(chrome.textContent).toContain('+2 more');
  act(() => button('+2 more').click());
  expect(container.querySelectorAll('.ssh-pane-popover li')).toHaveLength(3);
  expectStable();
  act(() => button('Close SSH notices').click());
  act(() => edits.forEach(edit => api.emitEdit({ ...edit, state: 'stopped' })));
  expectStable();
  expect(chrome.textContent).toBe('');
});

test('SSH notice popover opens explicitly and restores focus on Escape and outside click', async () => {
  await act(async () => shell(view('connected')));
  act(() => api.emitEdit({ terminalId, editId: 'edit-1', path: '/home/file', state: 'watching', sessionGeneration: 1 }));
  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"][aria-label="SSH notices"]');
  const invoker = button('Details');
  expect(dialog()).toBeNull();
  act(() => invoker.click());
  expect(dialog()?.textContent).toContain('/home/file');
  act(() => dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(invoker);
  act(() => invoker.click());
  // An outside click closes without pulling focus back: the user moved it on purpose.
  act(() => { pathBox().focus(); pathBox().click(); });
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(pathBox());
});

test('collapse_only_patches_target_tag_and_never_hidden_metrics', async () => {
  tag = { ...tag, browserCollapsed: true, browserPath: '/saved', followCd: true };
  await act(async () => shell(view('connected')));
  expect(api.fsList).not.toHaveBeenCalled(); expect(api.onFsCwd).toHaveBeenCalledTimes(1); // shell edit-warning subscription only
  act(() => button('Expand file browser').click());
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
  act(() => button('Details').click());
  await act(async () => button('Reconnect').click());
  expect(reconnect).toHaveBeenCalledWith(terminalId); expect(fallback).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Return to the local prompt to reconnect');
});

const row = (name = '.env') => [...container.querySelectorAll<HTMLButtonElement>('.ssh-file-name')]
  .find(el => el.lastChild?.textContent === name)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const entryRequest = { terminalId, path: '/home/.env', expectedGeneration: 1 };
const field = (name: string) => [...dialog().querySelectorAll('label')]
  .find(label => label.textContent?.trim() === name)!.querySelector('input')!;
const mouse = (target: Element, type: string, button: number) => {
  const event = new MouseEvent(type, { button, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};
const menuButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  .find(el => el.querySelector('.context-menu-label')?.textContent === label)!;
async function choose(label: string, name?: string) {
  act(() => { mouse(row(name).parentElement!, 'contextmenu', 2); });
  await act(async () => menuButton(label).click());
}
const key = (target: Element, key: string, shiftKey = false) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));

test('right_clicked_B_becomes_selected_and_is_target_for_every_menu_action', async () => {
  await act(async () => render());
  // A parent outside the React root observes whether the event escaped the file row.
  const ancestor = jest.fn();
  container.parentElement!.addEventListener('contextmenu', ancestor, { once: true });
  const selectA = () => act(() => row('logs').click());
  selectA();
  await choose('Open'); expect(api.fsOpen).toHaveBeenCalledWith(entryRequest);
  expect(ancestor).not.toHaveBeenCalled();
  container.parentElement!.removeEventListener('contextmenu', ancestor);
  // D109: right-click moves the selection to the row the menu acts on.
  expect(row().getAttribute('aria-pressed')).toBe('true');
  expect(row('logs').getAttribute('aria-pressed')).toBe('false');
  await choose('Open with…'); expect(api.fsOpenWith).toHaveBeenCalledWith(entryRequest);
  await choose('Download…'); expect(api.fsDownload).toHaveBeenCalledWith(entryRequest);
  await choose('Copy path'); expect(writeClipboardText).toHaveBeenCalledWith(entryRequest.path);
  await choose('Insert path'); expect(api.fsInsertPath).toHaveBeenCalledWith(entryRequest);
  await choose('Properties'); expect(api.fsStat).toHaveBeenLastCalledWith(entryRequest);
  act(() => button('Close', dialog()).click());
  await choose('Permissions…'); expect(api.fsStat).toHaveBeenLastCalledWith(entryRequest);
  act(() => { input(field('UID'), '101'); input(field('Octal mode'), '4600'); });
  await act(async () => { submit(dialog().querySelector('form')!); });
  expect(api.fsChown).toHaveBeenCalledWith({ ...entryRequest, uid: 101 });
  expect(api.fsChmod).toHaveBeenCalledWith({ ...entryRequest, mode: 0o4600 });
  await choose('Rename');
  act(() => input(field('New name'), 'changed'));
  await act(async () => { submit(dialog().querySelector('form')!); });
  expect(api.fsRename).toHaveBeenCalledWith({ ...entryRequest, newPath: '/home/changed' });
  selectA();
  await choose('Delete…');
  await act(async () => button('Delete', dialog()).click());
  expect(api.fsDelete).toHaveBeenCalledWith({ ...entryRequest, recursive: false, confirmed: true });
});

test('right_click_selects_and_focuses_the_row_without_opening_it', async () => {
  await act(async () => render());
  const selected = (name: string) => row(name).getAttribute('aria-pressed') === 'true'
    && row(name).parentElement!.getAttribute('data-selected') === 'true';
  const menu = () => document.querySelector('[role="menu"]');
  act(() => row().click());
  expect(selected('.env')).toBe(true);
  const listCalls = api.fsList.mock.calls.length;

  // 1-3: a folder is selected, focused and stays highlighted under the open menu, but not opened.
  act(() => { mouse(row('logs').parentElement!, 'contextmenu', 2); });
  expect(menu()).not.toBeNull();
  expect(selected('logs')).toBe(true);
  expect(selected('.env')).toBe(false);
  expect(menu()!.contains(document.activeElement)).toBe(true);
  expect(api.fsList).toHaveBeenCalledTimes(listCalls);
  expect(pathBox().value).toBe('/home');
  expect(button('Expand logs').getAttribute('aria-expanded')).toBe('false');

  // 2 + 4: Escape closes the menu, keeps the selection and returns keyboard focus to that row.
  // async act: ContextMenu hands focus back to its invoker in a microtask after unmount.
  await act(async () => { key(document.activeElement!, 'Escape'); });
  expect(menu()).toBeNull();
  expect(selected('logs')).toBe(true);
  expect(document.activeElement).toBe(row('logs'));

  // 1 for a file: right-click selects it without opening; an outside click closes and keeps it.
  act(() => { mouse(row().parentElement!, 'contextmenu', 2); });
  expect(selected('.env')).toBe(true);
  expect(selected('logs')).toBe(false);
  expect(api.fsOpen).not.toHaveBeenCalled();
  act(() => { mouse(document.body, 'mousedown', 0); });
  expect(menu()).toBeNull();
  expect(selected('.env')).toBe(true);

  // 5: right-clicking empty space in the list changes nothing.
  act(() => { mouse(container.querySelector('.ssh-file-rows')!, 'contextmenu', 2); });
  expect(menu()).toBeNull();
  expect(selected('.env')).toBe(true);
  expect(selected('logs')).toBe(false);
});

test('right_click_on_an_unusable_row_opens_the_menu_without_selecting', async () => {
  await act(async () => render());
  act(() => observe(view('disconnected', 1, 2), snapshot(1, 'ended')));
  act(() => { mouse(row().parentElement!, 'contextmenu', 2); });
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(row().getAttribute('aria-pressed')).toBe('false');
  expect(row().parentElement!.getAttribute('data-selected')).toBe('false');
});

test('folder_open_disabled_but_download_enabled', async () => {
  await act(async () => render());
  act(() => { mouse(row('logs').parentElement!, 'contextmenu', 2); });
  expect(menuButton('Open').disabled).toBe(true);
  expect(menuButton('Open with…').title).toMatch(/regular files/);
  expect(menuButton('Download…').disabled).toBe(false);
  expect(menuButton('Delete…').classList.contains('danger')).toBe(true);
  expect([...document.querySelector('[role="menu"]')!.children].map(el =>
    el.getAttribute('role') === 'separator' ? '|' : el.querySelector('.context-menu-label')?.textContent)).toEqual([
    'Open', 'Open with…', 'Download…', '|', 'Copy path', 'Insert path', '|',
    'Rename', 'Delete…', '|', 'Properties', 'Permissions…',
  ]);
});

test('disconnected_menu_and_middle_click_make_no_calls', async () => {
  await act(async () => render());
  act(() => { mouse(row().parentElement!, 'contextmenu', 2); });
  act(() => observe(view('disconnected', 1, 2), snapshot(1, 'ended')));
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  expect(items).toHaveLength(9);
  act(() => {
    items.forEach(item => { expect(item.disabled && item.title).toBeTruthy(); item.click(); });
    expect(mouse(row().parentElement!, 'mousedown', 1).defaultPrevented).toBe(true);
    expect(mouse(row().parentElement!, 'auxclick', 1).defaultPrevented).toBe(true);
  });
  for (const command of [api.fsOpen, api.fsOpenWith, api.fsDownload, api.fsInsertPath,
    api.fsRename, api.fsDelete, api.fsStat, api.fsChown, api.fsChmod, writeClipboardText]) {
    expect(command).not.toHaveBeenCalled();
  }
  expect(dialog()).toBeNull();
});

test('middle_pointer_and_auxclick_insert_only_once', async () => {
  await act(async () => render());
  await act(async () => {
    expect(mouse(row(), 'mousedown', 1).defaultPrevented).toBe(true);
    expect(mouse(row(), 'auxclick', 1).defaultPrevented).toBe(true);
  });
  expect(api.fsInsertPath).toHaveBeenCalledTimes(1);
});

test('insert_sends_to_own_terminal_not_broadcast_and_has_no_CR_LF', async () => {
  await act(async () => render());
  await choose('Insert path');
  expect(api.fsInsertPath).toHaveBeenCalledTimes(1);
  expect(api.fsInsertPath).toHaveBeenCalledWith(entryRequest);
  expect(api.fsInsertPath.mock.calls[0][0].path).not.toMatch(/[\r\n]/);
  expect(terminalService.writeToTerminal).not.toHaveBeenCalled();
});

test('clipboard_failure_has_no_copied_toast', async () => {
  await act(async () => render());
  const clipboard = deferred<void>();
  jest.mocked(writeClipboardText).mockReturnValueOnce(clipboard.promise.then(() => { throw new Error('denied'); }));
  await choose('Copy path');
  expect(toasts()).toHaveLength(0);
  await act(async () => clipboard.resolve());
  expect(toasts()).toEqual([expect.objectContaining({ type: 'error', message: 'Could not copy the remote path.' })]);
});

test('properties_stat_targets_context_item_and_renders_missing_attrs_as_unavailable', async () => {
  await act(async () => render());
  api.fsStat.mockResolvedValueOnce({ name: '.env', path: entryRequest.path, kind: 'file' });
  await choose('Properties');
  expect(api.fsStat).toHaveBeenCalledWith(entryRequest);
  expect(dialog().textContent).toContain(entryRequest.path);
  const fields = [...dialog().querySelectorAll('dd')].map(el => el.textContent);
  expect(fields).toContain('Unavailable : Unavailable');
  expect(fields.filter(value => value === 'Unavailable').length).toBeGreaterThanOrEqual(4);
});

test('octal_checkboxes_roundtrip_and_preserve_special_bits', async () => {
  await act(async () => render());
  await choose('Permissions…');
  const mode = field('Octal mode');
  const execute = dialog().querySelector<HTMLInputElement>('[aria-label="Group execute"]')!;
  expect(mode.value).toBe('4640');
  act(() => execute.click());
  expect(mode.value).toBe('4650');
  act(() => input(mode, '2750'));
  expect(execute.checked).toBe(true);
  act(() => execute.click());
  expect(mode.value).toBe('2740');
  await act(async () => { submit(mode.form!); });
  expect(api.fsChmod).toHaveBeenCalledWith({ ...entryRequest, mode: 0o2740 });
  expect(api.fsChown).not.toHaveBeenCalled();
});

const denied = { code: 'permissionDenied', outcome: 'unchanged', message: 'Permission denied. Nothing was changed.' };
async function submitPermissionChanges() {
  await choose('Permissions…');
  act(() => { input(field('UID'), '101'); input(field('Octal mode'), '4600'); });
  await act(async () => { submit(dialog().querySelector('form')!); });
}

test('ownership_denied_does_not_send_chmod_and_keeps_dialog', async () => {
  await act(async () => render());
  api.fsChown.mockRejectedValueOnce(denied);
  await submitPermissionChanges();
  expect(api.fsChown).toHaveBeenCalledWith({ ...entryRequest, uid: 101 });
  expect(api.fsChmod).not.toHaveBeenCalled();
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Nothing was changed');
});

test('chmod_denied_after_chown_shows_partial_not_nothing_changed', async () => {
  await act(async () => render());
  api.fsChmod.mockRejectedValueOnce(denied);
  await submitPermissionChanges();
  expect(api.fsChown.mock.invocationCallOrder[0]).toBeLessThan(api.fsChmod.mock.invocationCallOrder[0]);
  expect(api.fsStat).toHaveBeenCalledTimes(2);
  const message = dialog().querySelector('[role="alert"]')?.textContent;
  expect(message).toContain('Partially completed: ownership changed');
  expect(message).not.toContain('Nothing was changed');
});

test('recursive_delete_cancel_no_request_confirm_exact_target', async () => {
  await act(async () => render());
  act(() => row().click());
  await choose('Delete…', 'logs');
  expect(dialog().textContent).toContain('/home/logs');
  expect(dialog().textContent).toContain('recursively');
  expect(document.activeElement).toBe(button('Cancel', dialog()));
  act(() => button('Cancel', dialog()).click());
  expect(api.fsDelete).not.toHaveBeenCalled();
  await choose('Delete…', 'logs');
  await act(async () => button('Delete', dialog()).click());
  expect(api.fsDelete).toHaveBeenCalledWith({ ...entryRequest, path: '/home/logs', recursive: true, confirmed: true });
});

test('late_completion_of_a_hidden_dialog_does_not_close_its_replacement', async () => {
  await act(async () => render());
  const pending = deferred<void>();
  api.fsDelete.mockImplementationOnce(() => pending.promise);
  await choose('Delete…', '.env');
  await act(async () => button('Delete', dialog()).click());
  expect(api.fsDelete).toHaveBeenCalledTimes(1);
  // Hiding the surface unmounts the pending delete dialog; the user then opens another one.
  await act(async () => render(false));
  await act(async () => render());
  api.fsStat.mockResolvedValueOnce({ name: '.env', path: entryRequest.path, kind: 'file' });
  await choose('Properties');
  expect(dialog().textContent).toContain('Properties');
  await act(async () => { pending.resolve(); await pending.promise; });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Properties');
});

test('all_ssh_dialogs_trap_tab_escape_and_restore_trigger_focus', async () => {
  await act(async () => render());
  const trapAndClose = (trigger: HTMLElement) => {
    const controls = [...dialog().querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')];
    act(() => {
      controls[0].focus();
      key(controls[0], 'Tab', true);
      const last = controls[controls.length - 1];
      expect(document.activeElement).toBe(last);
      key(last, 'Tab');
      expect(document.activeElement).toBe(controls[0]);
      key(controls[0], 'Escape');
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  };
  for (const action of ['Properties', 'Permissions…', 'Rename', 'Delete…']) {
    await choose(action);
    trapAndClose(row());
  }
  for (const label of ['New file', 'New folder']) {
    const trigger = button(label);
    act(() => { trigger.focus(); trigger.click(); });
    trapAndClose(trigger);
  }
});

test('invalid_name_never_invokes_create_or_rename', async () => {
  const form = await openCreate();
  act(() => { input(form.querySelector('input')!, '..'); submit(form); });
  expect(api.fsCreate).not.toHaveBeenCalled();
  expect(dialog().querySelector('[role="alert"]')).not.toBeNull();
  act(() => button('Cancel', dialog()).click());
  act(() => { key(pathBox(), 'F2'); key(pathBox(), 'Delete'); });
  expect(dialog()).toBeNull();
  act(() => key(row(), 'F2'));
  act(() => { const name = field('New name'); input(name, 'a/b'); submit(name.form!); });
  expect(api.fsRename).not.toHaveBeenCalled();
  expect(dialog().querySelector('[role="alert"]')).not.toBeNull();
});

test('rename_success_waits_for_ack_and_refresh', async () => {
  await act(async () => render());
  await choose('Rename');
  const ack = deferred<void>(), refreshed = deferred<RemoteListing>();
  api.fsRename.mockReturnValueOnce(ack.promise);
  api.fsList.mockReturnValueOnce(refreshed.promise);
  act(() => { const name = field('New name'); input(name, 'replacement'); submit(name.form!); });
  expect(api.fsList).toHaveBeenCalledTimes(1);
  expect(toasts()).toHaveLength(0);
  await act(async () => ack.resolve());
  expect(api.fsList).toHaveBeenLastCalledWith({ ...entryRequest, path: '/home' });
  expect(dialog()).not.toBeNull();
  expect(toasts()).toHaveLength(0);
  await act(async () => refreshed.resolve(listing()));
  expect(dialog()).toBeNull();
  expect(toasts()).toEqual([expect.objectContaining({ type: 'success', message: 'Remote entry renamed.' })]);
});

test('hidden_browser_menu_closes_on_keyboard_tab_change_without_focus_steal', async () => {
  await act(async () => render());
  act(() => { mouse(row().parentElement!, 'contextmenu', 2); });
  const nextTab = document.createElement('button');
  document.body.append(nextTab);
  try {
    await act(async () => { nextTab.focus(); render(false); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(nextTab);
  } finally { nextTab.remove(); }
});

test('open_result_reaches_the_shell_edit_warning', async () => {
  api.fsOpen.mockResolvedValueOnce({ state: 'needsEditor' });
  await act(async () => shell(view('connected')));
  await choose('Open');
  expect(button('Open editor settings')).toBeUndefined();
  act(() => button('Details').click());
  expect(button('Open editor settings')).toBeDefined();
  act(() => button('Close SSH notices').click());
  await choose('Open with…');
  expect(button('Open editor settings')).toBeUndefined();
});

test('control_path_insertion_disabled_but_copy_remains_exact', async () => {
  const path = '/home/with\nnewline';
  api.fsList.mockResolvedValueOnce({ ...listing(), entries: [{ name: '.env', path, kind: 'file' }] });
  await act(async () => render());
  act(() => { mouse(row().parentElement!, 'contextmenu', 2); });
  expect(menuButton('Insert path').title).toMatch(/control characters/);
  expect(menuButton('Insert path').disabled).toBe(true);
  await act(async () => { mouse(row(), 'mousedown', 1); menuButton('Copy path').click(); });
  expect(api.fsInsertPath).not.toHaveBeenCalled();
  expect(writeClipboardText).toHaveBeenCalledWith(path);
});
