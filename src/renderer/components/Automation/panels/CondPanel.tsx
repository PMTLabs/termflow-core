/**
 * *Compare it* — the comparison, and the once-per-crossing explanation (mockup §04, §08).
 *
 * The *Right now* block is the only place in the editor that draws live engine state, and it draws
 * it through `automationRowState` — the same module the list row uses — so the pill in the editor
 * and the pill in the list can never say different things about one rule.
 */
import React from 'react';
import type { AutomationCompareOp, AutomationCondKind } from '../../../types/electron';
import type { AutomationRuntimePairState } from '../../../services/automationEvents';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import type { PanelModel } from '../automationDerive';
import { OP_PHRASES } from '../automationDerive';
import { automationRowState, describeLastFired } from '../../Settings/Automations/automationState';
import { AuField, AuHelp, AuRadio } from './AuFields';

const OPS: AutomationCompareOp[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];

export interface CondPanelProps {
    draft: AutomationDraft;
    model: PanelModel;
    pairs?: Record<string, AutomationRuntimePairState>;
    now: number;
    /** `null` while the rule has never been saved — there is nothing for the engine to re-arm. */
    onRearm: (() => void) | null;
    dispatch: (action: DraftAction) => void;
}

export const CondPanel: React.FC<CondPanelProps> = ({
    draft,
    model,
    pairs,
    now,
    onRearm,
    dispatch,
}) => {
    const { cond } = draft.rule.graph;
    const live = pairs && Object.keys(pairs).length > 0 ? automationRowState(draft.rule, pairs, now) : null;
    const lastFired = pairs
        ? Object.values(pairs).reduce<number | null>(
            (best, p) => (p.lastFiredAt !== null && (best === null || p.lastFiredAt > best) ? p.lastFiredAt : best),
            null,
        )
        : null;

    return (
        <>
            <AuField label="What kind of check">
                <AuRadio
                    name="au-condkind"
                    on={cond.kind === 'number'}
                    title="Compare a number"
                    sub="Fires when the value crosses a threshold, and re-arms when it comes back"
                    onPick={() =>
                        dispatch({
                            type: 'cond',
                            // The operator and threshold are restored to a usable pair rather than
                            // left null: switching to "compare a number" and immediately reporting
                            // two problems would be the editor creating the problem it reports.
                            patch: {
                                kind: 'number' as AutomationCondKind,
                                op: cond.op ?? 'gt',
                                threshold: cond.threshold ?? 25,
                            },
                        })}
                />
                <AuRadio
                    name="au-condkind"
                    on={cond.kind === 'text'}
                    title="The text simply appears"
                    sub="Fires the first time the pattern matches, and re-arms when it stops matching"
                    onPick={() =>
                        dispatch({
                            type: 'cond',
                            patch: { kind: 'text' as AutomationCondKind, op: null, threshold: null },
                        })}
                />
            </AuField>

            {cond.kind === 'number' && (
                <AuField label="Fire when the value is">
                    <div className="au-frow">
                        <select
                            className="au-finput"
                            style={{ flex: 1.4 }}
                            aria-label="How to compare"
                            value={cond.op ?? ''}
                            onChange={(e) =>
                                dispatch({
                                    type: 'cond',
                                    patch: { op: (e.target.value || null) as AutomationCompareOp | null },
                                })}
                        >
                            <option value="">choose…</option>
                            {OPS.map((op) => (
                                <option key={op} value={op}>
                                    {OP_PHRASES[op]}
                                </option>
                            ))}
                        </select>
                        <input
                            className="au-finput"
                            style={{ flex: 0.7 }}
                            aria-label="Value to compare against"
                            inputMode="decimal"
                            value={cond.threshold ?? ''}
                            onChange={(e) => {
                                const raw = e.target.value.trim();
                                // An empty box is "no threshold yet", not zero — and validation
                                // says so. Coercing '' to 0 would make an unfinished rule look
                                // finished and fire on the first value below nothing.
                                const parsed = raw.length === 0 ? null : Number(raw);
                                dispatch({
                                    type: 'cond',
                                    patch: {
                                        threshold: parsed !== null && Number.isFinite(parsed) ? parsed : null,
                                    },
                                });
                            }}
                        />
                    </div>
                </AuField>
            )}

            <div className="au-rearmnote">
                <div className="au-rt">
                    <span aria-hidden="true">⚠</span>Fires once per crossing
                </div>
                {cond.kind === 'number' ? (
                    <>
                        <p>
                            The first time the value goes {model.values.compare.text}{' '}
                            <code>{model.values.threshold.text}</code>, this fires. It will{' '}
                            <b>not</b> fire again while the value stays there — no matter how many
                            checks happen.
                        </p>
                        <p>
                            It re-arms as soon as the value comes back, and can fire again the next
                            time it crosses.
                        </p>
                    </>
                ) : (
                    <p>
                        This fires the first time the pattern matches. It will <b>not</b> fire again
                        while it keeps matching, and re-arms once the text stops appearing.
                    </p>
                )}
            </div>

            {live && (
                <AuField label="Right now">
                    <span className={`au-pill ${live.id}`}>
                        <span className="au-pd" />
                        {live.pillText}
                    </span>
                    {lastFired !== null && (
                        <div className="au-rightnow">
                            Fired {describeLastFired(lastFired, now)}.
                        </div>
                    )}
                    {onRearm && (
                        <button type="button" className="au-btn sm" onClick={onRearm}>
                            Re-arm now
                        </button>
                    )}
                </AuField>
            )}

            {!live && (
                <AuHelp>
                    This rule is not running, so there is no armed-or-fired state to show yet. Save
                    it and switch it on, and this is where it reports what it is waiting for.
                </AuHelp>
            )}
        </>
    );
};
