/**
 * @jest-environment jsdom
 *
 * Regression: a dirty Settings tab must not block tab navigation while the
 * Settings tab is NOT the visible one.
 *
 * TerminalContainer keeps every tab mounted and only hides the inactive ones with
 * CSS (`.tab-content` → visibility:hidden; pointer-events:none). SettingsPage
 * therefore stays mounted after you leave it, and used to keep its nav guard
 * registered. Creating a tab with "+" does not consult the guard, so it could
 * strand the user on a new tab while a dirty Settings tab sat hidden. From then on
 * every tab click ran the still-registered guard, which blocked the switch and
 * raised its Save/Discard prompt *inside the hidden Settings tab* — invisible and
 * unclickable. Tab switching deadlocked permanently.
 *
 * The guard is only answerable when its dialog can actually be seen, so it must be
 * armed only while Settings is active.
 *
 * Follows the repo's Settings test convention: no React Testing Library (installed
 * v13 predates React 19), so this drives a real DOM render via react-dom/client.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

// Jest has no CSS transform. Mocking the heavy leaf components also keeps their
// own stylesheet imports out of the module graph.
jest.mock('../SettingsPage.css', () => ({}));
jest.mock('../PeersPanel', () => ({ PeersPanel: () => null }));
jest.mock('../AboutLegalPanel', () => ({ AboutLegalPanel: () => null }));
jest.mock('../McpConnectModal', () => ({ McpConnectModal: () => null }));
jest.mock('../../UI/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
jest.mock('../../UI/UnsavedChangesDialog', () => ({ UnsavedChangesDialog: () => null }));
jest.mock('../../UI/SplitButton', () => ({ SplitButton: () => null }));
// Pulls in store/index → the whole component tree → untransformed CSS imports.
jest.mock('../../../services/openSettings', () => ({
    consumePendingSettingsCategory: () => null,
}));
jest.mock('../../../hooks/useSurfaceZoom', () => ({
    useSurfaceZoom: () => ({ zoom: 1, zoomIn: () => {}, zoomOut: () => {}, reset: () => {} }),
    useZoomGestures: () => {},
}));

// eslint-disable-next-line import/first
import settingsReducer, { setFontSize, setAgentColorScheme } from '../../../store/slices/settingsSlice';
// eslint-disable-next-line import/first
import { SettingsPage } from '../SettingsPage';
// eslint-disable-next-line import/first
import { runSettingsGuard, clearSettingsGuard } from '../../../services/settingsNavGuard';

const makeStore = () => configureStore({ reducer: { settings: settingsReducer } });

describe('settings nav guard arming', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
            true;
        // The connections health probe falls back to fetch when electronAPI is absent.
        global.fetch = jest.fn(() => Promise.reject(new Error('no server in test'))) as never;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        clearSettingsGuard();
        jest.restoreAllMocks();
    });

    /**
     * Render (or re-render) SettingsPage. The settings tab is never unmounted in the
     * real app — it's only hidden — so switching tabs is modelled as an isActive
     * re-render, not a remount. That distinction is the whole point of these tests.
     */
    async function renderPage(isActive: boolean, store: ReturnType<typeof makeStore>) {
        await act(async () => {
            root.render(
                <Provider store={store}>
                    <SettingsPage isActive={isActive} />
                </Provider>,
            );
        });
    }

    /** Mount SettingsPage and dirty the (default) Appearance category. */
    async function mountDirty(isActive: boolean, store = makeStore()) {
        await renderPage(isActive, store);
        // Baseline is snapshotted on entry, so changing a tracked Appearance field
        // afterwards is what makes the page dirty.
        await act(async () => {
            store.dispatch(setFontSize(22));
        });
        return store;
    }

    /** Ask the guard whether it would block a tab switch. */
    async function guardBlocks(): Promise<boolean> {
        let blocked = false;
        // Blocking raises the prompt, which renders — hence act().
        await act(async () => {
            blocked = runSettingsGuard(() => {});
        });
        return blocked;
    }

    it('does not block navigation when the settings tab is dirty but not active', async () => {
        await mountDirty(false);

        const proceed = jest.fn();
        // false = "I am not handling this"; the caller then navigates itself.
        expect(runSettingsGuard(proceed)).toBe(false);
    });

    it('still blocks navigation when the settings tab is dirty and active', async () => {
        await mountDirty(true);

        const proceed = jest.fn();
        // Blocking raises the prompt, so this call renders — hence act().
        let blocked = false;
        await act(async () => {
            blocked = runSettingsGuard(proceed);
        });
        // true = guard took ownership; it runs `proceed` once the user answers the
        // (now visible) Save/Discard/Cancel prompt.
        expect(blocked).toBe(true);
        expect(proceed).not.toHaveBeenCalled();
    });
});

/**
 * Regression: settings the user never touched must not come back dirty.
 *
 * The Appearance baseline tracks `agentColorSchemes`, but the Settings screen is not
 * its only writer — the terminal's right-click "color scheme for agent" menu
 * dispatches `setAgentColorScheme` too (TerminalDisplay.tsx / PaneContextMenu.tsx).
 * Because the settings tab stays mounted and only snapshotted its baseline on the
 * first mount, such an external write drifted settings away from a stale baseline
 * and the untouched Settings page silently became dirty — prompting to
 * Save/Discard changes the user never made in it.
 *
 * The baseline means "state as of entering the page", so it must be re-taken on
 * entry (matching the existing on-category-change resnapshot).
 */
describe('settings dirty tracking vs external writes', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
            true;
        global.fetch = jest.fn(() => Promise.reject(new Error('no server in test'))) as never;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        clearSettingsGuard();
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

    async function guardBlocks(): Promise<boolean> {
        let blocked = false;
        await act(async () => {
            blocked = runSettingsGuard(() => {});
        });
        return blocked;
    }

    it('is not dirty when an agent color scheme is set from a terminal while away', async () => {
        const store = makeStore();
        // Open settings, change nothing, leave.
        await renderPage(true, store);
        await renderPage(false, store);

        // Right-click a terminal running an agent → pick a scheme. Settings is not
        // the visible tab, so this cannot be an edit made in the Settings UI.
        await act(async () => {
            store.dispatch(setAgentColorScheme({ agent: 'claude', colorSchemaId: 'dracula' }));
        });

        // Come back to settings; it must be clean, so leaving again asks nothing.
        await renderPage(true, store);
        expect(await guardBlocks()).toBe(false);
    });

    it('keeps unsaved edits pending when returning after leaving dirty', async () => {
        const store = makeStore();
        await renderPage(true, store);
        // A real edit made in the Settings UI.
        await act(async () => {
            store.dispatch(setFontSize(22));
        });
        // Left while dirty — the "+" new-tab button does not consult the guard.
        await renderPage(false, store);
        await renderPage(true, store);

        // The edit is still unsaved, so Discard must remain reachable.
        expect(await guardBlocks()).toBe(true);
    });
});
