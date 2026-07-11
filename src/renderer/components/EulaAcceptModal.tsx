import React, { useEffect, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../store';
import { setEulaAcceptedVersion } from '../store/slices/settingsSlice';
import { CURRENT_EULA_VERSION, LEGAL_LINKS, isLive } from '../legal';
import { useDialogA11y, Mnemonic as MnemonicType } from './UI/useDialogA11y';
import { Mnemonic } from './UI/Mnemonic';

/**
 * First-run EULA acceptance gate (mounted once at the App root, like GlobalPeerRequests).
 *
 * Shows a mandatory modal until the user accepts the current EULA version:
 *  - visible only when `eulaHydrated` (config loaded, no first-paint flash) AND the stored
 *    `eulaAcceptedVersion` !== CURRENT_EULA_VERSION (never accepted, or the EULA changed);
 *  - the EULA text is read from the bundled resource (`readLegalDocument('EULA.txt')`);
 *  - Accept persists the current version to config.json (survives restart); Decline quits.
 *
 * Esc is intentionally inert (no `onCancel`) and initial focus lands on the scrollable text
 * (not a button) so a stray Enter can never auto-accept a legal agreement.
 */
export const EulaAcceptModal: React.FC = () => {
    const dispatch = useDispatch<AppDispatch>();
    const hydrated = useSelector((s: RootState) => s.settings.eulaHydrated);
    const acceptedVersion = useSelector((s: RootState) => s.settings.eulaAcceptedVersion);
    const containerRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const [text, setText] = useState<string>('Loading agreement…');
    const [busy, setBusy] = useState(false);

    const needsAccept = hydrated && acceptedVersion !== CURRENT_EULA_VERSION;

    useEffect(() => {
        if (!needsAccept) return;
        let cancelled = false;
        (async () => {
            try {
                const t = await window.electronAPI?.readLegalDocument?.('EULA.txt');
                if (!cancelled && t) setText(t);
            } catch (err) {
                console.error('readLegalDocument(EULA.txt) failed:', err);
                if (!cancelled) {
                    setText('The agreement could not be loaded from this build. See the online terms below.');
                }
            }
        })();
        return () => { cancelled = true; };
    }, [needsAccept]);

    const accept = () => {
        if (busy) return;
        setBusy(true);
        dispatch(setEulaAcceptedVersion(CURRENT_EULA_VERSION));
    };

    const decline = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await window.electronAPI?.quitApp?.();
        } catch (err) {
            console.error('quitApp failed:', err);
            setBusy(false);
        }
    };

    const openLink = (url: string) => (e: React.MouseEvent) => {
        e.preventDefault();
        void window.electronAPI?.openExternal?.(url);
    };

    const mnemonics: MnemonicType[] = [
        { key: 'A', handler: accept },
        { key: 'D', handler: () => { void decline(); } },
    ];

    useDialogA11y(containerRef, {
        isOpen: needsAccept,
        // No onCancel → Esc is inert (this modal is mandatory).
        mnemonics,
        initialFocus: bodyRef as React.RefObject<HTMLElement>, // the scroll region, not a button
    });

    if (!needsAccept) return null;

    const onlineLinks = LEGAL_LINKS.filter(isLive);

    return (
        <div className="mcp-modal-overlay">
            <div
                className="mcp-modal"
                ref={containerRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="eula-title"
                tabIndex={-1}
                style={{ maxWidth: 620 }}
            >
                <div className="mcp-modal-header">
                    <h3 id="eula-title">Before you continue</h3>
                </div>

                <div className="mcp-modal-body">
                    <p className="help-text">Please review and accept the agreement to use TermFlow.</p>
                    <div
                        ref={bodyRef}
                        tabIndex={0}
                        style={{
                            maxHeight: 300,
                            overflowY: 'auto',
                            padding: '10px 12px',
                            border: '1px solid var(--border-color, #333)',
                            borderRadius: 6,
                            background: 'var(--input-bg, rgba(0,0,0,0.2))',
                        }}
                    >
                        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit', fontSize: 12 }}>{text}</pre>
                    </div>
                    {onlineLinks.length > 0 && (
                        <p className="help-text" style={{ marginTop: 10 }}>
                            Full terms online:{' '}
                            {onlineLinks.map((l, i) => (
                                <React.Fragment key={l.url}>
                                    {i > 0 && ' · '}
                                    <a href={l.url} onClick={openLink(l.url)}>{l.label}</a>
                                </React.Fragment>
                            ))}
                        </p>
                    )}
                </div>

                <div className="mcp-modal-footer">
                    <button
                        className="confirm-btn cancel"
                        data-dialog-cancel
                        onClick={() => { void decline(); }}
                        disabled={busy}
                    >
                        <Mnemonic label="Decline & Quit" char="D" />
                    </button>
                    <button
                        className="save-btn"
                        data-dialog-confirm
                        onClick={accept}
                        disabled={busy}
                    >
                        <Mnemonic label="Accept" char="A" />
                    </button>
                </div>
            </div>
        </div>
    );
};
