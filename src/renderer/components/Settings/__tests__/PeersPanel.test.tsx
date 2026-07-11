/**
 * @jest-environment jsdom
 *
 * Graceful fabric-absent path (Plan 010, Task 11). When the termflow-fabric
 * sidecar is not installed, `fabricStatus()` resolves to `{ installed: false }`
 * and the Peers panel must degrade to a neutral "Peering is not installed" card
 * with none of the pairing/accept controls mounted — no handler throws, the rest
 * of the app is unaffected.
 *
 * The repo deliberately avoids React Testing Library (its installed v13 predates
 * React 19), so this drives a real DOM render with `react-dom/client` +
 * `React.act`, mirroring how the codebase unit-tests its own primitives.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import peersReducer from '../../../store/slices/peersSlice';

// Jest has no CSS transform; stub the two stylesheet imports pulled in by the
// Peers component tree (webpack handles them at build time).
jest.mock('../PeersPanel.css', () => ({}));
jest.mock('../../UI/ConfirmDialog.css', () => ({}));

// Imported after the CSS mocks are registered so the tree loads clean.
// eslint-disable-next-line import/first
import { PeersPanel } from '../PeersPanel';

// PeersPanel builds the per-terminal grant list from `/api/processes` (backend
// terminal_ids), not from `s.tabs.tabs`. This stub only keeps the store shape valid;
// the fabric-absent branch under test never reaches the grant UI regardless.
const tabsStub = (state: { tabs: { id: string; title: string }[] } = { tabs: [] }) => state;
// PeersPanel also reads `s.settings.keepRunningInBackground` for the background-mode
// toggle (Plan 010); a minimal stub mirrors the real store shape for this test.
const settingsStub = (state: { keepRunningInBackground: boolean } = { keepRunningInBackground: false }) => state;

function makeStore() {
    return configureStore({
        reducer: { peers: peersReducer, tabs: tabsStub, settings: settingsStub },
    });
}

// Flush pending microtasks + timers so the mount effect's awaited
// `fabricStatus()` resolves and React re-renders inside an act() scope.
async function flush() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('PeersPanel — fabric absent', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
            true;
    });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    });

    async function mount(store: ReturnType<typeof makeStore>) {
        root = createRoot(container);
        await act(async () => {
            root.render(
                <Provider store={store}>
                    <PeersPanel />
                </Provider>,
            );
        });
        await flush();
    }

    it('renders the "not installed" card when fabricStatus reports installed:false', async () => {
        const fabricStatus = jest.fn(async () => ({ installed: false }));
        const peersList = jest.fn(async () => []);
        (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
            fabricStatus,
            peersList,
            listNetworkInterfaces: jest.fn(async () => []),
        };

        const store = makeStore();
        await mount(store);

        expect(fabricStatus).toHaveBeenCalledTimes(1);
        expect(store.getState().peers.fabricInstalled).toBe(false);
        expect(container.textContent).toContain('Peering is not installed');
        // The absent path must not have queried the peer list or mounted controls.
        expect(peersList).not.toHaveBeenCalled();
        expect(container.querySelector('input[type="checkbox"]')).toBeNull();
        expect(container.querySelector('.peers-toolbar')).toBeNull();
    });

    it('does not throw when the fabricStatus bridge method is entirely absent', async () => {
        // Browser host / older bridge: no peer methods at all. The optional-chained
        // calls must no-op and the panel still resolves to "not installed".
        (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {};

        const store = makeStore();
        await mount(store);

        expect(store.getState().peers.fabricInstalled).toBe(false);
        expect(container.textContent).toContain('Peering is not installed');
    });

    it('degrades to "not installed" when fabricStatus rejects', async () => {
        // The rejection is caught + logged by the panel, never rethrown.
        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const fabricStatus = jest.fn(async () => {
            throw new Error('control port unreachable');
        });
        (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
            fabricStatus,
        };

        const store = makeStore();
        await mount(store);

        expect(fabricStatus).toHaveBeenCalledTimes(1);
        expect(store.getState().peers.fabricInstalled).toBe(false);
        expect(container.textContent).toContain('Peering is not installed');
        expect(errSpy).toHaveBeenCalledWith('fabricStatus failed:', expect.any(Error));
        errSpy.mockRestore();
    });
});
