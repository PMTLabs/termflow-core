/**
 * The drawer's *Activity* tab — this rule's recent lines (mockup §03's drawer, §06).
 *
 * **It renders only what was stored.** Each row carries the terminal's name as a snapshot taken when
 * the line was written, and this component shows that string or an empty column. There is no store
 * read, no lookup by id, no fallback guess — and a source-derived test (§10.23) fails if this file
 * ever grows one, because a display-time resolution cannot be spotted by looking at the output: it
 * looks right for every live terminal and rewrites history for the rest.
 *
 * That is R17 expressed as a test rather than a comment. The specific line it protects is
 * `failed — the terminal closed`, which is written *after* the terminal is gone: a lookup returns
 * nothing for exactly the row the column exists to serve, and a rename would silently rewrite every
 * past line.
 *
 * The full log — filters, collapsing, *Log every check* — lives in the Settings panel's own view.
 * This is a peek, newest first, with a way through to it.
 */
import React from 'react';
import type { AutomationLogEntry } from '../../types/electron';
import { LOG_KIND_CLASS, LOG_KIND_LABEL, clockTime } from '../Settings/Automations/activityLog';
import { redactWebhookLogEntry } from './webhookRedaction';

export interface AuActivityPaneProps {
    entries: AutomationLogEntry[];
    error: string | null;
    /** `true` once the rule has been saved; a draft has no history and says so differently. */
    saved: boolean;
    onOpenFullLog: () => void;
}

export const AuActivityPane: React.FC<AuActivityPaneProps> = ({
    entries,
    error,
    saved,
    onOpenFullLog,
}) => {
    // Keep this drawer independent of the Settings log's fetch path while applying the same
    // last-resort redaction to every field it renders.
    const redactedEntries = entries.map(redactWebhookLogEntry);
    return (
    <div className="au-dpane" role="tabpanel" aria-label="Activity">
        {error !== null && (
            <div className="au-logempty au-logfailed" role="alert">
                <b>This rule&apos;s activity could not be read.</b>
                <br />
                The rule itself is unaffected — if it is switched on it is still running, and the
                lines it writes are still being kept.
            </div>
        )}

        {error === null && redactedEntries.length === 0 && (
            <div className="au-logempty">
                <b>No activity yet.</b>
                <br />
                {saved
                    ? 'This rule has never been switched on, so there is nothing to trace.'
                    : 'This rule has never been saved, so it has no history yet.'}
            </div>
        )}

        {error === null && redactedEntries.length > 0 && (
            <>
                <div className="au-logrows">
                    {redactedEntries.map((entry) => (
                        <div key={entry.id} className={`au-logrow ${LOG_KIND_CLASS[entry.kind]}`}>
                            <span className="au-lgt">{clockTime(entry.at)}</span>
                            <span className="au-lgi">
                                <span className="au-li">{entry.terminalId ?? '—'}</span>
                                <span className="au-ln">{entry.terminalName ?? ''}</span>
                            </span>
                            <span className="au-lgk">{LOG_KIND_LABEL[entry.kind]}</span>
                            <span className="au-lgd">{entry.detail}</span>
                        </div>
                    ))}
                </div>
                <div className="au-logfoot">
                    <span>Newest first · last 200 kept</span>
                    <span className="au-grow" />
                    <button type="button" className="au-btn sm" onClick={onOpenFullLog}>
                        Open the full log
                    </button>
                </div>
            </>
        )}
    </div>
    );
};
