import React, { useCallback, useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../store';
import { PeerInfo, GrantLevel, NetworkInterfaceInfo, PairingCode, ActiveProcess } from '../../types/electron';
import {
    setPeers,
    removePeer,
    setAcceptPeers as setAcceptPeersState,
    setFabricInstalled,
} from '../../store/slices/peersSlice';
import { addToast } from '../../store/slices/uiSlice';
import { setKeepRunningInBackground } from '../../store/slices/settingsSlice';
import { peerStatus, PeerStatus } from './peerStatus';
import { AddPeerModal } from './AddPeerModal';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import './PeersPanel.css';

const STATUS_TITLE: Record<PeerStatus, string> = {
    online: 'Online',
    offline: 'Offline',
    pending: 'Pairing…',
    revoked: 'Revoked',
};

const GRANT_LEVELS: (GrantLevel | 'None')[] = ['None', 'View', 'Control'];

/** Human label for a grantable terminal, derived from its live foreground process. */
function processLabel(p: ActiveProcess): string {
    return p.agent || p.currentApp?.name || p.name || p.shell || p.id;
}

function lastSeenLabel(ts: number | null): string {
    if (!ts) return 'never';
    const ms = ts < 1e12 ? ts * 1000 : ts; // tolerate seconds or millis
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'just now';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Settings → Peers panel (Plan 010). Drives the whole peering surface: it checks
 * whether the termflow-fabric sidecar is installed and, if not, renders a neutral
 * "not installed" card and nothing else (the feature degrades gracefully in a
 * fabric-absent build). When installed it exposes the Accept-peers toggle, a
 * pairing-code display, an Add-peer flow, and the peer list with per-terminal
 * grants + revoke. Incoming pairing requests (the Accept/Decline consent dialog)
 * are owned app-wide by <GlobalPeerRequests> so they surface even when Settings is
 * closed; this panel just reads the shared Redux slice they keep fresh.
 */
export const PeersPanel: React.FC = () => {
    const dispatch = useDispatch<AppDispatch>();
    const peers = useSelector((s: RootState) => s.peers.peers);
    const acceptPeers = useSelector((s: RootState) => s.peers.acceptPeers);
    const fabricInstalled = useSelector((s: RootState) => s.peers.fabricInstalled);
    const keepRunningInBackground = useSelector((s: RootState) => s.settings.keepRunningInBackground);

    // Grants key on the BACKEND terminal_id — the processId from `/api/processes`, the
    // same identity a remote peer resolves via Awareness. Building the grant UI from
    // renderer tab/layout IDs (`s.tabs.tabs`) would key grants on IDs that never match a
    // peer's request, so every grant would silently fail and split-pane terminals would
    // be omitted (review H5). Source the grantable terminals from `/api/processes`.
    const [localTerminals, setLocalTerminals] = useState<{ id: string; title: string }[]>([]);

    const [statusChecked, setStatusChecked] = useState(false);
    // The fabric's inbound peer port, reported by `fabricStatus`. Sourced from the core's
    // FABRIC_PEER_PORT (the same value it hands the fabric), so the port shown here is
    // always the one the listener is actually on.
    const [peerPort, setPeerPort] = useState<number | undefined>(undefined);
    const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>([]);
    const [pairingCode, setPairingCode] = useState<PairingCode | null>(null);
    const [showAddPeer, setShowAddPeer] = useState(false);
    const [revokeTarget, setRevokeTarget] = useState<PeerInfo | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);

    const toastError = useCallback(
        (message: string) => dispatch(addToast({ message, type: 'error' })),
        [dispatch],
    );

    const refreshPeers = useCallback(async () => {
        try {
            const list = await window.electronAPI?.peersList?.();
            if (list) dispatch(setPeers(list));
        } catch (err) {
            console.error('peersList failed:', err);
        }
    }, [dispatch]);

    // Pull the live terminals (backend processIds) that grants can target.
    const refreshProcesses = useCallback(async () => {
        try {
            const procs = await window.electronAPI?.getActiveProcesses?.();
            if (procs) setLocalTerminals(procs.map((p) => ({ id: p.id, title: processLabel(p) })));
        } catch (err) {
            console.error('getActiveProcesses failed:', err);
        }
    }, []);

    // Mount: probe the fabric. `installed:false` (binary absent) short-circuits the
    // whole panel to the "not installed" card.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            let installed = false;
            try {
                const status = await window.electronAPI?.fabricStatus?.();
                installed = !!status?.installed;
                if (!cancelled && installed) {
                    // Seed accept-peers from the health payload when the fabric reports it
                    // (best-effort — the toggle still works either way).
                    const acc = (status as Record<string, unknown>)?.acceptPeers ??
                        (status as Record<string, unknown>)?.accept_peers;
                    if (typeof acc === 'boolean') dispatch(setAcceptPeersState(acc));
                    if (typeof status?.peerPort === 'number') setPeerPort(status.peerPort);
                }
            } catch (err) {
                console.error('fabricStatus failed:', err);
            }
            if (cancelled) return;
            dispatch(setFabricInstalled(installed));
            setStatusChecked(true);
            if (installed) {
                await refreshPeers();
                await refreshProcesses();
                try {
                    const ifaces = await window.electronAPI?.listNetworkInterfaces?.();
                    if (!cancelled && ifaces) setInterfaces(ifaces);
                } catch {
                    /* interfaces are informational only */
                }
            }
        })();
        return () => { cancelled = true; };
    }, [dispatch, refreshPeers, refreshProcesses]);

    // The `peer:event` feed (including incoming PairingRequested → Accept/Decline dialog)
    // is now owned app-wide by <GlobalPeerRequests>, so an incoming request surfaces even
    // when Settings is closed. It mirrors every event into this same Redux slice, so this
    // panel stays live from the slice without owning the subscription (which would also
    // double-render the dialog).

    const toggleAcceptPeers = async (enabled: boolean) => {
        try {
            await window.electronAPI?.setAcceptPeers?.(enabled);
            dispatch(setAcceptPeersState(enabled));
        } catch (err) {
            toastError(`Couldn't ${enabled ? 'enable' : 'disable'} accepting peers.`);
            console.error('setAcceptPeers failed:', err);
        }
    };

    const showPairingCode = async () => {
        try {
            const code = await window.electronAPI?.pairingCodeCreate?.();
            if (code) setPairingCode(code);
        } catch (err) {
            toastError("Couldn't create a pairing code.");
            console.error('pairingCodeCreate failed:', err);
        }
    };

    const changeGrant = async (deviceId: string, terminalId: string, level: GrantLevel | 'None') => {
        try {
            await window.electronAPI?.peerSetGrant?.(deviceId, terminalId, level);
            await refreshPeers();
        } catch (err) {
            toastError("Couldn't update the grant.");
            console.error('peerSetGrant failed:', err);
        }
    };

    const toggleFleetExec = async (deviceId: string, enabled: boolean) => {
        try {
            await window.electronAPI?.peerSetFleetExec?.(deviceId, enabled);
            await refreshPeers();
        } catch (err) {
            toastError("Couldn't update fleet permission.");
            console.error('peerSetFleetExec failed:', err);
        }
    };

    const confirmRevoke = async () => {
        const target = revokeTarget;
        setRevokeTarget(null);
        if (!target) return;
        try {
            await window.electronAPI?.peerRevoke?.(target.deviceId);
            dispatch(removePeer(target.deviceId));
        } catch (err) {
            toastError("Couldn't revoke the peer.");
            console.error('peerRevoke failed:', err);
        }
    };

    // --- Render -----------------------------------------------------------------

    if (!statusChecked) {
        return (
            <div className="settings-section">
                <h2>Peers</h2>
                <p className="help-text">Checking peering status…</p>
            </div>
        );
    }

    if (!fabricInstalled) {
        return (
            <div className="settings-section">
                <h2>Peers <span className="pro-chip">Pro</span></h2>
                <div className="connection-card">
                    <p><strong>Peering is not installed.</strong></p>
                    <p className="help-text">
                        Multi-machine peering is a <strong>TermFlow Pro</strong> feature. This build
                        doesn’t include the peering component, so pairing with other machines is
                        unavailable. Everything else works normally.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="settings-section">
            <h2>Peers <span className="pro-chip">Pro</span></h2>
            <p className="section-description">
                Pair this machine with other TermFlow instances to share terminal access over your
                LAN or private network.
            </p>

            <label className="toggle-row">
                <input
                    type="checkbox"
                    checked={acceptPeers}
                    onChange={(e) => { void toggleAcceptPeers(e.target.checked); }}
                />
                <span>Accept incoming peer connections</span>
            </label>

            <label className="toggle-row">
                <input
                    type="checkbox"
                    checked={keepRunningInBackground}
                    onChange={(e) => dispatch(setKeepRunningInBackground(e.target.checked))}
                />
                <span>Keep running in background (hide to tray on close, so peering stays active)</span>
            </label>

            <div className="connection-card peers-ports-card">
                <p className="ports-title"><strong>Network port</strong></p>
                <div className="port-row">
                    <code className="port-num">{peerPort ?? 8790}/TCP</code>
                    <span className="help-text">
                        Inbound. Other machines connect here to pair and to reach the terminals
                        you grant them. This is the only port peering needs — the rest of
                        TermFlow stays bound to localhost.
                    </span>
                </div>
                <p className="help-text">
                    On the same LAN or over a VPN such as Tailscale this normally works with no
                    setup. To pair across a router or the internet, allow{' '}
                    <strong>{peerPort ?? 8790}/TCP inbound</strong> through the firewall on
                    whichever machine accepts the connection — the machine that shows the pairing
                    code. A VPN is the recommended route: peering identifies a peer by the address
                    it connects from, so NAT between the two machines can leave them unable to
                    reach each other back.
                </p>
            </div>

            <div className="peers-toolbar">
                <button className="link-btn" onClick={() => { void showPairingCode(); }}>
                    Show pairing code
                </button>
                <button className="link-btn" onClick={() => setShowAddPeer(true)}>
                    Add peer
                </button>
            </div>

            {pairingCode && (
                <div className="connection-card pairing-code-card">
                    <p>
                        Share this one-time code with the other machine (expires in{' '}
                        {Math.round(pairingCode.expiresInSecs / 60) || 1} min):
                    </p>
                    <p><code className="pairing-code">{pairingCode.code}</code></p>
                    {interfaces.length > 0 && (
                        <div className="pairing-addresses">
                            <p className="help-text">
                                This machine is reachable at (on port {peerPort ?? 8790}):
                            </p>
                            {interfaces.map((iface) => (
                                <div className="nic-row" key={`${iface.name}-${iface.ip}`}>
                                    <span className="nic-name">{iface.name}</span>
                                    <code className="nic-ip">{iface.ip}</code>
                                    <span className="nic-label">{iface.label}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {peers.length === 0 ? (
                <p className="peers-empty">No peers yet. Show a pairing code or add a peer to get started.</p>
            ) : (
                peers.map((peer) => {
                    const status: PeerStatus = peerStatus({ online: peer.online });
                    const grantIds = Array.from(
                        new Set([...localTerminals.map((t) => t.id), ...Object.keys(peer.grants)]),
                    );
                    const isOpen = expanded === peer.deviceId;
                    return (
                        <div className="connection-card peer-card" key={peer.deviceId}>
                            <div className="peer-head">
                                <span className={`peer-dot ${status}`} title={STATUS_TITLE[status]} />
                                <span className="peer-name">{peer.name || peer.deviceId}</span>
                                <span className="peer-meta">
                                    {(peer.addresses[0] ?? 'no address')} · seen {lastSeenLabel(peer.lastSeen)}
                                    {peer.os ? ` · ${peer.os}` : ''}
                                </span>
                            </div>
                            <div className="peer-actions">
                                <button
                                    className="link-btn"
                                    onClick={() => {
                                        const next = isOpen ? null : peer.deviceId;
                                        setExpanded(next);
                                        // Refresh the terminal list when opening so grants
                                        // target the currently-live processes.
                                        if (next) void refreshProcesses();
                                    }}
                                >
                                    {isOpen ? 'Hide grants' : 'Grants'}
                                </button>
                                <button className="revoke-btn" onClick={() => setRevokeTarget(peer)}>
                                    Revoke
                                </button>
                            </div>

                            {isOpen && (
                                <div className="peer-grants">
                                    <label className="toggle-row">
                                        <input
                                            type="checkbox"
                                            checked={peer.fleetExec}
                                            onChange={(e) => { void toggleFleetExec(peer.deviceId, e.target.checked); }}
                                        />
                                        <span>Allow fleet commands (create &amp; run terminals)</span>
                                    </label>
                                    {grantIds.length === 0 ? (
                                        <p className="help-text">No terminals to grant.</p>
                                    ) : (
                                        grantIds.map((tid) => {
                                            const title = localTerminals.find((t) => t.id === tid)?.title ?? tid;
                                            const current: GrantLevel | 'None' = peer.grants[tid] ?? 'None';
                                            return (
                                                <div className="peer-grant-row" key={tid}>
                                                    <span className="grant-title" title={tid}>{title}</span>
                                                    <select
                                                        className="setting-input"
                                                        value={current}
                                                        onChange={(e) => {
                                                            void changeGrant(
                                                                peer.deviceId,
                                                                tid,
                                                                e.target.value as GrantLevel | 'None',
                                                            );
                                                        }}
                                                    >
                                                        {GRANT_LEVELS.map((lvl) => (
                                                            <option key={lvl} value={lvl}>{lvl}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })
            )}

            {showAddPeer && (
                <AddPeerModal
                    onAdded={() => { void refreshPeers(); }}
                    onClose={() => setShowAddPeer(false)}
                    peerPort={peerPort}
                />
            )}

            <ConfirmDialog
                isOpen={revokeTarget !== null}
                title="Revoke peer?"
                message={
                    `This removes ${revokeTarget?.name || revokeTarget?.deviceId || 'the peer'} and all its ` +
                    'terminal grants. It will need to pair again to reconnect.'
                }
                onConfirm={() => { void confirmRevoke(); }}
                onCancel={() => setRevokeTarget(null)}
                destructive
                confirmText="Revoke"
                confirmMnemonic="R"
                cancelText="Cancel"
                cancelMnemonic="A"
            />
        </div>
    );
};
