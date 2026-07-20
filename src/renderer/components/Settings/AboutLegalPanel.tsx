import React, { useCallback, useState } from 'react';
import { BUNDLED_DOCS, LEGAL_LINKS, isLive, BundledDoc } from '../../legal';

/**
 * Settings → About & Legal. Lists the agreements/notices bundled with this build (read via
 * `readLegalDocument`) and links to the canonical online versions on the site. A doc that
 * isn't in this build (e.g. the Pro-only FSL fabric license in an OSS build) surfaces a
 * neutral "not included" note rather than an error.
 */
export const AboutLegalPanel: React.FC = () => {
    const [selected, setSelected] = useState<BundledDoc | null>(null);
    const [text, setText] = useState<string>('');
    const [error, setError] = useState<string | null>(null);

    const view = useCallback(async (doc: BundledDoc) => {
        setSelected(doc);
        setText('Loading…');
        setError(null);
        try {
            const t = await window.electronAPI?.readLegalDocument?.(doc.file);
            setText(t ?? '');
        } catch (err) {
            console.error('readLegalDocument failed:', err);
            setText('');
            setError(
                doc.proOnly
                    ? 'This document is only included in Pro builds (which bundle the peering fabric).'
                    : 'This document could not be loaded from the current build.',
            );
        }
    }, []);

    const openLink = (url: string) => (e: React.MouseEvent) => {
        e.preventDefault();
        void window.electronAPI?.openExternal?.(url);
    };

    const online = LEGAL_LINKS.filter(isLive);

    return (
        <div className="settings-section">
            <h2>About &amp; Legal</h2>
            <p className="section-description">
                Agreements and open-source notices bundled with this build.
            </p>

            <div className="peers-toolbar">
                {BUNDLED_DOCS.map((d) => (
                    <button key={d.file} className="link-btn" onClick={() => { void view(d); }}>
                        {d.title}
                    </button>
                ))}
            </div>

            {online.length > 0 && (
                <p className="help-text">
                    Canonical online versions:{' '}
                    {online.map((l, i) => (
                        <React.Fragment key={l.url}>
                            {i > 0 && ' · '}
                            <a href={l.url} onClick={openLink(l.url)} style={{ color: '#4ea1ff' }}>{l.label}</a>
                        </React.Fragment>
                    ))}
                </p>
            )}

            {selected && (
                <div className="connection-card" style={{ marginTop: 12 }}>
                    <div className="peer-head">
                        <strong>{selected.title}</strong>
                    </div>
                    {error ? (
                        <p className="help-text">{error}</p>
                    ) : (
                        <div
                            style={{
                                maxHeight: 340,
                                overflowY: 'auto',
                                padding: '10px 12px',
                                border: '1px solid var(--border-color, #333)',
                                borderRadius: 6,
                                background: 'var(--input-bg, rgba(0,0,0,0.2))',
                            }}
                        >
                            <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit', fontSize: 12 }}>
                                {text}
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
