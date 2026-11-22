/**
 * @jest-environment jsdom
 *
 * Plan 045 T10. Pure builder, tested the same way `snippetsHistoryMenu.ts`'s
 * builders are — no React, no mounted `TerminalDisplay` (documented elsewhere
 * as unmountable under this repo's root Jest config).
 */
jest.mock('../../../api/tauri-bridge', () => ({ __esModule: true, default: {} }));

import { store } from '../../../store';
import { clearAllTabs } from '../../../store/slices/tabsSlice';
import type { ShellProfile } from '../../../store/slices/settingsSlice';
import { __setAdminTabSupportForTests } from '../../../services/adminTabActions';
import { adminTabMenuItem } from '../adminTabMenuItem';
import { ShellProfileIcon } from '../ShellProfileIcon';
import type { ReactElement } from 'react';

afterEach(() => {
  store.dispatch(clearAllTabs());
  __setAdminTabSupportForTests({ supported: false, reason: 'not-windows' });
});

const profile = (over: Partial<ShellProfile>): ShellProfile => ({
  id: 'p', name: 'Profile', path: 'p.exe', args: [], env: {}, ...over,
});

describe('adminTabMenuItem', () => {
  it('renders disabled with the reason tooltip and no submenu when unsupported', () => {
    __setAdminTabSupportForTests({ supported: false, reason: 'already-elevated' });
    const item = adminTabMenuItem([profile({ id: 'pwsh' })]);
    expect(item.enabled).toBe(false);
    expect(item.title).toBe('Already running as Administrator');
    expect(item.submenu).toBeUndefined();
  });

  it('offers a submenu of native profiles, excluding WSL, when supported', () => {
    __setAdminTabSupportForTests({ supported: true, reason: 'ok' });
    const item = adminTabMenuItem([
      profile({ id: 'pwsh', name: 'PowerShell 7' }),
      profile({ id: 'wsl-ubuntu', name: 'Ubuntu', is_wsl: true }),
    ]);
    expect(item.enabled).not.toBe(false);
    const rows = item.submenu!.rows as { id: string; label: string }[];
    expect(rows.map((r) => r.label)).toEqual(['PowerShell 7']);
  });

  it('rows carry the real binary icon, not a bare emoji (audit should-fix #9)', () => {
    __setAdminTabSupportForTests({ supported: true, reason: 'ok' });
    const item = adminTabMenuItem([profile({ id: 'git-bash', name: 'Git Bash', path: 'C:\\Git\\bin\\bash.exe' })]);
    const rows = item.submenu!.rows as { icon?: unknown }[];
    // The SAME component the tab strip and canvas sidebar draw — so this flyout
    // can't drift to a glyph the other surfaces don't show. A string here is
    // the regression: `profileEmoji()` alone, no `getCachedIcon`/`loadIcon`.
    const icon = rows[0].icon as ReactElement<{ shellType: string; emoji?: string }>;
    expect(typeof icon).not.toBe('string');
    expect(icon.type).toBe(ShellProfileIcon);
    expect(icon.props.shellType).toBe('git-bash');
    expect(icon.props.emoji).toBe('🌿');
  });

  it('shows an empty-state row when there are no native profiles', () => {
    __setAdminTabSupportForTests({ supported: true, reason: 'ok' });
    const item = adminTabMenuItem([profile({ id: 'wsl-ubuntu', is_wsl: true })]);
    const rows = item.submenu!.rows as unknown[];
    expect(rows).toHaveLength(0);
    expect(item.submenu!.emptyRow).toBeTruthy();
  });

  it('a row pick opens an elevated tab for that profile', () => {
    __setAdminTabSupportForTests({ supported: true, reason: 'ok' });
    const item = adminTabMenuItem([profile({ id: 'pwsh', name: 'PowerShell 7' })]);
    const rows = item.submenu!.rows as { onSelect?: () => void }[];
    rows[0].onSelect?.();
    const tab = store.getState().tabs.tabs.at(-1)!;
    expect(tab.shellType).toBe('pwsh');
    expect(tab.elevated).toBe(true);
  });
});
