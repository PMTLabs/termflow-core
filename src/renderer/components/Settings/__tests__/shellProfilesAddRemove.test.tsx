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
jest.mock('../../UI/UnsavedChangesDialog', () => ({ UnsavedChangesDialog: () => null }));
jest.mock('../../UI/SplitButton', () => ({ SplitButton: () => null }));
jest.mock('../../../services/openSettings', () => ({ consumePendingSettingsCategory: () => null }));
jest.mock('../../../hooks/useSurfaceZoom', () => ({
    useSurfaceZoom: () => ({ zoom: 1, zoomIn: () => {}, zoomOut: () => {}, reset: () => {} }),
    useZoomGestures: () => {},
}));

import settingsReducer, { setShellProfiles, setDefaultProfile, ShellProfile } from '../../../store/slices/settingsSlice';
import { clearSettingsGuard, runSettingsGuard } from '../../../services/settingsNavGuard';
import { SettingsPage } from '../SettingsPage';

const profile = (id: string, is_custom = false): ShellProfile =>
    ({ id, name: id, path: `${id}.exe`, args: [], env: {}, is_custom });

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((ok) => { resolve = ok; });
    return { promise, resolve };
}

describe('Settings → Shell Profiles add/remove', () => {
    let root: Root;
    let container: HTMLDivElement;
    let api: Record<string, jest.Mock>;
    let store: ReturnType<typeof makeStore>;
    const makeStore = () => configureStore({ reducer: { settings: settingsReducer } });

    beforeEach(async () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        global.fetch = jest.fn(() => Promise.reject(new Error('offline'))) as never;
        api = {
            getConfigValue: jest.fn(async () => undefined),
            setConfigValue: jest.fn(async () => {}),
            setDefaultProfile: jest.fn(async () => {}),
            addShellProfile: jest.fn(),
            deleteShellProfile: jest.fn(),
        };
        (window as any).electronAPI = api;
        store = makeStore();
        store.dispatch(setShellProfiles([profile('powershell'), profile('c1', true), profile('c2', true)]));
        store.dispatch(setDefaultProfile('c1'));
        container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
        await act(async () => root.render(<Provider store={store}><SettingsPage isActive /></Provider>));
        const nav = [...container.querySelectorAll<HTMLButtonElement>('.settings-nav-item')]
            .find((b) => b.textContent?.trim() === 'Shell Profiles')!;
        await act(async () => nav.click());
    });
    afterEach(async () => {
        await act(async () => root.unmount()); container.remove(); clearSettingsGuard();
        delete (window as any).electronAPI; jest.restoreAllMocks();
    });

    const removeButton = (id: string) =>
        container.querySelector<HTMLButtonElement>(`[aria-label="Remove profile ${id}"]`)!;
    const ids = () => store.getState().settings.shellProfiles.map((p) => p.id);
    const lastSavedProfiles = () => {
        const calls = api.setConfigValue.mock.calls.filter(([key]) => key === 'shellProfiles');
        return (calls[calls.length - 1]?.[1] as ShellProfile[] | undefined)?.map((p) => p.id);
    };
    const isDirty = async () => {
        let blocked = false;
        await act(async () => { blocked = runSettingsGuard(() => {}); });
        return blocked;
    };

    it('only custom profiles get a Remove button', () => {
        expect(removeButton('powershell')).toBeNull();
        expect(removeButton('c1')).not.toBeNull();
    });

    it('two removals in flight at once both stick, the default moves, and nothing reads as unsaved', async () => {
        const first = deferred();
        const second = deferred();
        api.deleteShellProfile.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

        await act(async () => removeButton('c1').click());
        expect(removeButton('c1').disabled).toBe(true);
        await act(async () => removeButton('c2').click());
        await act(async () => { first.resolve(); await first.promise; });
        await act(async () => { second.resolve(); await second.promise; });

        expect(ids()).toEqual(['powershell']);
        expect(store.getState().settings.defaultProfile).toBe('powershell');
        // Saved to config so every window's config:changed listener gets the new list.
        expect(lastSavedProfiles()).toEqual(['powershell']);
        expect(await isDirty()).toBe(false);
    });

    it('a second click while a removal is in flight does not delete twice', async () => {
        const pending = deferred();
        api.deleteShellProfile.mockImplementation(() => pending.promise);

        await act(async () => removeButton('c2').click());
        await act(async () => removeButton('c2').click());
        await act(async () => { pending.resolve(); await pending.promise; });

        expect(api.deleteShellProfile).toHaveBeenCalledTimes(1);
        expect(ids()).toEqual(['powershell', 'c1']);
    });

    it('adding a profile keeps edits made while the add was in flight and saves the list', async () => {
        const created = { ...profile('custom-1', true), name: 'Nu', path: 'nu.exe' };
        let finishAdd!: () => void;
        api.addShellProfile.mockImplementation(() => new Promise((ok) => { finishAdd = () => ok(created); }));

        const addButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find((b) => b.textContent?.includes('Add profile'))!;
        await act(async () => addButton.click());
        const set = (id: string, value: string) => {
            const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        await act(async () => { set('new-profile-name', 'Nu'); set('new-profile-path', 'nu.exe'); });
        await act(async () => {
            container.querySelector('form.add-profile-form')!
                .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });

        // Another window's change lands while the add is in flight.
        await act(async () => {
            store.dispatch(setShellProfiles([profile('powershell'), profile('c1', true)]));
        });
        await act(async () => { finishAdd(); });

        expect(ids()).toEqual(['powershell', 'c1', 'custom-1']);
        expect(lastSavedProfiles()).toEqual(['powershell', 'c1', 'custom-1']);
        expect(container.querySelector('form.add-profile-form')).toBeNull();
        expect(await isDirty()).toBe(false);
    });
});
