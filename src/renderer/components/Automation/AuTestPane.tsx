/**
 * The drawer's *Test run* tab (mockup §05).
 *
 * **The renderer evaluates nothing.** `dry_run_automation` takes the *unsaved draft* and runs the
 * same `eval::evaluate` the loops do, then stops at the edge of the action: it types nothing, sends
 * nothing, and moves no arm state, so testing a live automation cannot accidentally silence it.
 *
 * Two things this pane is careful about:
 *
 * - **`unreadable` is its own verdict**, not a *would not fire*. The rule was never judged at all,
 *   and telling a user their pattern does not match when nothing was read sends them off to edit a
 *   pattern that is fine.
 * - **`skipped` is not a pass.** A step that never ran because an earlier one failed is drawn grey,
 *   because §05's own promise is *"you learn where it broke, not just that it did."*
 */
import React from 'react';
import type { DryRunReport, WatchableTerminal } from '../../types/electron';
import { STEP_LABELS } from './automationSteps';
import type { StepKind } from './automationSteps';

const VERDICTS: Record<DryRunReport['verdict'], { label: string; tone: string }> = {
    'would-fire': { label: 'Would fire', tone: 'sim' },
    'would-not-fire': { label: 'Would not fire', tone: 'idle' },
    unreadable: { label: 'Nothing could be read', tone: 'error' },
};

/**
 * The pill's label — which is not always `VERDICTS[report.verdict].label` verbatim.
 *
 * §4.4's send-time refusal (a token beyond what the pattern can supply, or no pattern at all) can
 * leave the ACTION step `failed` while the CONDITION that drove `verdict` was true. This pane's
 * own invariant is that the verdict answers the condition, not the arm machine — so `verdict`
 * itself must not change here, and it does not: this reads `report.steps` ONLY for the label,
 * leaving `VERDICTS` and its exhaustiveness untouched. Without it, a user editing a message with a
 * blocking `action.unknownToken` problem saw a green "Would fire" directly above the `✕` action
 * row that said the send was refused — two rows on one screen making opposite claims about the
 * same run.
 */
function pillFor(report: DryRunReport): { label: string; tone: string } {
    const base = VERDICTS[report.verdict];
    if (report.verdict !== 'would-fire') return base;
    const actionFailed = report.steps.find((s) => s.kind === 'action')?.status === 'failed';
    if (!actionFailed) return base;
    return { label: 'Would fire — but nothing would be sent', tone: base.tone };
}

// `unknown` is `Truth::Unknown` — the step RAN and could not be answered, which is neither a pass
// nor a failure and must not be drawn as either. `·` belongs to `skipped`, the step that never ran.
const MARKS: Record<string, string> = { ok: '✓', failed: '✕', skipped: '·', unknown: '?' };

export interface AuTestPaneProps {
    report: DryRunReport | null;
    running: boolean;
    error: string | null;
    /** Which terminal the run goes against — a rule watching several tests against one of them. */
    terminals: WatchableTerminal[];
    chosen: string | null;
    onChoose: (id: string) => void;
    onRun: () => void;
}

export const AuTestPane: React.FC<AuTestPaneProps> = ({
    report,
    running,
    error,
    terminals,
    chosen,
    onChoose,
    onRun,
}) => (
    <div className="au-dpane" role="tabpanel" aria-label="Test run">
        <div className="au-dtestbar">
            <label className="au-dtestpick">
                <span>Test against</span>
                <select
                    className="au-finput"
                    aria-label="Terminal to test against"
                    value={chosen ?? ''}
                    onChange={(e) => onChoose(e.target.value)}
                >
                    <option value="">choose a terminal…</option>
                    {terminals.map((t) => (
                        <option key={t.terminalId} value={t.terminalId} disabled={!t.alive}>
                            {t.terminalId} — {t.label ?? 'unnamed'}
                            {t.alive ? '' : ' (not open)'}
                        </option>
                    ))}
                </select>
            </label>
            <span className="au-grow" />
            {report && (
                <span className={`au-pill ${pillFor(report).tone}`}>
                    <span className="au-pd" />
                    {pillFor(report).label}
                </span>
            )}
            <button type="button" className="au-btn sm" disabled={running || !chosen} onClick={onRun}>
                {running ? 'Running…' : report ? 'Run again' : '▶ Run'}
            </button>
        </div>

        {error !== null && (
            <div className="au-drynote failed" role="alert">
                <span aria-hidden="true">⚠</span>
                <span>
                    The test could not be run: {error}. Nothing was sent — a dry run never types
                    into a terminal, including when it fails.
                </span>
            </div>
        )}

        {!report && error === null && (
            <div className="au-drynote">
                <span aria-hidden="true">ⓘ</span>
                <span>
                    Pick a terminal and run the rule against its recent output. It reports what each
                    step did and stops at the edge of the action — nothing is typed, and this
                    rule&apos;s re-arm state does not move.
                </span>
            </div>
        )}

        {report && (
            <>
                <div className="au-dsrc">
                    against the recent output of <span className="au-idchip">{report.terminalId}</span>{' '}
                    {report.terminalName ?? ''}
                </div>
                <div className="au-dsteps">
                    {report.steps.map((step) => (
                        <div key={step.kind} className={`au-dstep ${step.status}`}>
                            <span className="au-mk" aria-hidden="true">
                                {MARKS[step.status] ?? '·'}
                            </span>
                            <span className="au-nm">{STEP_LABELS[step.kind as StepKind]}</span>
                            <span className="au-ds2">{step.detail}</span>
                        </div>
                    ))}
                </div>
                <div className="au-drynote">
                    <span aria-hidden="true">ⓘ</span>
                    <span>
                        Dry run — nothing was sent, and this rule&apos;s re-arm state has not moved.
                        The verdict answers the <b>condition</b>, not whether the rule is armed: a
                        rule that is working perfectly sits in <i>Fired</i> and would still say
                        “would fire” here.
                    </span>
                </div>
            </>
        )}
    </div>
);
