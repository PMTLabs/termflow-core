import React, { useId, useRef, useState } from 'react';
import { useDialogA11y } from '../UI/useDialogA11y';

interface AddPeerModalProps {
    /** Called after a successful `peerAdd` so the parent can refresh the list. */
    onAdded: () => void;
    onClose: () => void;
}

/**
 * Map a raw fabric/bridge error string to a distinct, actionable message. The
 * three recoverable pairing failures (unreachable address, bad/expired code, the
 * other side not accepting peers) each get their own guidance; anything else
 * falls through to the raw message. Heuristic (substring) matching keeps the core
 * agnostic to the fabric's exact error wording.
 */
function classifyPairError(raw: string): string {
    const m = raw.toLowerCase();
    if (
        m.includes('not accepting') ||
        m.includes('accept-disabled') ||
        m.includes('accept disabled') ||
        m.includes('rejected pairing')
    ) {
        return 'That machine isn’t accepting peers right now. Ask them to enable “Accept peers” and show a fresh code.';
    }
    if (
        m.includes('unreachable') ||
        m.includes('refused') ||
        m.includes('timed out') ||
        m.includes('timeout') ||
        m.includes('connect') ||
        m.includes('dns') ||
        m.includes('no route')
    ) {
        return 'Couldn’t reach that address. Check the address and that the other machine is online.';
    }
    if (
        m.includes('code') ||
        m.includes('pake') ||
        m.includes('spake') ||
        m.includes('expired') ||
        m.includes('invalid') ||
        m.includes('mismatch')
    ) {
        return 'The pairing code was rejected — it may be mistyped or expired. Ask for a fresh code and re-enter it.';
    }
    return raw || 'Pairing failed. Please try again.';
}

/**
 * Dialog for adding a peer by its address + one-time pairing code (the initiating
 * side of the pairing flow). Calls `peerAdd(address, code)`; on failure it shows a
 * distinct, recoverable error. Built on the McpConnectModal styling + the shared
 * `useDialogA11y` focus-trap primitive.
 */
export const AddPeerModal: React.FC<AddPeerModalProps> = ({ onAdded, onClose }) => {
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
            setError(classifyPairError(raw));
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
                        Ask the other machine to open Settings → Peers, enable “Accept peers”, and
                        “Show pairing code”. Enter that machine’s address and the code here.
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
