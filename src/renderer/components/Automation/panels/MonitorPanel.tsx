/**
 * *Watch output* — which terminals, what to read, and how often (mockup §04, panels 1 and 2).
 *
 * The first two panels of §04 are the two branches of one radio: **pick by hand** stores the ids you
 * ticked, **match a rule** stores the description and resolves it to ids continuously. Both are
 * here, because they are one decision.
 */
import React from 'react';
import type {
    AutomationCriterion,
    AutomationTargetPreview,
    WatchableTerminal,
} from '../../../types/electron';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import type { PanelModel } from '../automationDerive';
import { AuTerminalPicker } from '../AuTerminalPicker';
import { AuCheck, AuField, AuHelp, AuRadio } from './AuFields';
import { AuSelect } from '../AuSelect';

const CRITERIA: Array<{ id: AutomationCriterion; label: string }> = [
    { id: 'commandContains', label: 'Command contains' },
    { id: 'tabNameContains', label: 'Tab name contains' },
    { id: 'workingFolderUnder', label: 'Working folder is under' },
    { id: 'terminalIdIs', label: 'Terminal ID is' },
    { id: 'allTerminals', label: 'All terminals' },
];

const INTERVALS = [
    { ms: 10000, label: 'Every 10 seconds' },
    { ms: 30000, label: 'Every 30 seconds' },
    { ms: 60000, label: 'Every minute' },
    { ms: 300000, label: 'Every 5 minutes' },
    { ms: 900000, label: 'Every 15 minutes' },
];

export interface MonitorPanelProps {
    draft: AutomationDraft;
    model: PanelModel;
    terminals: WatchableTerminal[];
    terminalsError: string | null;
    terminalsLoading: boolean;
    dispatch: (action: DraftAction) => void;
}

