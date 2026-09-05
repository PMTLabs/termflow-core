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

/**
 * How long *Log every check* stays on before it turns itself off again.
 *
 * At a 10-second interval the verbose classes write 8,640 entries a day per terminal, and on the
 * *every time new output arrives* cadence they are unbounded — a chatty build writes faster than
 * anyone can read, and either way it evicts everything worth keeping from a 200-entry log. So it is
 * a deadline, not a switch: the store's own gate compares each entry's timestamp against it.
 */
export const VERBOSE_WINDOW_MS = 3600_000;

export interface ActivityLogViewProps {
    /** The rule this log is scoped to, or null for *All automations*. */
    rule: AutomationRule | null;
    entries: AutomationLogEntry[];
    newestFirst: boolean;
    /** The log could not be READ. Distinct from the log being empty (§7.8). */
    error: string | null;
    now: number;
    onScopeChange: (ruleId: string | null) => void;
    /** Writes `verboseUntil` through the id-keyed `setAutomationVerbose` command; `null` turns
     *  it off. NOT through `saveAutomation` — see the note at the switch itself for why that
     *  matters, and why moving it back would be a regression rather than a simplification. */
    onSetVerbose: (rule: AutomationRule, until: number | null) => void;
    onBack: () => void;
}

export const ActivityLogView: React.FC<ActivityLogViewProps> = ({
    rule,
    entries,
    newestFirst,
    error,
    now,
    onScopeChange,
    onSetVerbose,
    onBack,
}) => {
    const [filter, setFilter] = useState<LogFilter>('all');
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    // Derived, never stored: a deadline that has passed is off, and the backend NULLs stale ones at
    // startup anyway. Reading the flag as "is it set" would leave the toggle on after it expired.
    const isVerbose =
        rule?.verboseUntil !== null && rule?.verboseUntil !== undefined && rule.verboseUntil > now;

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
                {/*
                  * THE VERBOSE GATE'S ONLY WRITER (mockup §06's *Log every check*).
                  *
                  * Without it `verbose_until` was NULL for every rule that had ever existed, and the
                  * store drops every `Check`-class entry when it is — so `checked` and `no match`,
                  * two of the five row kinds §06 draws, could never appear at all. That made the
                  * section's own thesis false: a rule that does nothing looks exactly like a rule
                  * that is working perfectly and has correctly stayed quiet, and the rows that tell
                  * those apart were the two being gated off. Nothing in §12 assigned this to any
                  * milestone; it belongs with the log view, which is here.
                  *
                  * **It has its own command, and must keep it.** This used to say it needed
                  * none, because `save_rule` already persists whatever `verbose_until` the rule
                  * carries. That is true, it is why the switch was wired that way, and it is
                  * exactly why it had to be rewired: sending the whole rule back through
                  * `saveAutomation` is an unconditional upsert whose missing-rule arm INSERTS, so a
                  * logging switch flipped on a Settings list that had gone stale would resurrect a
                  * rule another window had deleted — and revert any edit made there meanwhile.
                  * `set_automation_verbose` takes the rule id and the deadline, decides existence
                  * inside the transaction that writes, and reports back a rule that is gone.
                  *
                  * It is also NOT a definition mutation, which is the other half the old sentence
                  * got wrong: verbose is a logging gate the engine never reads back, so the command
                  * deliberately does not `reload`, and `automation_commands.rs` carries a test
                  * asserting that it must not start one.
                  */}
                {rule && (
                    <span className="au-verbose">
                        Log every check
                        <button
                            type="button"
                            className="au-tog"
                            role="switch"
                            aria-checked={isVerbose}
                            aria-label={`Log every check for ${rule.name}`}
                            onClick={() =>
                                onSetVerbose(rule, isVerbose ? null : now + VERBOSE_WINDOW_MS)}
                        />
                        {isVerbose && (
                            <span className="au-verbose-until">
                                · off again at {clockTime(rule.verboseUntil ?? now).slice(0, 5)}
                            </span>
                        )}
                    </span>
                )}
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

                {error !== null && (
                    // The log view REPLACES the list, so the list's own error line is not on screen
                    // while this is showing — which is why §7.8 assigns the `Disabled` state to this
                    // view separately. It used to render the confident "Nothing logged yet" copy
                    // below over a store that was refusing to answer.
                    <div className="au-logempty au-logfailed" role="alert">
                        <b>The activity log could not be read.</b> This is not an empty log — the
                        store did not answer. {error}
                    </div>
                )}

                {error === null && rows.length === 0 && (
                    <div className="au-logempty">
                        Nothing logged yet. Entries appear as soon as the rule makes a decision —
                        including the decisions where it deliberately stayed quiet.
                        {!isVerbose && rule && (
                            <>
                                {' '}Ordinary checks are not recorded unless <b>Log every check</b> is
                                on.
                            </>
                        )}
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
