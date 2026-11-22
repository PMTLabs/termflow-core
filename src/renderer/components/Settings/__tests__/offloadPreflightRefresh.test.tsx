/**
 * @jest-environment jsdom
 *
 * Regression: the Updates panel must not keep showing a stale "pty-host not
 * connected — nothing to keep alive" offload refusal.
 *
 * The pty-host connects LAZILY (the first host terminal connects it), and the
 * panel caches the `hotswapAvailable` verdict. After an Offload & Close done
 * from this panel, the next launch restores the Settings tab, rehydrates
 * `settingsLastCategory` = 'updates', and sampled the preflight at mount —
 * seconds before the reattach connected the host. The refusal stayed, with the
 * Offload button disabled, until the user happened to switch category.
 *
 * The verdict is a function of the host connection, so it is re-sampled on
 * every connection edge the backend reports (`pty-host:state`, bridged as a
 * DOM event by tauri-bridge.ts) and whenever the panel becomes visible.
 *
 * Follows the repo's Settings test convention: no React Testing Library, real
 * DOM render via react-dom/client.
 */
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
jest.mock('../../../services/openSettings', () => ({
    consumePendingSettingsCategory: () => null,
}));
jest.mock('../../../hooks/useSurfaceZoom', () => ({
    useSurfaceZoom: () => ({ zoom: 1, zoomIn: () => {}, zoomOut: () => {}, reset: () => {} }),
    useZoomGestures: () => {},
}));

// eslint-disable-next-line import/first
import settingsReducer from '../../../store/slices/settingsSlice';
// eslint-disable-next-line import/first
import { SettingsPage } from '../SettingsPage';
// eslint-disable-next-line import/first
import { clearSettingsGuard } from '../../../services/settingsNavGuard';

const NOT_CONNECTED = 'pty-host not connected — nothing to keep alive';

const makeStore = () => configureStore({ reducer: { settings: settingsReducer } });

describe('offload preflight staleness', () => {
    let container: HTMLDivElement;
    let root: Root;
    /** The backend's answer at the moment the panel asks. */
    let hostConnected: boolean;
    let hotswapAvailable: jest.Mock;

    beforeEach(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
            true;
        global.fetch = jest.fn(() => Promise.reject(new Error('no server in test'))) as never;
        hostConnected = false;
        hotswapAvailable = jest.fn(() =>
            hostConnected ? Promise.resolve() : Promise.reject(NOT_CONNECTED),
        );
        // The launch after an offload: the user left this panel on Updates.
        (window as unknown as { electronAPI: unknown }).electronAPI = {
            getConfigValue: jest.fn(async (key: string) =>
                key === 'settingsLastCategory' ? 'updates' : undefined,
            ),
            setConfigValue: jest.fn(async () => {}),
            hotswapAvailable,
            updateAvailable: jest.fn(async () => {}),
            connectedHostRetention: jest.fn(async () =>
                hostConnected ? { state: 'indefinite' } : { state: 'unknown' },
            ),
            checkForUpdates: jest.fn(async () => ({ state: 'unavailable' })),
            getAppVersion: jest.fn(async () => '0.0.0-test'),
        };
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        clearSettingsGuard();
        delete (window as unknown as { electronAPI?: unknown }).electronAPI;
        jest.restoreAllMocks();
    });

    async function renderPage(isActive: boolean, store: ReturnType<typeof makeStore>) {
        await act(async () => {
            root.render(
                <Provider store={store}>
                    <SettingsPage isActive={isActive} />
                </Provider>,
            );
        });
    }

    const blockedText = () => container.querySelector('[data-testid="offload-blocked"]')?.textContent ?? null;
    const offloadButton = () =>
        Array.from(container.querySelectorAll('button')).find((b) =>
            /Offload & Close/.test(b.textContent ?? ''),
        ) as HTMLButtonElement | undefined;

    /** The backend connects the host (first terminal reattached) and says so. */
    async function hostConnects() {
        hostConnected = true;
        await act(async () => {
            window.dispatchEvent(new CustomEvent('pty-host:state', { detail: 'pty-host:connected' }));
        });
    }

    it('THE reported bug: a refusal sampled before the host connected clears once it does', async () => {
        await renderPage(true, makeStore());

        // Mount sampled the preflight before any terminal connected the host.
        expect(hotswapAvailable).toHaveBeenCalled();
        expect(blockedText()).toContain(NOT_CONNECTED);
        expect(offloadButton()?.disabled).toBe(true);

        await hostConnects();

        expect(blockedText()).toBeNull();
        expect(offloadButton()?.disabled).toBe(false);
    });

    it('a host that drops while the panel is open flips the verdict back', async () => {
        hostConnected = true;
        await renderPage(true, makeStore());
        expect(blockedText()).toBeNull();

        hostConnected = false;
        await act(async () => {
            window.dispatchEvent(new CustomEvent('pty-host:state', { detail: 'pty-host:disconnected' }));
        });

        expect(blockedText()).toContain(NOT_CONNECTED);
        expect(offloadButton()?.disabled).toBe(true);
    });

    it('a hidden panel does not sample, and re-samples when it becomes visible', async () => {
        const store = makeStore();
        await renderPage(false, store);
        // Hidden: nothing to show anyone, so nothing is asked.
        expect(hotswapAvailable).not.toHaveBeenCalled();

        // The host connects while Settings is hidden; the edge is not observed.
        hostConnected = true;
        await act(async () => {
            window.dispatchEvent(new CustomEvent('pty-host:state', { detail: 'pty-host:connected' }));
        });
        expect(hotswapAvailable).not.toHaveBeenCalled();

        // Switching to the Settings tab samples fresh — never a mount-time answer.
        await renderPage(true, store);
        expect(hotswapAvailable).toHaveBeenCalledTimes(1);
        expect(blockedText()).toBeNull();
        expect(offloadButton()?.disabled).toBe(false);
    });
});
