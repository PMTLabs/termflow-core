/**
 * @jest-environment jsdom
 *
 * The incoming-pairing consent dialog must be reachable app-wide — NOT only when
 * Settings → Peers is open (Plan 010 §6.4). <GlobalPeerRequests> owns the
 * `peer:event` subscription + <PeerRequestDialog> at the App root, so a
 * PairingRequested event surfaces the Accept/Decline dialog with no Settings /
 * PeersPanel mounted. Previously that listener + dialog lived only inside
 * PeersPanel, so a request arriving with Settings closed was silently lost.
 *
 * Mirrors the repo's RTL-free pattern (react-dom/client + React.act).
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import peersReducer from '../../store/slices/peersSlice';

// eslint-disable-next-line import/first
import { GlobalPeerRequests } from '../GlobalPeerRequests';

function makeStore() {
    return configureStore({ reducer: { peers: peersReducer } });
}

async function flush() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('GlobalPeerRequests — consent dialog reachable without Settings', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
            true;
    });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
            peersList: jest.fn(async () => []),
        };
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
                    <GlobalPeerRequests />
                </Provider>,
            );
        });
        await flush();
    }

    it('surfaces the Accept/Decline dialog on a PairingRequested peer:event', async () => {
        const store = makeStore();
        await mount(store);

        // Nothing pending initially → no dialog mounted.
        expect(container.querySelector('.mcp-modal')).toBeNull();

        await act(async () => {
            window.dispatchEvent(
                new CustomEvent('peer:event', {
                    detail: {
                        type: 'PairingRequested',
                        device_id: 'PEER-Z',
                        name: 'Desk',
                        addr: '10.0.0.5:8790',
                    },
                }),
            );
        });
        await flush();

        // The request is mirrored into the shared slice and the dialog is shown —
        // all without any Settings/PeersPanel in the tree.
        expect(store.getState().peers.pendingRequests).toHaveLength(1);
        expect(store.getState().peers.pendingRequests[0].deviceId).toBe('PEER-Z');
        expect(container.querySelector('.mcp-modal')).not.toBeNull();
        expect(container.textContent).toContain('wants to pair');
    });

    it('ignores non-pairing peer:events (no dialog)', async () => {
        const store = makeStore();
        await mount(store);

        await act(async () => {
            window.dispatchEvent(
                new CustomEvent('peer:event', {
                    detail: { type: 'PeerStatus', device_id: 'PEER-Z', online: true },
                }),
            );
        });
        await flush();

        expect(store.getState().peers.pendingRequests).toHaveLength(0);
        expect(container.querySelector('.mcp-modal')).toBeNull();
    });
});
