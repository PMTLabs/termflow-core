/**
 * @jest-environment jsdom
 *
 * Plan 045 T9/T11/T12/T13. `AdminProfileList` is the shared row-rendering
 * logic for THREE of the four menu surfaces (PaneContextMenu, TabContextMenu,
 * NewTabDropdown) — covering it here covers the part of each surface that is
 * not bespoke to that surface's own toggle/section chrome.
 */
jest.mock('../../../api/tauri-bridge', () => ({ __esModule: true, default: {} }));

import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import settingsReducer, { setShellProfiles } from '../../../store/slices/settingsSlice';
import tabsReducer from '../../../store/slices/tabsSlice';
import panesReducer from '../../../store/slices/panesSlice';
import { AdminProfileList } from '../AdminProfileList';
import { __setAdminTabSupportForTests } from '../../../services/adminTabActions';
import type { ShellProfile } from '../../../store/slices/settingsSlice';

function makeStore(shellProfiles: ShellProfile[]) {
  const store = configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, settings: settingsReducer },
  });
  store.dispatch(setShellProfiles(shellProfiles));
  return store;
}

const profile = (over: Partial<ShellProfile>): ShellProfile => ({
  id: 'p', name: 'Profile', path: 'p.exe', args: [], env: {}, ...over,
});

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  __setAdminTabSupportForTests({ supported: true, reason: 'ok' });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __setAdminTabSupportForTests({ supported: false, reason: 'not-windows' });
});

const render = (variant: 'menu' | 'dropdown', profiles: ShellProfile[], onPick?: () => void) =>
  act(() => {
    root.render(
      <Provider store={makeStore(profiles)}>
        <AdminProfileList variant={variant} onPick={onPick} />
      </Provider>,
    );
  });

describe('AdminProfileList — menu variant', () => {
  it('renders one context-menu-item row per native profile, excluding WSL', () => {
    render('menu', [
      profile({ id: 'pwsh', name: 'PowerShell 7' }),
      profile({ id: 'wsl-ubuntu', name: 'Ubuntu', is_wsl: true }),
    ]);
    const rows = container.querySelectorAll('.context-menu-item');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('PowerShell 7');
  });

  it('renders a single disabled row with the reason tooltip when unsupported', () => {
    __setAdminTabSupportForTests({ supported: false, reason: 'already-elevated' });
    render('menu', [profile({ id: 'pwsh', name: 'PowerShell 7' })]);
    const rows = container.querySelectorAll<HTMLButtonElement>('.context-menu-item');
    expect(rows).toHaveLength(1);
    expect(rows[0].disabled).toBe(true);
    expect(rows[0].title).toBe('Already running as Administrator');
  });

  it('renders a disabled empty-state row when there are no native profiles', () => {
    render('menu', [profile({ id: 'wsl-ubuntu', is_wsl: true })]);
    const rows = container.querySelectorAll<HTMLButtonElement>('.context-menu-item');
    expect(rows).toHaveLength(1);
    expect(rows[0].disabled).toBe(true);
    expect(rows[0].textContent).toContain('No native shell profiles');
  });

  it('a pick opens an elevated tab and calls onPick', () => {
    const onPick = jest.fn();
    render('menu', [profile({ id: 'pwsh', name: 'PowerShell 7' })], onPick);
    const row = container.querySelector<HTMLButtonElement>('.context-menu-item')!;
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

describe('AdminProfileList — dropdown variant', () => {
  it('renders dropdown-item rows, and a disabled one when unsupported', () => {
    render('dropdown', [profile({ id: 'pwsh', name: 'PowerShell 7' })]);
    expect(container.querySelectorAll('.dropdown-item.disabled')).toHaveLength(0);
    expect(container.querySelector('.dropdown-item')!.textContent).toContain('PowerShell 7');

    __setAdminTabSupportForTests({ supported: false, reason: 'sidecar-disabled' });
    render('dropdown', [profile({ id: 'pwsh', name: 'PowerShell 7' })]);
    const disabledRow = container.querySelector('.dropdown-item.disabled')!;
    expect(disabledRow).toBeTruthy();
    expect(disabledRow.getAttribute('title')).toBe('Terminal sidecar is disabled');
  });
});
