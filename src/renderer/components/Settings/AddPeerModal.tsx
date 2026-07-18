import React, { useId, useRef, useState } from 'react';
import { useDialogA11y } from '../UI/useDialogA11y';

interface AddPeerModalProps {
    /** Called after a successful `peerAdd` so the parent can refresh the list. */
    onAdded: () => void;
    onClose: () => void;
    /** The fabric peer port, from `fabricStatus().peerPort` — named in the unreachable-address
     *  guidance so a user behind a firewall knows which port to open. */
    peerPort?: number;
}

/**
 * Map a raw fabric/bridge error string to a distinct, actionable message.
 *
 * The substrings below are matched against the fabric's ACTUAL error wording, which now
 * reaches us intact: the core used to collapse every fabric failure to "fabric returned
 * 502 Bad Gateway" (it dropped the `{"error": ...}` body), so none of these branches could
 * ever fire on the failure that matters most — the remote having "Accept peers" off, which
 * the fabric reports verbatim as "pairing not enabled". Keep these aligned with the strings
 * in `peer_server.rs`; matching is substring-based so a reworded fabric error degrades to
 * the raw message rather than the wrong guidance.
 */
export function classifyPairError(raw: string, peerPort?: number): string {
    const m = raw.toLowerCase();
    const port = peerPort ?? 8790;

    // peer_server: `/pair/start` + `/pair/confirm` reject with "pairing not enabled" when
    // the remote's Accept-peers toggle is off — including right after a successful pair,
    // which auto-clears the flag.
    if (m.includes('pairing not enabled') || m.includes('not accepting')) {
        return 'That machine isn’t accepting peers right now. Ask them to open Settings → Peers, turn on “Accept incoming peer connections”, and show a fresh code.';
    }
    // Local fabric down (control_err's connect/timeout arms).
    if (m.includes('fabric is not running') || m.includes('fabric did not respond')) {
        return 'Peering isn’t running on this machine. Restart TermFlow and try again.';
    }
    // Transport: nothing listening, blackholed, or unroutable.
    if (
        m.includes('unreachable') ||
        m.includes('refused') ||
        m.includes('timed out') ||
        m.includes('timeout') ||
        m.includes('error sending request') ||
        m.includes('dns') ||
        m.includes('no route')
    ) {
        return `Couldn’t reach that address on port ${port}. Check the address, that the other machine is online, and that port ${port} is allowed through its firewall.`;
    }
    // peer_server rate limits — distinct from a bad code, and retryable.
    if (m.includes('too many')) {
        return 'That machine is temporarily rate-limiting pairing attempts. Wait a moment, then ask for a fresh code and try again.';
    }
    // Wrong, mistyped, expired, re-minted, or already-used code. "key confirmation failed"
    // is the fabric's wording for a wrong code (the code itself never crosses the wire).
    if (
        m.includes('key confirmation failed') ||
        m.includes('invalid or expired code') ||
        m.includes('expired') ||
        m.includes('replaced') ||
        m.includes('no pairing in progress') ||
        m.includes('pairing message') ||
        m.includes('code') ||
        m.includes('pake') ||
        m.includes('spake') ||
        m.includes('invalid') ||
        m.includes('mismatch')
    ) {
        return 'The pairing code was rejected — it may be mistyped or expired (codes last 2 minutes). Ask for a fresh code and re-enter it.';
    }
    return raw || 'Pairing failed. Please try again.';
}

/**
 * Dialog for adding a peer by its address + one-time pairing code (the initiating
 * side of the pairing flow). Calls `peerAdd(address, code)`; on failure it shows a
 * distinct, recoverable error. Built on the McpConnectModal styling + the shared
 * `useDialogA11y` focus-trap primitive.
 */
export const AddPeerModal: React.FC<AddPeerModalProps> = ({ onAdded, onClose, peerPort }) => {
    const [address, setAddress] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const addressRef = useRef<HTMLInputElement>(null);
    const titleId = useId();

    const canSubmit = address.trim().length > 0 && code.trim().length > 0 && !busy;

    const submit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            await window.electronAPI?.peerAdd?.(address.trim(), code.trim());
            onAdded();
            onClose();
        } catch (err) {
            const raw = err instanceof Error ? err.message : String(err);
            setError(classifyPairError(raw, peerPort));
        } finally {
            setBusy(false);
        }
    };

    // Text inputs are present, so bare-letter mnemonics would be suppressed while
    // typing anyway; rely on the form's submit button (Enter) + Esc to cancel.
    useDialogA11y(containerRef, {
        isOpen: true,
        onCancel: onClose,
        initialFocus: addressRef as React.RefObject<HTMLElement>,
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
                    <h3 id={titleId}>Add a peer</h3>
                    <button className="mcp-modal-close" onClick={onClose} aria-label="Close">✕</button>
                </div>

                <form
                    className="mcp-modal-body"
                    onSubmit={(e) => { e.preventDefault(); void submit(); }}
                >
                    <label className="setting-label" htmlFor={`${titleId}-addr`}>Address</label>
                    <input
                        id={`${titleId}-addr`}
                        ref={addressRef}
                        className="setting-input"
                        type="text"
                        placeholder="192.168.1.20  or  machine.tailnet.ts.net"
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                    />

                    <label className="setting-label" htmlFor={`${titleId}-code`}>Pairing code</label>
                    <input
                        id={`${titleId}-code`}
                        className="setting-input"
                        type="text"
                        placeholder="7-frog-castle-42"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                    />

                    <p className="help-text">
                        Ask the other machine to open Settings → Peers, turn on “Accept incoming
                        peer connections”, then “Show pairing code”. Enter that machine’s address
                        and the code here — codes expire after 2 minutes.
                    </p>
                    <p className="help-text">
                        Add <code>:port</code> to the address only if that machine uses a
                        non-default port; otherwise TermFlow dials port {peerPort ?? 8790}.
                    </p>

                    {error && <p className="add-peer-error" role="alert">{error}</p>}

                    <div className="mcp-modal-footer">
                        <button
                            type="button"
                            className="confirm-btn cancel"
                            data-dialog-cancel
                            onClick={onClose}
                            disabled={busy}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="save-btn"
                            data-dialog-confirm
                            disabled={!canSubmit}
                        >
                            {busy ? 'Pairing…' : 'Add peer'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
