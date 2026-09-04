/**
 * One rule in the list (mockup §01).
 *
 * Every row answers four questions without being opened: what does this rule do, which terminals is
 * it watching — **by id** — is it on, and what is it doing *right now*. The colour stripe is the
 * runtime state; the toggle is the enabled state. Those are different things, so they get different
 * controls: collapsing them into one switch is what makes automation feel haunted.
 *
 * Everything shown here is derived by `automationState.ts` from the rule and the runtime payload, so
 * a row can never describe a rule the engine is not running.
 */
import React from 'react';
import type { AutomationRule } from '../../../types/electron';
import type { AutomationRuntimePairState } from '../../../services/automationEvents';
import {
    automationRowState,
    describeCadence,
    describeCriterion,
    describeLastFired,
    describeRule,
    describeWatching,
} from './automationState';

export interface AutomationRowProps {
    rule: AutomationRule;
    pairs: Record<string, AutomationRuntimePairState> | undefined;
    now: number;
    onToggle: (rule: AutomationRule, enabled: boolean) => void;
    onEdit: (rule: AutomationRule) => void;
    onDuplicate: (rule: AutomationRule) => void;
    onLog: (rule: AutomationRule) => void;
    onDelete: (rule: AutomationRule) => void;
    onReset: (rule: AutomationRule) => void;
    /** Drop a pinned id that has not come back. */
    onForget: (rule: AutomationRule, terminalIds: string[]) => void;
}

export const AutomationRow: React.FC<AutomationRowProps> = ({
    rule,
    pairs,
    now,
    onToggle,
    onEdit,
    onDuplicate,
    onLog,
    onDelete,
    onReset,
    onForget,
}) => {
    const state = automationRowState(rule, pairs, now);
    const sentence = describeRule(rule);
    const missing = Object.entries(pairs ?? {})
        .filter(([, p]) => p.missing)
        .map(([tm]) => tm);
    // **Forgettable is narrower than missing, and the difference is a button that does nothing.**
    // `missing` is computed backend-side as `watched_set \ live`, and for a criterion rule with
    // `followNew: false` the watched set is a FROZEN match list that has no relationship to
    // `targetIds` — which is empty for such a rule. *Forget it* filtered `targetIds`, removed
    // nothing, saved an unchanged rule, wrote a `saved` log line claiming to have replaced a
    // version, and left the row exactly as it was. Clickable forever, with a log entry each time.
    const forgettable = rule.targetMode === 'pinned'
        ? missing.filter((tm) => rule.targetIds.includes(tm))
        : [];
    const watched = Object.keys(pairs ?? {});
    const fired = Object.values(pairs ?? {}).reduce((n, p) => n + p.firedCount, 0);
    const lastFired = Object.values(pairs ?? {}).reduce<number | null>(
        (best, p) => (p.lastFiredAt !== null && (best === null || p.lastFiredAt > best)
            ? p.lastFiredAt
            : best),
        null,
    );

    return (
        <div className={`au-row${rule.enabled ? '' : ' au-off'}`} data-state={state.id}>
            <div className="au-stripe" />
            <div className="au-main">
                <div className="au-top">
                    <span className="au-name">{rule.name}</span>
                    <span className={`au-runmode ${rule.runsOnce ? 'once' : 'rep'}`}>
                        {rule.runsOnce ? 'Runs once' : 'Repeatable'}
                    </span>
                </div>

                <div className="au-sentence">
                    {sentence.lead} <b>{sentence.subject}</b>
                    {sentence.verb && (
                        <>
                            {' '}<span className="au-arrow">{sentence.verb}</span>{' '}
                            <b>{sentence.threshold}</b>
                        </>
                    )}{' '}
                    <span className="au-arrow">→</span> {sentence.verbSend}{' '}
                    <span className="au-msg">&quot;{sentence.message}&quot;</span>
                    {sentence.sendNote && <span className="au-arrow">{sentence.sendNote}</span>}
                </div>

                <div className="au-meta">
                    <span className="au-k">
                        ◉ Watching <span className="au-term">{describeWatching(rule, pairs)}</span>
                    </span>
                    {watched.length > 0 && (
                        <span className="au-k">
                            {watched.map((tm) => (
                                <span
                                    key={tm}
                                    className={`au-idchip${pairs?.[tm]?.missing ? ' gone' : ''}`}
                                >
                                    {tm}
                                    {pairs?.[tm]?.missing ? ' — not open' : ''}
                                </span>
                            ))}
                        </span>
                    )}
                    <span className="au-k">↻ {describeCadence(rule)}</span>
                    <span className="au-k au-hist">
                        {rule.completedAt
                            ? `✓ Completed ${new Date(rule.completedAt).toLocaleString()} — will not run again`
                            : lastFired !== null
                                ? `⏱ Fired ${describeLastFired(lastFired, now)} · ${fired} ${fired === 1 ? 'time' : 'times'}`
                                : '⏱ Never fired'}
                    </span>
                </div>

                {state.id === 'error' && (
                    <div className="au-errline">
                        <span aria-hidden="true">⚠</span>
                        {missing.length > 0 ? (
                            <span>
                                <b>
                                    {missing.length === 1
                                        ? 'One pinned terminal is gone.'
                                        : `${missing.length} pinned terminals are gone.`}
                                </b>{' '}
                                <code>{missing.join(', ')}</code> {missing.length === 1 ? 'has' : 'have'}{' '}
                                not been seen since the tab was closed. The others are still watched,
                                so the rule keeps running. An id comes back if the session is
                                restored — a tab closed for good never does.
                            </span>
                        ) : (
                            <span>
                                <b>Nothing to watch.</b> No open terminal matches{' '}
                                <code>{describeCriterion(rule)}</code>. It will start watching on its
                                own as soon as one opens.
                            </span>
                        )}
                    </div>
                )}
            </div>

            <div className="au-side">
                <span className={`au-pill ${state.id}`}>
                    <span className="au-pd" />
                    {state.pillText}
                </span>
                <div className="au-acts">
                    <button
                        type="button"
                        className="au-tog"
                        role="switch"
                        aria-checked={rule.enabled}
                        disabled={state.toggleDisabled}
                        aria-label={
                            state.toggleDisabled
                                ? 'Enabled (completed, cannot run again until reset)'
                                : `Enable ${rule.name}`
                        }
                        onClick={() => onToggle(rule, !rule.enabled)}
                    />
                    {state.id === 'completed' && (
                        <button type="button" className="au-btn sm" onClick={() => onReset(rule)}>
                            Reset
                        </button>
                    )}
                    {forgettable.length > 0 && (
                        <button
                            type="button"
                            className="au-btn sm"
                            onClick={() => onForget(rule, forgettable)}
                        >
                            Forget it
                        </button>
                    )}
                    <button type="button" className="au-btn sm" onClick={() => onEdit(rule)}>
                        Edit
                    </button>
                    <button
                        type="button"
                        className="au-btn sm icon"
                        title="Duplicate"
                        aria-label={`Duplicate ${rule.name}`}
                        onClick={() => onDuplicate(rule)}
                    >
                        ⧉
                    </button>
                    <button
                        type="button"
                        className="au-btn sm icon"
                        title="Activity log"
                        aria-label={`Activity log for ${rule.name}`}
                        onClick={() => onLog(rule)}
                    >
                        ☰
                    </button>
                    <button
                        type="button"
                        className="au-btn sm icon danger"
                        title="Delete"
                        aria-label={`Delete ${rule.name}`}
                        onClick={() => onDelete(rule)}
                    >
                        ⌫
                    </button>
                </div>
            </div>
        </div>
    );
};
