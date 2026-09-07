/**
 * The right-hand panel: the selected step's settings, and the problem list (mockup §04, §07).
 *
 * **Every panel is routed through `panelFor`** — the same pure module the node faces read. That is
 * §6.2's whole claim, and it is what the mockup's rev 1 got wrong: four hard-coded panels meant five
 * of six templates showed one rule on the canvas and a different rule in the panel eight pixels
 * away. §10.20 asserts the agreement per template through both renderers, which is what holds it.
 */
import React from 'react';
import type { DryRunReport, WatchableTerminal } from '../../types/electron';
import type { AutomationRuntimePairState } from '../../services/automationEvents';
import type { AutomationDraft, DraftAction } from './automationDraft';
import type { PanelModel } from './automationDerive';
import { panelFor } from './automationDerive';
import type { Problem, ProblemField } from './automationValidation';
import type { StepKind } from './automationSteps';
import { STEP_LABELS } from './automationSteps';
import { STEP_GLYPHS } from './AuNode';
import { MonitorPanel } from './panels/MonitorPanel';
import { ParsePanel } from './panels/ParsePanel';
import { CondPanel } from './panels/CondPanel';
import { TimerPanel } from './panels/TimerPanel';
import { ActionPanel } from './panels/ActionPanel';
import { WebhookPanel } from './panels/WebhookPanel';
import { redactWebhookText } from './webhookRedaction';

export interface AuInspectorProps {
    draft: AutomationDraft;
    problems: Problem[];
    pairs?: Record<string, AutomationRuntimePairState>;
    now: number;
    terminals: WatchableTerminal[];
    terminalsError: string | null;
    terminalsLoading: boolean;
    report: DryRunReport | null;
    onRearm: (() => void) | null;
    onTest: () => void;
    /** Clicking a problem focuses the step that owns it (§6.5). */
    onFocusStep: (step: StepKind) => void;
    dispatch: (action: DraftAction) => void;
}

/**
 * Which step's panel fixes a problem, keyed by the problem's own field.
 *
 * **`Record<ProblemField, StepKind>`, never `Record<string, …>`** — the index signature is what let
 * `'timer'` be missing and still compile, and the two consumers below both dereference the result:
 * `STEP_LABELS[FIELD_STEPS[p.field]]` renders `STEP_LABELS[undefined]` into the DOM and
 * `onFocusStep(FIELD_STEPS[p.field])` hands `undefined` to a `(step: StepKind) => void`. So every
 * `timer.*` problem — a wait too short, a schedule with no day picked — drew a blank label on a
 * button that then focused nothing. The exhaustive type turns the next such omission into a `tsc`
 * failure, which is the same protection `BADGES` already gives `ProblemCode`.
 *
 * **`timer` points at its own step**, since task 23 gave `StepKind` a `'timer'`. It pointed at
 * `action` for one commit — a deliberate placeholder, because of the four kinds that existed
 * `action` was the only one every rule has, and `monitor`/`parse`/`cond` are all absent on the
 * schedule rule these problems belong to.
 */
const FIELD_STEPS: Record<ProblemField, StepKind> = {
    targets: 'monitor',
    monitor: 'monitor',
    parse: 'parse',
    cond: 'cond',
    timer: 'timer',
    action: 'action',
    webhook: 'webhook',
};

export const AuInspector: React.FC<AuInspectorProps> = (props) => {
    const { draft, problems, onFocusStep } = props;
    const step = draft.selected;

    if (!step) {
        return (
            <aside className="au-inspect" aria-label="Step settings">
                <div className="au-inspect-none">
                    <b>Nothing selected</b>
                    <p>
                        Click a step on the canvas to configure it, or drag one in from the left.
                    </p>
                    {problems.length > 0 && <ProblemList problems={problems} onFocusStep={onFocusStep} />}
                </div>
            </aside>
        );
    }

    const model: PanelModel = panelFor(draft.rule, step, {
        pairs: props.pairs,
        now: props.now,
        problems,
    });

    return (
        <aside className="au-inspect" aria-label={`${STEP_LABELS[step]} settings`}>
            <div className="au-ihead">
                <span className={`au-gi ${step}`} aria-hidden="true">
                    {STEP_GLYPHS[step]}
                </span>
                <div>
                    <h3>{model.title}</h3>
                    <div className="au-sub">{model.subtitle}</div>
                </div>
            </div>
            <div className="au-ibody">
                {problems.length > 0 && <ProblemList problems={problems} onFocusStep={onFocusStep} />}

                {step === 'monitor' && (
                    <MonitorPanel
                        draft={draft}
                        model={model}
                        terminals={props.terminals}
                        terminalsError={props.terminalsError}
                        terminalsLoading={props.terminalsLoading}
                        dispatch={props.dispatch}
                    />
                )}
                {step === 'parse' && (
                    <ParsePanel
                        draft={draft}
                        model={model}
                        report={props.report}
                        dispatch={props.dispatch}
                        onTest={props.onTest}
                    />
                )}
                {step === 'cond' && (
                    <CondPanel
                        draft={draft}
                        model={model}
                        pairs={props.pairs}
                        now={props.now}
                        onRearm={props.onRearm}
                        dispatch={props.dispatch}
                    />
                )}
                {step === 'timer' && (
                    <TimerPanel draft={draft} model={model} dispatch={props.dispatch} />
                )}
                {step === 'action' && draft.rule.graph.action && (
                    <ActionPanel draft={draft} model={model} dispatch={props.dispatch} />
                )}
                {step === 'webhook' && draft.rule.graph.webhook && (
                    <WebhookPanel key={draft.rule.id} draft={draft} dispatch={props.dispatch} />
                )}
            </div>
        </aside>
    );
};

/**
 * §07's list: every problem, in step order, each naming its step and its fix. Clicking one focuses
 * that step — *"it's never a mystery which one to go fix."*
 */
const ProblemList: React.FC<{ problems: Problem[]; onFocusStep: (step: StepKind) => void }> = ({
    problems,
    onFocusStep,
}) => {
    const blocking = problems.filter((p) => p.severity === 'blocks');
    return (
        <div className="au-problems">
            <div className="au-pt">
                <span aria-hidden="true">⚠</span>
                {blocking.length > 0 ? 'Fix before enabling' : 'Worth knowing'}
            </div>
            <ul>
                {problems.map((p) => (
                    <li key={`${p.field}-${p.code}-${p.message}`} className={p.severity}>
                        <button type="button" onClick={() => onFocusStep(FIELD_STEPS[p.field])}>
                            <b>{STEP_LABELS[FIELD_STEPS[p.field]]}</b> — {redactWebhookText(p.message)}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
};
