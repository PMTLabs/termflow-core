/**
 * @jest-environment jsdom
 *
 * Fleet-consent toggle (Fleet MCP, Milestone J). With the fabric installed and a
 * peer present, the Peers panel exposes a per-peer "Allow fleet commands" checkbox
 * at the top of that peer's grants block. Flipping it must call
 * `peerSetFleetExec(deviceId, enabled)` and re-read the peer list.
 *
 * The repo avoids React Testing Library (installed v13 predates React 19), so this
 * drives a real DOM render, matching PeersPanel.test.tsx.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import peersReducer from '../../../store/slices/peersSlice';
import type { PeerInfo } from '../../../types/electron';

jest.mock('../PeersPanel.css', () => ({}));
jest.mock('../../UI/ConfirmDialog.css', () => ({}));

// eslint-disable-next-line import/first
import { PeersPanel } from '../PeersPanel';

const tabsStub = (state: { tabs: [] } = { tabs: [] }) => state;
const settingsStub = (state: { keepRunningInBackground: boolean } = { keepRunningInBackground: false }) => state;

function makeStore() {
    return configureStore({
        reducer: { peers: peersReducer, tabs: tabsStub, settings: settingsStub },
    });
}

async function flush() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

const PEER: PeerInfo = {
    deviceId: 'dev-abc',
    name: 'workstation',
    addresses: ['100.64.0.2'],
    online: true,
    lastSeen: 1_752_000_000,
    grants: {},
    os: 'linux',
    fleetExec: false,
};

describe('PeersPanel — fleet consent toggle', () => {
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

    it('renders the fleet toggle in a peer\'s grants block and flips fleet_exec', async () => {
        const peerSetFleetExec = jest.fn(async () => {});
        (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
            fabricStatus: jest.fn(async () => ({ installed: true })),
            peersList: jest.fn(async () => [PEER]),
            getActiveProcesses: jest.fn(async () => []),
            listNetworkInterfaces: jest.fn(async () => []),
            peerSetFleetExec,
        };

        const store = makeStore();
        await mount(store);

        // Peer card is present.
        expect(container.textContent).toContain('workstation');

        // Expand the peer's grants block (click its "Grants" button).
        const grantsBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.peer-actions .link-btn'))
            .find((b) => b.textContent === 'Grants');
        expect(grantsBtn).toBeTruthy();
        await act(async () => { grantsBtn!.click(); });
        await flush();

        // The peer-scoped fleet checkbox lives inside .peer-grants.
        const fleetBox = container.querySelector<HTMLInputElement>('.peer-grants input[type="checkbox"]');
        expect(fleetBox).toBeTruthy();
        expect(fleetBox!.checked).toBe(false);
        expect(container.querySelector('.peer-grants')!.textContent)
            .toContain('Allow fleet commands');

        // Flip it on → the bridge is called with (deviceId, true) and peers are re-read.
        // React's checkbox onChange is wired to the native 'click' event (not 'change'),
        // so a real user click — not a manual `.checked = true` + dispatchEvent('change')
        // — is what actually reaches the component's handler.
        await act(async () => {
            fleetBox!.click();
        });
        await flush();

        expect(peerSetFleetExec).toHaveBeenCalledWith('dev-abc', true);
    });
});