export const MonitorPanel: React.FC<MonitorPanelProps> = ({
    draft,
    model,
    terminals,
    terminalsError,
    terminalsLoading,
    dispatch,
}) => {
    const { rule } = draft;
    const { monitor } = rule.graph;
    const [targetPreview, setTargetPreview] = React.useState<AutomationTargetPreview | null>(null);
    const previewTargets = typeof window === 'undefined'
        ? undefined
        : window.electronAPI?.previewAutomationTargets;

    React.useEffect(() => {
        if (rule.targetMode !== 'rule' || !previewTargets) {
            setTargetPreview(null);
            return undefined;
        }

        let current = true;
        void previewTargets(rule, terminals)
            .then((preview) => {
                if (current) setTargetPreview(preview);
            })
            .catch(() => {
                if (current) setTargetPreview(null);
            });
        return () => {
            current = false;
        };
    }, [previewTargets, rule, terminals]);

    return (
        <>
            <AuField label="Which terminals">
                <AuRadio
                    name="au-targetmode"
                    on={rule.targetMode === 'pinned'}
                    title="These terminals"
                    sub="Pick from what's open now — stores their ids"
                    onPick={() => dispatch({ type: 'targetMode', mode: 'pinned' })}
                />
                <AuRadio
                    name="au-targetmode"
                    on={rule.targetMode === 'rule'}
                    title="Terminals matching a rule"
                    sub="Picks up new terminals, and re-resolves after a restart"
                    onPick={() => dispatch({ type: 'targetMode', mode: 'rule' })}
                />
            </AuField>

            {rule.targetMode === 'rule' ? (
                <>
                    <AuField label="Rule">
                        <div className="au-frow">
                            <AuSelect
                                style={{ flex: 1.15 }}
                                ariaLabel="What the terminals must match"
                                value={rule.criterion}
                                options={CRITERIA.map((c) => ({ value: c.id, label: c.label }))}
                                onChange={(value) =>
                                    dispatch({
                                        type: 'criterion',
                                        criterion: value as AutomationCriterion,
                                    })}
                            />
                            {rule.criterion !== 'allTerminals' && (
                                <input
                                    className="au-finput"
                                    style={{ flex: 1 }}
                                    aria-label="Value to match"
                                    value={rule.criterionValue}
                                    onChange={(e) =>
                                        dispatch({ type: 'criterionValue', value: e.target.value })}
                                />
                            )}
                        </div>
                        <AuCheck
                            on={rule.followNew}
                            label="Also watch matching terminals opened later"
                            onToggle={() => dispatch({ type: 'followNew', followNew: !rule.followNew })}
                        />
                        <AuHelp>
                            <b>Terminal ID is</b> takes one id, like <code>tm-a71f3c92k</code> — the
                            same id the picker and the log show. Use it to pin a single terminal
                            without ticking it.
                        </AuHelp>
                    </AuField>

                    <AuField label="Except these">
                        <AuTerminalPicker
                            rows={terminals}
                            picked={rule.excludedIds ?? []}
                            error={terminalsError}
                            loading={terminalsLoading}
                            onToggle={(id) => dispatch({ type: 'toggleExcludedTarget', id })}
                            onSet={(ids) => dispatch({ type: 'excludedTargets', ids })}
                        />
                    </AuField>

                    <AuField label="… and anything matching this exception">
                        <div className="au-frow">
                            <AuSelect
                                style={{ flex: 1.15 }}
                                ariaLabel="What the exception must match"
                                value={rule.excludeCriterion ?? ''}
                                options={[
                                    { value: '', label: 'No matching exception' },
                                    ...CRITERIA.map((c) => ({ value: c.id, label: c.label })),
                                ]}
                                onChange={(value) =>
                                    dispatch({
                                        type: 'excludeCriterion',
                                        criterion: value === ''
                                            ? null
                                            : value as AutomationCriterion,
                                    })}
                            />
                            {rule.excludeCriterion != null
                                && rule.excludeCriterion !== 'allTerminals' && (
                                <input
                                    className="au-finput"
                                    style={{ flex: 1 }}
                                    aria-label="Value the exception must match"
                                    value={rule.excludeCriterionValue ?? ''}
                                    onChange={(e) =>
                                        dispatch({ type: 'excludeCriterionValue', value: e.target.value })}
                                />
                            )}
                        </div>
                    </AuField>

                    {targetPreview === null ? (
                        <div className="au-termcount">Resolving matching terminals…</div>
                    ) : (
                        <div className="au-termcount" aria-live="polite">
                            Matching <span className="au-n">{targetPreview.matched.length}</span>
                            {' - '}excluded <span className="au-n">{targetPreview.excluded.length}</span>
                            {' = '}watching <span className="au-n">{targetPreview.watching.length}</span>
                            {targetPreview.watching.length === 0 && ' — nothing is being watched'}
                        </div>
                    )}
                </>
            ) : (
                <AuTerminalPicker
                    rows={terminals}
                    picked={rule.targetIds}
                    error={terminalsError}
                    loading={terminalsLoading}
                    onToggle={(id) => dispatch({ type: 'toggleTarget', id })}
                    onSet={(ids) => dispatch({ type: 'targets', ids })}
                />
            )}

            <div className="au-storedas">
                <span className="au-c">// what the rule stores</span>
                <br />
                <span className="au-k">watch</span>{' '}
                {/* `missing` comes with the value and is part of it: the face draws a stand-in in
                    the warning colour, and a panel drawing the same words plain would be the two
                    renderers disagreeing about whether the rule is finished. */}
                <span className={`au-v${model.values.terminals.missing ? ' warn' : ''}`}>
                    {model.values.terminals.text}
                </span>
            </div>

            {/* **Only the step-bound half is conditional.** Targeting above is the rule's own
                columns, not fields of the monitor step (plan 032 §3.1), so a rule with no monitor
                step still picks its terminals here — it simply has no read mode or cadence to
                choose. Authoring the step onto such a rule belongs to the palette (tasks 23-25). */}
            {monitor && (
            <>
            <AuField label="What to read">
                <AuRadio
                    name="au-read"
                    on={monitor.read === 'newOutput'}
                    title="New output as it appears"
                    sub="Every line the terminal prints, live"
                    onPick={() => dispatch({ type: 'monitor', patch: { read: 'newOutput' } })}
                />
                <AuRadio
                    name="au-read"
                    on={monitor.read === 'onScreen'}
                    title="What's on screen right now"
                    sub="Re-reads the visible screen each check — better for status lines that update in place"
                    onPick={() => dispatch({ type: 'monitor', patch: { read: 'onScreen' } })}
                />
                {/* Under both radios rather than beside one: it narrows whichever of them is
                    picked, and a shell echoing a half-typed command reaches `newOutput` exactly as
                    an input box reaches `onScreen`. */}
                <AuCheck
                    on={monitor.skipTypedLine === true}
                    label="Ignore the line being typed"
                    sub="A command you are still typing is on the screen like anything else. Skips the line the cursor is on, so it cannot fire the rule — everything else is still read, including a status line below it."
                    onToggle={() => dispatch({
                        type: 'monitor',
                        patch: { skipTypedLine: !monitor.skipTypedLine },
                    })}
                />
            </AuField>

            <AuField label="How often to check">
                <AuRadio
                    name="au-cadence"
                    on={monitor.cadence === 'onOutput'}
                    title="Every time new output arrives"
                    onPick={() => dispatch({ type: 'monitor', patch: { cadence: 'onOutput' } })}
                />
                <AuRadio
                    name="au-cadence"
                    on={monitor.cadence === 'timer'}
                    title="On a timer"
                    sub="Steadier, and much cheaper on a chatty terminal"
                    onPick={() => dispatch({ type: 'monitor', patch: { cadence: 'timer' } })}
                />
                {monitor.cadence === 'timer' && (
                    <div className="au-frow" style={{ marginTop: 8 }}>
                        <AuSelect
                            ariaLabel="How often to check"
                            value={String(monitor.everyMs)}
                            options={[
                                /* A stored interval that is not on the list — an older rule, or one
                                   written by a script — keeps its own row rather than being silently
                                   snapped to the nearest offered value. */
                                ...(INTERVALS.some((i) => i.ms === monitor.everyMs)
                                    ? []
                                    : [{
                                        value: String(monitor.everyMs),
                                        label: `Every ${Math.round(monitor.everyMs / 1000)} seconds`,
                                    }]),
                                ...INTERVALS.map((i) => ({ value: String(i.ms), label: i.label })),
                            ]}
                            onChange={(value) =>
                                dispatch({
                                    type: 'monitor',
                                    patch: { everyMs: Number(value) },
                                })}
                        />
                    </div>
                )}
            </AuField>
            </>
            )}
        </>
    );
};
