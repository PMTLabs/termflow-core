/**
 * @jest-environment jsdom
 *
 * Plan 045 T7/T9. `initAdminTabSupport`/`adminTabSupport` are a cached-fetch
 * pair like `initProfileScope`/`currentProfile` — tested the same way, via the
 * `__set...ForTests` seam, per `profileScope.test.ts`.
 */
jest.mock('../../api/tauri-bridge', () => ({ __esModule: true, default: {} }));

import { store } from '../../store';
import { addTab, clearAllTabs } from '../../store/slices/tabsSlice';
import type { ShellProfile } from '../../store/slices/settingsSlice';
import {
  adminTabSupport,
  adminTabTooltip,
  initAdminTabSupport,
  nativeProfilesForAdmin,
  openAdminTabWithProfile,
  __setAdminTabSupportForTests,
} from '../adminTabActions';

afterEach(() => {
  store.dispatch(clearAllTabs());
  __setAdminTabSupportForTests({ supported: false, reason: 'not-windows' });
});

const profile = (over: Partial<ShellProfile>): ShellProfile => ({
  id: 'p', name: 'Profile', path: 'p.exe', args: [], env: {}, ...over,
});

describe('nativeProfilesForAdmin', () => {
  it('excludes WSL-detected profiles and keeps everything else', () => {
    const profiles = [
      profile({ id: 'pwsh', name: 'PowerShell 7', is_wsl: false }),
      profile({ id: 'wsl-ubuntu', name: 'Ubuntu', is_wsl: true }),
      // A custom profile that happens to run wsl.exe is NOT excluded — is_wsl
      // is set only by detect_wsl_distributions, never by naming/path heuristics
      // (plan 045 §4.3, a deliberate decision, not an oversight).
      profile({ id: 'custom-wsl-ish', name: 'My WSL Thing', path: 'wsl.exe', is_wsl: false }),
    ];
    const result = nativeProfilesForAdmin({ settings: { shellProfiles: profiles } });
    expect(result.map((p) => p.id)).toEqual(['pwsh', 'custom-wsl-ish']);
  });

  it('treats a missing is_wsl as native (matches #[serde(default)] on the wire)', () => {
    const profiles = [profile({ id: 'legacy' })];
    delete (profiles[0] as { is_wsl?: boolean }).is_wsl;
    expect(nativeProfilesForAdmin({ settings: { shellProfiles: profiles } })).toHaveLength(1);
  });
});

describe('adminTabTooltip', () => {
  it('maps every non-ok reason to a distinct, non-empty string', () => {
    const reasons = ['not-windows', 'already-elevated', 'sidecar-disabled', 'killed'] as const;
    const texts = reasons.map(adminTabTooltip);
    expect(texts.every((t) => t.length > 0)).toBe(true);
    expect(new Set(texts).size).toBe(reasons.length);
  });

  it('is empty for the supported reason', () => {
    expect(adminTabTooltip('ok')).toBe('');
  });
});

describe('initAdminTabSupport / adminTabSupport', () => {
  it('caches whatever the backend returns', async () => {
    const invoke = jest.fn().mockResolvedValue({ supported: true, reason: 'ok' });
    const result = await initAdminTabSupport(invoke);
    expect(result).toEqual({ supported: true, reason: 'ok' });
    expect(adminTabSupport()).toEqual({ supported: true, reason: 'ok' });
    expect(invoke).toHaveBeenCalledWith('get_admin_tab_support');
  });

  it('treats a rejected/malformed response as unsupported rather than throwing', async () => {
    const invoke = jest.fn().mockRejectedValue(new Error('no such command'));
    await expect(initAdminTabSupport(invoke)).resolves.toEqual(expect.objectContaining({ supported: false }));
  });

  it('is a no-op default when no invoke is available (browser/non-Tauri)', async () => {
    const result = await initAdminTabSupport(undefined);
    expect(result.supported).toBe(false);
  });
});

describe('openAdminTabWithProfile', () => {
  it('dispatches addTab with elevated:true and the requested profile', () => {
    openAdminTabWithProfile(profile({ id: 'pwsh', name: 'PowerShell 7' }));
    const tab = store.getState().tabs.tabs.at(-1)!;
    expect(tab.shellType).toBe('pwsh');
    expect(tab.title).toBe('PowerShell 7');
    expect(tab.elevated).toBe(true);
    expect(tab.id).toMatch(/^tb-/);
  });

  it('makes the title unique against existing tabs, like an ordinary new tab', () => {
    openAdminTabWithProfile(profile({ id: 'pwsh', name: 'PowerShell 7' }));
    openAdminTabWithProfile(profile({ id: 'pwsh', name: 'PowerShell 7' }));
    const titles = store.getState().tabs.tabs.map((t) => t.title);
    expect(titles).toEqual(['PowerShell 7', 'PowerShell 7 1']);
  });

  it('inserts immediately after afterTabId when given', () => {
    store.dispatch(addTab({ id: 'tb-a', title: 'A', shellType: 'default' }));
    store.dispatch(addTab({ id: 'tb-b', title: 'B', shellType: 'default' }));
    openAdminTabWithProfile(profile({ id: 'pwsh', name: 'PowerShell 7' }), 'tb-a');
    const ids = store.getState().tabs.tabs.map((t) => t.id);
    expect(ids[0]).toBe('tb-a');
    expect(ids[2]).toBe('tb-b');
    expect(ids[1]).not.toBe('tb-a');
    expect(ids[1]).not.toBe('tb-b');
  });
});
