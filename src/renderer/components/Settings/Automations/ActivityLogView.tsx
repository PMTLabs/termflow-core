/**
 * The full activity log, as a **view of the panel** rather than a second modal (mockup §06, §5.3).
 *
 * A modal over a modal over a tab is the shape worth avoiding, and the mockup already renders the
 * template gallery full-width with *← Back to the list*, so the log matches it.
 *
 * Every line carries both the terminal **id and the name**, and the name is the snapshot written
 * with the entry — never a lookup. Rename the tab, close it, restart the app, and an old line still
 * says what that terminal was called at the time. That is why a `failed` line can name a terminal
 * that had already closed.
 */
import React, { useMemo, useState } from 'react';
import type { AutomationLogEntry, AutomationRule } from '../../../types/electron';
import {
    collapseRuns,
    collapsedDetail,
    clockTime,
    LOG_KIND_CLASS,
    LOG_KIND_LABEL,
    LogFilter,
    logCopyText,
    passesFilter,
    rowTime,
} from './activityLog';

export interface ActivityLogViewProps {
    /** The rule this log is scoped to, or null for *All automations*. */
    rule: AutomationRule | null;
    entries: AutomationLogEntry[];
    newestFirst: boolean;
    onScopeChange: (ruleId: string | null) => void;
    onBack: () => void;
}

export const ActivityLogView: React.FC<ActivityLogViewProps> = ({
    rule,
    entries,
    newestFirst,
    onScopeChange,
    onBack,
}) => {
    const [filter, setFilter] = useState<LogFilter>('all');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());

    const rows = useMemo(
        () => collapseRuns(entries.filter((e) => passesFilter(e, filter))),
        [entries, filter],
    );

    const copy = () => {
        // Expanded, always: a log pasted into a bug report with seven decisions replaced by the
        // words "7 identical decisions collapsed" has lost the timestamps that made it evidence.
        void navigator.clipboard?.writeText(logCopyText(entries));
    };

    return (
        <div className="au-panel">
            <div className="au-panelhead">
                <div className="au-panelhead-text">
                    <h3>Activity</h3>
                    <p>
                        {rule ? rule.name : 'All automations'} ·{' '}
                        {newestFirst ? 'newest first' : 'oldest first'}
                    </p>
                </div>
                <button type="button" className="au-btn" onClick={onBack}>
                    ← Back to the list
                </button>
            </div>

            <div className="au-logbar">
                <div className="au-seg" role="group" aria-label="Log scope">
                    <button
                        type="button"
                        className={rule ? 'on' : ''}
                        disabled={!rule}
                        onClick={() => rule && onScopeChange(rule.id)}
                    >
                        This rule
                    </button>
                    <button
                        type="button"
                        className={rule ? '' : 'on'}
                        onClick={() => onScopeChange(null)}
                    >
                        All automations
                    </button>
                </div>
                <div className="au-chips" role="group" aria-label="Log filter">
                    {(['all', 'sent', 'problems'] as LogFilter[]).map((f) => (
                        <button
                            key={f}
                            type="button"
                            className={`au-chip${filter === f ? ' on' : ''}`}
                            aria-pressed={filter === f}
                            onClick={() => setFilter(f)}
                        >
                            {f === 'all' ? 'All' : f === 'sent' ? 'Sent only' : 'Problems'}
                        </button>
                    ))}
                </div>
            </div>

            <div
                className="au-logrows"
                tabIndex={0}
                role="region"
                aria-label={`Activity log entries, ${newestFirst ? 'newest' : 'oldest'} first`}
            >
                <div className="au-loghead" aria-hidden="true">
                    <span>Time</span>
                    <span>Terminal · name</span>
                    <span>What</span>
                    <span>Why</span>
                </div>

                {rows.length === 0 && (
                    <div className="au-logempty">
                        Nothing logged yet. Entries appear as soon as the rule makes a decision —
                        including the decisions where it deliberately stayed quiet.
                    </div>
                )}

                {rows.map((row) => {
                    const open = expanded.has(row.key);
                    const shown = row.collapsed && !open ? [] : row.entries;
                    return (
                        <React.Fragment key={row.key}>
                            {row.collapsed && !open && (
                                <div className={`au-logrow ${LOG_KIND_CLASS[row.first.kind]} collapsed`}>
                                    <span className="au-lgt">{rowTime(row)}</span>
                                    <span className="au-lgi">
                                        <span className="au-li">{row.first.terminalId ?? '—'}</span>
                                        <span className="au-ln">{row.first.terminalName ?? ''}</span>
                                    </span>
                                    <span className="au-lgk">
                                        {LOG_KIND_LABEL[row.first.kind]} ×{row.count}
                                    </span>
                                    <span className="au-lgd">
                                        {collapsedDetail(row)} —{' '}
                                        <button
                                            type="button"
                                            className="au-btn sm"
                                            onClick={() =>
                                                setExpanded((prev) => new Set(prev).add(row.key))}
                                        >
                                            show them
                                        </button>
                                    </span>
                                </div>
                            )}
                            {shown.map((entry) => (
                                <div key={entry.id} className={`au-logrow ${LOG_KIND_CLASS[entry.kind]}`}>
                                    <span className="au-lgt">{clockTime(entry.at)}</span>
                                    <span className="au-lgi">
                                        <span className="au-li">{entry.terminalId ?? '—'}</span>
                                        <span
                                            className={`au-ln${entry.terminalId ? '' : ' rule'}`}
                                        >
                                            {entry.terminalId ? (entry.terminalName ?? '') : 'whole rule'}
                                        </span>
                                    </span>
                                    <span className="au-lgk">{LOG_KIND_LABEL[entry.kind]}</span>
                                    <span className="au-lgd">{entry.detail}</span>
                                </div>
                            ))}
                        </React.Fragment>
                    );
                })}
            </div>

            <div className="au-logfoot">
                <span>Last 200 entries per rule, kept across restarts. Older ones are dropped.</span>
                <span className="au-grow" />
                <button type="button" className="au-btn sm" onClick={copy}>
                    Copy
                </button>
            </div>
        </div>
    );
};
