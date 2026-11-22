/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

jest.mock('../SettingsPage.css', () => ({}));
jest.mock('../PeersPanel', () => ({ PeersPanel: () => null }));
jest.mock('../Automations/AutomationsPanel', () => ({ AutomationsPanel: () => null }));
jest.mock('../AboutLegalPanel', () => ({ AboutLegalPanel: () => null }));
jest.mock('../McpConnectModal', () => ({ McpConnectModal: () => null }));
jest.mock('../../UI/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
jest.mock('../../UI/UnsavedChangesDialog', () => ({ UnsavedChangesDialog: ({ isOpen }: { isOpen: boolean }) => isOpen ? <div data-testid="unsaved" /> : null }));
jest.mock('../../UI/SplitButton', () => ({ SplitButton: () => null }));
jest.mock('../../../services/openSettings', () => ({ consumePendingSettingsCategory: jest.fn() }));
jest.mock('../../../hooks/useSurfaceZoom', () => ({
    useSurfaceZoom: () => ({ zoom: 1, zoomIn: () => {}, zoomOut: () => {}, reset: () => {} }),
    useZoomGestures: () => {},
}));

import settingsReducer from '../../../store/slices/settingsSlice';
import { consumePendingSettingsCategory } from '../../../services/openSettings';
import { clearSettingsGuard, runSettingsGuard } from '../../../services/settingsNavGuard';
import { SettingsPage } from '../SettingsPage';

const pending = consumePendingSettingsCategory as jest.Mock;

describe('macOS Permissions category', () => {
    let root: Root;
    let container: HTMLDivElement;
    let saved: string | undefined;
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        saved = undefined;
        pending.mockReset().mockReturnValue(null);
        global.fetch = jest.fn(() => Promise.reject(new Error('offline'))) as never;
        (window as any).electronAPI = {
            getConfigValue: jest.fn(async (key: string) => key === 'settingsLastCategory' ? saved : undefined),
            setConfigValue: jest.fn(async () => {}),
        };
        container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount()); container.remove(); clearSettingsGuard();
        delete (window as any).electronAPI; jest.restoreAllMocks();
    });
    const platform = (name: string) => jest.spyOn(navigator, 'platform', 'get').mockReturnValue(name);
    const nav = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.settings-nav-item')].find(b => b.textContent?.trim() === label);
    const active = () => container.querySelector('.settings-nav-item.active')?.textContent?.trim();
    const content = () => container.querySelector('.settings-content-inner')?.textContent;
    async function render() {
        await act(async () => root.render(<Provider store={configureStore({ reducer: { settings: settingsReducer } })}><SettingsPage isActive /></Provider>));
    }
    async function click(label: string) { await act(async () => nav(label)!.click()); }
    async function deepLink() { await act(async () => window.dispatchEvent(new CustomEvent('settings:goto-category', { detail: 'permissions' }))); }

    it('shows and renders Permissions on macOS and leaves it without a dirty prompt', async () => {
        platform('MacIntel'); await render(); expect(nav('Permissions')).toBeDefined();
        await click('Permissions'); expect(active()).toBe('Permissions'); expect(content()).toContain('Allow Accessibility');
        expect(runSettingsGuard(jest.fn())).toBe(false);
        await click('Appearance'); expect(active()).toBe('Appearance'); expect(container.querySelector('[data-testid="unsaved"]')).toBeNull();
    });
    it.each(['Win32', 'Linux x86_64'])('hides the category and falls back for restore and both deep-link routes on %s', async name => {
        platform(name); saved = 'permissions'; await render();
        expect(nav('Permissions')).toBeUndefined(); expect(active()).toBe('Appearance'); expect(content()).toContain('Font Size');
        await click('Terminal Behavior'); await deepLink(); expect(active()).toBe('Appearance'); expect(content()).toContain('Font Size');
    });
    it.each(['Win32', 'Linux x86_64'])('pending permission deep-link on %s falls back rather than restoring another category', async name => {
        platform(name); saved = 'updates'; pending.mockReturnValueOnce('permissions'); await render();
        expect(active()).toBe('Appearance'); expect(content()).toContain('Font Size');
    });
    it('honors a pending Permissions deep-link on macOS', async () => {
        platform('MacIntel'); saved = 'updates'; pending.mockReturnValueOnce('permissions'); await render();
        expect(active()).toBe('Permissions'); expect(content()).toContain('Allow Accessibility');
    });
    it('restores and deep-links to Permissions on macOS', async () => {
        platform('MacIntel'); saved = 'permissions'; await render();
        expect(active()).toBe('Permissions'); expect(content()).toContain('Allow Screen Recording');
        await click('Appearance'); await deepLink(); expect(active()).toBe('Permissions');
    });
});
