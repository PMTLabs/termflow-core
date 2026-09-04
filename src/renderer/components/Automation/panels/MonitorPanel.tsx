/**
 * *Watch output* — which terminals, what to read, and how often (mockup §04, panels 1 and 2).
 *
 * The first two panels of §04 are the two branches of one radio: **pick by hand** stores the ids you
 * ticked, **match a rule** stores the description and resolves it to ids continuously. Both are
 * here, because they are one decision.
 */
import React from 'react';
import type { AutomationCriterion, WatchableTerminal } from '../../../types/electron';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import type { PanelModel } from '../automationDerive';
import { AuTerminalPicker } from '../AuTerminalPicker';
import { AuCheck, AuField, AuHelp, AuRadio } from './AuFields';

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
    const matching = terminals.filter((t) => t.alive).length;

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
                            <select
                                className="au-finput"
                                style={{ flex: 1.15 }}
                                aria-label="What the terminals must match"
                                value={rule.criterion}
                                onChange={(e) =>
                                    dispatch({
                                        type: 'criterion',
                                        criterion: e.target.value as AutomationCriterion,
                                    })}
                            >
                                {CRITERIA.map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {c.label}
                                    </option>
                                ))}
                            </select>
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

                    <div className="au-termcount">
                        Open right now <span className="au-n">{matching}</span>
                        <span className="au-as"> · refreshed every few seconds</span>
                    </div>
                    <AuHelp>
                        This count is every terminal that is open, not every terminal this rule
                        matches — matching is decided in the engine, against the command line and
                        working folder it can see, and the rule&apos;s own row reports what it
                        actually watches.
                    </AuHelp>
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
                <span className="au-v">{model.values.terminals.text}</span>
            </div>

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
                        <select
                            className="au-finput"
                            aria-label="How often to check"
                            value={monitor.everyMs}
                            onChange={(e) =>
                                dispatch({
                                    type: 'monitor',
                                    patch: { everyMs: Number(e.target.value) },
                                })}
                        >
                            {/* A stored interval that is not on the list — an older rule, or one
                                written by a script — keeps its own row rather than being silently
                                snapped to the nearest offered value. */}
                            {!INTERVALS.some((i) => i.ms === monitor.everyMs) && (
                                <option value={monitor.everyMs}>
                                    Every {Math.round(monitor.everyMs / 1000)} seconds
                                </option>
                            )}
                            {INTERVALS.map((i) => (
                                <option key={i.ms} value={i.ms}>
                                    {i.label}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
            </AuField>
        </>
    );
};
