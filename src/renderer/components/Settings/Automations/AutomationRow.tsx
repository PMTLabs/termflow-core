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
    describeWatching,
} from './automationState';
import { describeRule } from '../../Automation/automationDerive';
import { AuRuleSentence } from '../../Automation/AuRuleSentence';

/**
 * The footer's fire history is the ENGINE'S LIVE STATE, and it is not the rule's lifetime.
 *
 * `fired` and `lastFired` are folded from the `automation:state` payload, which the engine holds in
 * memory. `Runtime::forget_rule` purges `fires` along with the arm keys, and it runs whenever a rule
 * is switched off, saved with a change, or completes — plus for every rule whose `updated_at` moved
 * across a `reload` (Q11). A restart clears the lot, because the map starts empty in a new process.
 *
 * So the row wrote **Never fired** for a rule whose own activity log listed four `sent` lines from
 * an hour earlier — seen live, on a rule that had fired four times before the app was relaunched.
 * That is the mockup's own prohibition turned on the original: *"Copying history would make the copy
 * lie about a terminal it has never seen"* (§01, beside `Never fired · no history`). Both branches
 * were lifetime sentences written from run-scoped numbers, so both are scoped here rather than only
 * the one that happened to be caught — the same class as the pill's false *Fired*, which
 * `everFired` fixed at the other end.
 *
 * The activity log is the surface that does keep history, and the tooltip points at it.
 */
const HISTORY_SCOPE = 'since it started running';
const RUNTIME_HISTORY_SCOPE = 'The engine counts this while the rule runs. It starts from nothing '
    + 'again when TermFlow restarts, when the rule is switched off, and when it is saved with a '
    + 'change — the activity log keeps the history that outlives all three.';

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
    // The banner's noun, for the same reason `forgettable` exists just above: a criterion rule's
    // watched set is a frozen MATCH list, not a set of pins, so calling its terminals "pinned"
    // describes a relationship the rule does not have. Both modes reach the banner.
    const goneNoun = rule.targetMode === 'pinned' ? 'pinned' : 'watched';
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
                    <AuRuleSentence sentence={sentence} />
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
                    <span className="au-k au-hist" title={RUNTIME_HISTORY_SCOPE}>
                        {rule.completedAt
                            ? `✓ Completed ${new Date(rule.completedAt).toLocaleString()} — will not run again`
                            : lastFired !== null
                                ? `⏱ Fired ${describeLastFired(lastFired, now)} · ${fired} ${fired === 1 ? 'time' : 'times'} ${HISTORY_SCOPE}`
                                : `⏱ Not fired ${HISTORY_SCOPE}`}
                    </span>
                </div>

                {state.id === 'error' && (
                    <div className="au-errline">
                        <span aria-hidden="true">⚠</span>
                        {missing.length > 0 ? (
                            <span>
                                <b>
                                    {missing.length === 1
                                        ? `One ${goneNoun} terminal is gone.`
                                        : `${missing.length} ${goneNoun} terminals are gone.`}
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
