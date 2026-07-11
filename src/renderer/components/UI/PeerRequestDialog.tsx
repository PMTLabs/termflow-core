import React, { useId, useRef, useState } from 'react';
import { PeerRequestInfo } from '../../types/electron';
import { useDialogA11y, Mnemonic as MnemonicType } from './useDialogA11y';
import { Mnemonic } from './Mnemonic';

interface PeerRequestDialogProps {
    /** The incoming pairing request to Accept/Decline. */
    request: PeerRequestInfo;
    /**
     * Called once the request has been SUCCESSFULLY resolved (accepted or declined)
     * so the parent can drop it from `pendingRequests` and refresh the peer list. NOT
     * called when `peerApprove` throws — the request stays visible so the still-staged
     * peer can be re-actioned rather than becoming permanently unapprovable (M4).
     */
    onResolved: (deviceId: string) => void;
}

/**
 * Modal shown when the fabric reports an incoming `PairingRequested` event.
 * Accept → `peerApprove(deviceId, true)`, Decline → `peerApprove(deviceId, false)`.
 *
 * Defaults focus to Decline and Esc declines, so a stray Enter never accepts an
 * unknown device (mirrors ConfirmDialog's destructive-default posture). Reuses the
 * shared `.mcp-modal-*` styling and the `useDialogA11y` focus-trap primitive.
 */
export const PeerRequestDialog: React.FC<PeerRequestDialogProps> = ({ request, onResolved }) => {
    const [busy, setBusy] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const titleId = useId();

    const respond = async (accept: boolean) => {
        if (busy) return;
        setBusy(true);
        try {
            await window.electronAPI?.peerApprove?.(request.deviceId, accept);
            // Only clear the request once the fabric actually resolved it.
            onResolved(request.deviceId);
        } catch (err) {
            // The peer is still staged in the fabric; keep the dialog actionable so the
            // user can retry rather than losing the request entirely (M4).
            console.error('peerApprove failed:', err);
            setBusy(false);
        }
    };

    // A=Accept / D=Decline; no free-text input so the bare-letter mnemonics stay live.
    const mnemonics: MnemonicType[] = [
        { key: 'A', handler: () => { void respond(true); } },
        { key: 'D', handler: () => { void respond(false); } },
    ];

    useDialogA11y(containerRef, {
        isOpen: true,
        onCancel: () => { void respond(false); },
        mnemonics,
        initialFocus: 'cancel',
    });

    return (
        <div className="mcp-modal-overlay">
            <div
                className="mcp-modal"
                ref={containerRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
            >
                <div className="mcp-modal-header">
                    <h3 id={titleId}>Pairing request</h3>
                </div>

                <div className="mcp-modal-body">
                    <p>
                        <strong>{request.name || request.deviceId}</strong> wants to pair with this machine.
                    </p>
                    <p className="help-text">Address: <code>{request.addr || 'unknown'}</code></p>
                    <p className="help-text">Device: <code>{request.deviceId}</code></p>
                    <p className="help-text">
                        Only accept if you recognize this device and were expecting it to pair.
                    </p>
                </div>

                <div className="mcp-modal-footer">
                    <button
                        className="confirm-btn cancel"
                        data-dialog-cancel
                        onClick={() => { void respond(false); }}
                        disabled={busy}
                    >
                        <Mnemonic label="Decline" char="D" />
                    </button>
                    <button
                        className="save-btn"
                        data-dialog-confirm
                        onClick={() => { void respond(true); }}
                        disabled={busy}
                    >
                        <Mnemonic label="Accept" char="A" />
                    </button>
                </div>
            </div>
        </div>
    );
};
