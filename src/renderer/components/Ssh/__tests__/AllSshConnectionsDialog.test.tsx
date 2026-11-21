/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';

jest.mock('../../../api/tauri-bridge', () => ({ __esModule: true, default: {} }));
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: new Map() }));
jest.mock('../../../services/TerminalService', () => ({ terminalService: {} }));

import { store } from '../../../store';
import { applyView, loadFailed } from '../../../store/slices/sshSlice';
import { setShellProfiles } from '../../../store/slices/settingsSlice';
import { button, key, preparePicker, replaceSaved, saved } from '../../../__testFixtures__/sshPickerFixture';
import { NewTabDropdown } from '../../NewTabDropdown';
import { AllSshConnectionsDialog, SshConnectionsDialogHost } from '../AllSshConnectionsDialog';

let root: Root;
let container: HTMLDivElement;
let api: ReturnType<typeof preparePicker>;
const launch = jest.fn((_id: string): string | null => null);
const onClose = jest.fn();
const search = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const active = () => document.getElementById(search().getAttribute('aria-activedescendant') ?? '')?.textContent;
const invoker = () => container.querySelector<HTMLButtonElement>('[aria-label="New tab options"]')!;
const render = (ui: React.ReactNode) => act(() => root.render(<Provider store={store}>{ui}</Provider>));
const mountDialog = () => render(<AllSshConnectionsDialog request={{ invoker: null, launch }} onClose={onClose} />);

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api = preparePicker();
  launch.mockClear();
  onClose.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test('arrow_home_end_enter_launch_exact_active_id_once', () => {
  // AllSshConnectionsDialog: reverse the onResultsKey index direction or remove submitted.current.
  replaceSaved([saved('one'), saved('two'), saved('three')]);
  mountDialog();
  act(() => { key(search(), 'ArrowDown'); });
  expect(active()).toContain('two.example');
  expect(document.activeElement).toBe(search());
  act(() => { key(search(), 'ArrowUp'); });
  expect(active()).toContain('one.example');
  act(() => { key(search(), 'End'); });
  expect(active()).toContain('three.example');
  act(() => { key(search(), 'Home'); });
  expect(active()).toContain('one.example');
  act(() => { key(search(), 'End'); });
  act(() => { key(search(), 'Enter'); key(search(), 'Enter'); });
  expect(launch.mock.calls).toEqual([['three']]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('empty_ime_repeat_and_deleted_selection_never_launch', () => {
  // AllSshConnectionsDialog: remove the current-store id check, no-active or IME/repeat guard.
  mountDialog();
  act(() => { key(search(), 'Enter'); });
  expect(search().hasAttribute('aria-activedescendant')).toBe(false);
  expect(launch).not.toHaveBeenCalled();
  act(() => { replaceSaved([saved('old')]); });
  act(() => {
    key(search(), 'Enter', { isComposing: true });
    key(search(), 'Enter', { repeat: true });
  });
  expect(launch).not.toHaveBeenCalled();
  act(() => {
    replaceSaved([saved('new')]);
    key(search(), 'Enter'); // Render still shows old; never substitute new during activation.
  });
  expect(launch).not.toHaveBeenCalled();
  expect(active()).toContain('new.example');
  act(() => { key(search(), 'Enter'); });
  expect(launch.mock.calls).toEqual([['new']]);
});

test('tablist_arrows_do_not_eat_search_caret', () => {
  // AllSshConnectionsDialog: scope onFilterKey to the tablist, not the dialog.
  replaceSaved([saved('one'), saved('two', { bookmarked: true })]);
  mountDialog();
  let found!: KeyboardEvent;
  act(() => { found = key(search(), 'ArrowLeft'); });
  expect(found.defaultPrevented).toBe(false);
  const all = button('All', document.querySelector('[role="tablist"]')!);
  expect(all.getAttribute('aria-selected')).toBe('true');
  act(() => { all.focus(); key(all, 'ArrowRight'); });
  const bookmarked = button('Bookmarked');
  expect(document.activeElement).toBe(bookmarked);
  expect(bookmarked.getAttribute('aria-selected')).toBe('true');
  expect(active()).toContain('two.example');
});

function openFromMenu() {
  render(<SshConnectionsDialogHost><NewTabDropdown /></SshConnectionsDialogHost>);
  act(() => { invoker().click(); });
  const row = button('All SSH Connections…');
  act(() => { row.focus(); row.click(); });
  expect(row.isConnected).toBe(false);
}

test('escape_restores_invoker_and_writes_nothing', () => {
  // AllSshConnectionsDialog: remove returnFocus: request.invoker.
  replaceSaved([saved('one')]);
  openFromMenu();
  expect(document.activeElement).toBe(search());
  act(() => { key(search(), 'Escape'); });
  expect(search()).toBeNull();
  expect(document.activeElement).toBe(invoker());
  expect(api.ssh.markUsed).not.toHaveBeenCalled();
  expect(api.ssh.launchTerminal).not.toHaveBeenCalled();
});

test('focus_is_trapped_and_popup_survives_origin_menu_close', () => {
  // SshConnectionsDialogHost: move the modal into the menu; or disable useDialogA11y trapping.
  replaceSaved([saved('one')]);
  openFromMenu();
  expect(container.querySelector('.dropdown-menu')).toBeNull();
  expect(document.activeElement).toBe(search());
  act(() => { key(search(), 'Tab', { shiftKey: true }); });
  expect(document.activeElement).toBe(button('Connect', document.querySelector('.ssh-picker')!));
  act(() => { key(document.activeElement!, 'Tab'); });
  expect(document.activeElement).toBe(search());
});

test('picker_explains_availability_and_never_launches_from_a_read_only_view', () => {
  // sshPickerUnavailable: ignore the missing profile, read-only store, or 067 bridge prerequisite.
  replaceSaved([saved('one', { bookmarked: true })]);
  store.dispatch(setShellProfiles([]));
  openFromMenu();
  const dialog = document.querySelector('.ssh-picker')!;
  expect(dialog.textContent).toContain('No default shell profile is available for SSH.');
  expect(button('Connect', dialog).disabled).toBe(true);
  act(() => { key(search(), 'Enter'); key(search(), 'Escape'); });

  api = preparePicker();
  openFromMenu();
  act(() => {
    const revision = store.getState().ssh.revision + 1;
    store.dispatch(applyView({ revision, view: {
      revision, folders: [], connections: [saved('one')],
      loadError: { code: 'StoreUnavailable', message: 'Store is read-only.' },
    } }));
  });
  expect(document.querySelector('.ssh-picker')?.textContent).toContain('Store is read-only.');
  act(() => { store.dispatch(loadFailed({ message: 'Cannot load saved connections.' })); });
  expect(document.querySelector('.ssh-picker')?.textContent).toContain('Cannot load saved connections.');
  act(() => {
    Object.assign(api, { sshSessionOpen: undefined });
    replaceSaved([saved('one')]);
  });
  expect(document.querySelector('.ssh-picker')?.textContent).toContain('requires desktop host verification support');
  expect(api.ssh.markUsed).not.toHaveBeenCalled();
});

test('lower_revision_event_cannot_resurrect_deleted_row', () => {
  // sshSlice: invert the revision guard before applying the view.
  replaceSaved([saved('old'), saved('kept')]);
  mountDialog();
  const revision = store.getState().ssh.revision;
  act(() => { replaceSaved([saved('kept')]); });
  act(() => { replaceSaved([saved('old'), saved('kept')], [], revision); });
  expect(Array.from(document.querySelectorAll('[role=option]')).map(el => el.textContent)).toEqual([
    'kepttester@kept.example · Top level',
  ]);
  act(() => { key(search(), 'Enter'); });
  expect(launch.mock.calls).toEqual([['kept']]);
});
