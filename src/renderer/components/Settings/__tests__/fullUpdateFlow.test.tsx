/**
 * @jest-environment jsdom
 *
 * The Updates panel when the update has to close every terminal: the notice says
 * so and why, the first click asks the backend without an agreement, a
 * `needsConfirmation` answer opens the confirmation dialog, Confirm sends back
 * exactly what was shown, Cancel sends nothing, and a repeated question is asked
 * again with the new numbers. An update that keeps terminals running is unchanged.
 *
 * Same convention as the neighbouring Settings tests: no React Testing Library,
 * real DOM render via react-dom/client. The ConfirmDialog is the real one.
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
// eslint-disable-next-line import/first
import uiReducer from '../../../store/slices/uiSlice';

const REASONS = [{ kind: 'marker' }, { kind: 'hostInPayload', host: 'host-1' }];

const needsConfirmation = (shellCount: number, unknown = false, version = '9.9.9') => ({
    outcome: 'needsConfirmation',
    version,
    shellCount,
    unknown,
    reasons: REASONS,
});

const makeStore = () => configureStore({ reducer: { settings: settingsReducer, ui: uiReducer } });

describe('full update flow in the Updates panel', () => {
    let container: HTMLDivElement;
    let root: Root;
    let api: Record<string, jest.Mock>;
    let store: ReturnType<typeof makeStore>;

    beforeEach(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        global.fetch = jest.fn(() => Promise.reject(new Error('no server in test'))) as never;
        api = {
            getConfigValue: jest.fn(async (key: string) => (key === 'settingsLastCategory' ? 'updates' : undefined)),
            setConfigValue: jest.fn(async () => {}),
            hotswapAvailable: jest.fn(async () => {}),
            updateAvailable: jest.fn(async () => ({ mode: 'full', reasons: REASONS })),
            updateAndRestart: jest.fn(async () => ({ outcome: 'started' })),
            connectedHostRetention: jest.fn(async () => ({ state: 'indefinite' })),
            checkForUpdates: jest.fn(async () => ({ state: 'available', version: '9.9.9', markerMode: 'full' })),
            getAppVersion: jest.fn(async () => '0.0.0-test'),
        };
        (window as unknown as { electronAPI: unknown }).electronAPI = api;
        store = makeStore();
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

    async function renderPanel() {
        await act(async () => {
            root.render(
                <Provider store={store}>
                    <SettingsPage isActive />
                </Provider>,
            );
        });
    }

    const updateButton = () =>
        Array.from(container.querySelectorAll('button')).find((b) => /^Update to /.test(b.textContent ?? '')) as
            | HTMLButtonElement
            | undefined;
    const notice = () => container.querySelector('[data-testid="update-full-notice"]');
    const dialog = () => document.body.querySelector('[data-testid="update-full-dialog"]');
    const dialogText = () => document.body.querySelector('.confirm-dialog')?.textContent ?? '';
    const click = async (el: Element | null | undefined) => {
        expect(el).toBeTruthy();
        await act(async () => {
            (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const confirmBtn = () => document.body.querySelector('[data-dialog-confirm]');
    const cancelBtn = () => document.body.querySelector('[data-dialog-cancel]');
    const toastMessages = () => (store.getState().ui.toasts as Array<{ message: string }>).map((t) => t.message);

    it('says the update closes all terminals, and why, when the mode is full', async () => {
        await renderPanel();

        expect(notice()?.textContent).toContain('closes all terminals');
        expect(notice()?.textContent).toContain('This release requires a full restart.');
        expect(notice()?.textContent).toContain('A running terminal service cannot survive this update.');
        expect(container.textContent).not.toContain('Updating keeps your terminals running');
        expect(updateButton()?.disabled).toBe(false);
    });

    it('leaves the offload wording and flow alone when the mode is offload', async () => {
        api.updateAvailable.mockResolvedValue({ mode: 'offload', reasons: [] });
        await renderPanel();

        expect(notice()).toBeNull();
        expect(container.textContent).toContain('Updating keeps your terminals running');

        await click(updateButton());
        expect(api.updateAndRestart).toHaveBeenCalledTimes(1);
        expect(api.updateAndRestart).toHaveBeenCalledWith(undefined);
        expect(dialog()).toBeNull();
    });

    it('is reachable when the backend allows the full update although the offload preflight refuses', async () => {
        api.hotswapAvailable.mockRejectedValue('cannot hot-swap: some terminals are in-process');
        await renderPanel();

        expect(container.querySelector('[data-testid="update-blocked"]')).toBeNull();
        expect(notice()).not.toBeNull();
        expect(updateButton()?.disabled).toBe(false);
    });

    it('keeps the backend refusal when the update cannot run at all', async () => {
        api.updateAvailable.mockRejectedValue('another TermFlow instance is running');
        await renderPanel();

        expect(container.querySelector('[data-testid="update-blocked"]')?.textContent).toContain(
            'another TermFlow instance is running',
        );
        expect(notice()).toBeNull();
        expect(updateButton()?.disabled).toBe(true);
    });

    it('asks first without an agreement, then shows the count and the reasons in a dialog', async () => {
        api.updateAndRestart.mockResolvedValueOnce(needsConfirmation(3));
        await renderPanel();

        await click(updateButton());

        expect(api.updateAndRestart).toHaveBeenCalledTimes(1);
        expect(api.updateAndRestart).toHaveBeenLastCalledWith(undefined);
        expect(dialog()).not.toBeNull();
        expect(dialogText()).toContain('9.9.9');
        expect(dialogText()).toContain('closes ALL terminals');
        expect(dialogText()).toContain('3 terminals will be closed');
        expect(dialogText()).toContain('This release requires a full restart.');
        expect(dialogText()).toContain('A running terminal service cannot survive this update.');
    });

    it('words an unanswered host as at least N, never as 0', async () => {
        api.updateAndRestart.mockResolvedValueOnce(needsConfirmation(0, true));
        await renderPanel();
        await click(updateButton());
        expect(dialogText()).not.toMatch(/\b0\b/);

        await click(cancelBtn());
        api.updateAndRestart.mockResolvedValueOnce(needsConfirmation(2, true));
        await click(updateButton());
        expect(dialogText()).toContain('At least 2 terminals will be closed');
    });

    it('Confirm sends back exactly what the dialog showed', async () => {
        api.updateAndRestart.mockResolvedValueOnce(needsConfirmation(3, true));
        await renderPanel();
        await click(updateButton());

        await click(confirmBtn());

        expect(api.updateAndRestart).toHaveBeenCalledTimes(2);
        expect(api.updateAndRestart.mock.calls[1]).toStrictEqual([
            { targetVersion: '9.9.9', shellCount: 3, unknown: true, reasons: REASONS },
        ]);
        expect(dialog()).toBeNull();
    });

    it('the dialog and the agreement come from the backend answer, not from what the panel had checked', async () => {
        // The panel checked 9.9.9 with a marker reason; the release that was
        // downloaded is another one, with another reason.
        const otherReasons = [{ kind: 'hostOriginUnknown', host: 'host-7' }];
        api.updateAndRestart.mockResolvedValueOnce({
            outcome: 'needsConfirmation',
            version: '9.9.8',
            shellCount: 2,
            unknown: false,
            reasons: otherReasons,
        });
        await renderPanel();
        await click(updateButton());

        expect(dialogText()).toContain('9.9.8');
        expect(dialogText()).not.toContain('9.9.9');

        await click(confirmBtn());

        expect(api.updateAndRestart.mock.calls[1]).toStrictEqual([
            { targetVersion: '9.9.8', shellCount: 2, unknown: false, reasons: otherReasons },
        ]);
    });

    it('Cancel closes the dialog and calls the backend no more', async () => {
        api.updateAndRestart.mockResolvedValueOnce(needsConfirmation(3));
        await renderPanel();
        await click(updateButton());
        expect(api.updateAndRestart).toHaveBeenCalledTimes(1);

        await click(cancelBtn());

        expect(dialog()).toBeNull();
        expect(api.updateAndRestart).toHaveBeenCalledTimes(1);
        expect(updateButton()?.disabled).toBe(false);
    });

    it('a repeated question after Confirm is a fresh dialog with the new numbers, and nothing is sent until it is agreed to', async () => {
        api.updateAndRestart
            .mockResolvedValueOnce(needsConfirmation(3))
            .mockResolvedValueOnce(needsConfirmation(5, true));
        await renderPanel();
        await click(updateButton());
        await click(confirmBtn());

        expect(api.updateAndRestart).toHaveBeenCalledTimes(2);
        expect(dialogText()).toContain('At least 5 terminals will be closed');
        expect(dialogText()).not.toContain('3 terminals');

        await click(confirmBtn());

        expect(api.updateAndRestart).toHaveBeenCalledTimes(3);
        expect(api.updateAndRestart.mock.calls[2]).toStrictEqual([
            { targetVersion: '9.9.9', shellCount: 5, unknown: true, reasons: REASONS },
        ]);
    });

    it('a failure is a toast, the button works again and no dialog is left behind', async () => {
        api.updateAndRestart.mockRejectedValueOnce('cannot enumerate sibling instances');
        await renderPanel();

        await click(updateButton());

        expect(toastMessages()).toEqual(['Update failed: cannot enumerate sibling instances']);
        expect(dialog()).toBeNull();
        expect(updateButton()?.disabled).toBe(false);
    });

    it('a failure after Confirm is a toast too and the button works again', async () => {
        api.updateAndRestart
            .mockResolvedValueOnce(needsConfirmation(3))
            .mockRejectedValueOnce('the updater could not be started');
        await renderPanel();
        await click(updateButton());

        await click(confirmBtn());

        expect(toastMessages()).toEqual(['Update failed: the updater could not be started']);
        expect(dialog()).toBeNull();
        expect(updateButton()?.disabled).toBe(false);
    });

    it('asks again about the mode once the update check has finished', async () => {
        // The first sample is taken before the check reports the release's mode.
        api.updateAvailable.mockResolvedValueOnce({ mode: 'offload', reasons: [] });
        await renderPanel();

        expect(api.updateAvailable.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(notice()).not.toBeNull();
    });

    it('a marked release is reachable on first entry with an in-process shell, whichever call finishes first', async () => {
        // The backend: an offload refuses an in-process shell; a full update is not asked.
        const inProcess = 'cannot hot-swap: some terminals are in-process';
        api.hotswapAvailable.mockRejectedValue(inProcess);
        api.updateAvailable.mockImplementation(async (markerMode?: string) => {
            if (markerMode === 'full') return { mode: 'full', reasons: REASONS };
            throw inProcess;
        });
        let answerCheck!: (status: unknown) => void;
        api.checkForUpdates.mockImplementation(() => new Promise((resolve) => { answerCheck = resolve; }));
        await renderPanel();

        // Sampled before the check answered: nothing is known about the release yet.
        expect(api.updateAvailable.mock.calls[0]).toEqual([undefined]);
        await act(async () => answerCheck({ state: 'available', version: '9.9.9', markerMode: 'full' }));

        expect(api.updateAvailable).toHaveBeenLastCalledWith('full');
        expect(container.querySelector('[data-testid="update-blocked"]')).toBeNull();
        expect(notice()).not.toBeNull();
        expect(updateButton()?.disabled).toBe(false);
    });

    it('forgets the mode of a release the next check does not find', async () => {
        await renderPanel();
        api.checkForUpdates.mockResolvedValue({ state: 'upToDate' });
        api.updateAvailable.mockClear();

        const recheck = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Re-check');
        await click(recheck);

        const modes = api.updateAvailable.mock.calls.map((call) => call[0]);
        expect(modes.length).toBeGreaterThan(0);
        expect(modes[modes.length - 1]).toBeUndefined();
    });
});
