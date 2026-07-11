import React, { useCallback, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState, AppDispatch } from '../store';
import {
    setPeers,
    setPendingRequests,
    addPendingRequest,
    removePendingRequest,
    setAcceptPeers,
} from '../store/slices/peersSlice';
import { PeerRequestDialog } from './UI/PeerRequestDialog';

/**
 * App-level owner of the incoming-pairing consent flow (Plan 010 §4 / §6.4).
 *
 * Mounted once at the App root — NOT inside the Settings → Peers panel — so an
 * incoming `PairingRequested` event surfaces the Accept/Decline dialog even when
 * Settings is closed. That is the exact tray/background scenario peering targets:
 * with a window focused there is no OS notification (see `maybe_notify_pairing`),
 * and previously the only `peer:event` listener + `PeerRequestDialog` lived inside
 * PeersPanel, which mounts only when Settings is open on the Peers section — so a
 * request arriving with Settings closed was silently lost and the consent gate
 * never fired.
 *
 * It listens to the global `peer:event` DOM feed (bridged from the fabric SSE
 * stream), mirrors requests into the shared `peers` Redux slice, and renders the
 * dialog from `pendingRequests`. PeersPanel reads the same slice, so it stays in
 * sync without owning the subscription.
 */
export const GlobalPeerRequests: React.FC = () => {
    const dispatch = useDispatch<AppDispatch>();
    const pendingRequests = useSelector((s: RootState) => s.peers.pendingRequests);

    const refreshPeers = useCallback(async () => {
        try {
            const list = await window.electronAPI?.peersList?.();
            if (list) dispatch(setPeers(list));
        } catch (err) {
            console.error('peersList failed:', err);
        }
    }, [dispatch]);

    // Hydrate the consent queue from the fabric's authoritative staged-approvals list, so a
    // one-shot PairingRequested that fired while no window was mounted isn't lost (M4).
    const hydratePending = useCallback(async () => {
        try {
            const list = await window.electronAPI?.pendingApprovalsList?.();
            if (list) dispatch(setPendingRequests(list));
        } catch (err) {
            console.error('pendingApprovalsList failed:', err);
        }
    }, [dispatch]);

    useEffect(() => { void hydratePending(); }, [hydratePending]);

    // Live peer/pairing feed. A PairingRequested queues an incoming-request dialog;
    // any event also refreshes the list. Peer state is global (see tauri-bridge), so
    // this is intentionally unfiltered by window and independent of Settings.
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as Record<string, unknown> | undefined;
            const type = detail?.type;
            const deviceId = (detail?.device_id ?? detail?.deviceId) as string | undefined;
            if (type === 'PairingRequested' && deviceId) {
                dispatch(addPendingRequest({
                    deviceId,
                    name: (detail?.name as string) ?? deviceId,
                    addr: (detail?.addr as string) ?? '',
                }));
                return;
            }
            // The fabric auto-clears "accept peers" after a successful pairing (and it can
            // change from any window); sync the toggle so it never sticks stale-ON (M5).
            if (type === 'AcceptPeersChanged' && typeof detail?.enabled === 'boolean') {
                dispatch(setAcceptPeers(detail.enabled));
                return;
            }
            // The fabric event stream (re)connected — re-hydrate the consent queue so a
            // request staged while it was disconnected isn't missed (re-review: M4 gap).
            if (type === 'FabricStreamConnected') {
                void hydratePending();
                return;
            }
            // Any other peer:event — PeerStatus{online}, PeerAdded, PeerRemoved,
            // GrantsChanged — changes the roster or liveness, so re-fetch the
            // authoritative list and replace the slice. PeersPanel renders the live
            // status dots + "seen <relative>" straight from it (online + lastSeen).
            void refreshPeers();
        };
        window.addEventListener('peer:event', handler);
        return () => window.removeEventListener('peer:event', handler);
    }, [dispatch, refreshPeers, hydratePending]);

    const resolveRequest = (deviceId: string) => {
        dispatch(removePendingRequest(deviceId));
        void refreshPeers();
    };

    // Surface one request at a time (deduped by deviceId in the slice).
    const pendingRequest = pendingRequests[0];
    if (!pendingRequest) return null;
    return <PeerRequestDialog request={pendingRequest} onResolved={resolveRequest} />;
};
