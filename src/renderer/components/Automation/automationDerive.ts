/**
 * Everything the editor DRAWS, derived from one draft (plan 028 §6.2, mockup §03/§04/§07).
 *
 * **This module is the mockup's own root fix for its worst rev-1 bug.** Rev 1 had four hard-coded
 * inspector panels, so five of six templates showed one rule on the canvas and a *different* rule in
 * the panel eight pixels away. Nothing was wrong with either renderer; they simply had two sources.
 *
 * So there is one: `stepValues(rule, step)`. The node face and the inspector panel are two renderings
 * of the same record, and §10.20 asserts, per template, that both carry **that template's own**
 * pattern, threshold and message. Deriving is what makes canvas and inspector structurally incapable
 * of drifting — a panel added later that reads a field directly is the bug coming back, and the test
 * is what holds the line.
 *
 * Nothing here is stored. Faces, rows, feet, state dots, the palette summary and the header's
 * blocked-reason text are all computed in render from `draft` + `problems` + the runtime payload.
 */
import type { AutomationRule } from '../../types/electron';
import type { AutomationRuntimePairState } from '../../services/automationEvents';
import {
    automationRowState,
    describeCadence,
    describeCriterion,
} from '../Settings/Automations/automationState';
import { displayedPattern, presetById } from './automationPresets';
import type { Problem, ProblemField } from './automationValidation';
import { badgeFor } from './automationValidation';
import type { StepKind } from './automationSteps';
import { STEP_LABELS, STEP_ORDER, STEP_SUBTITLES } from './automationSteps';

/** Every step's `field` in the problem list. They are the same words, and that is deliberate. */
export const STEP_FIELDS: Record<StepKind, ProblemField[]> = {
    // The monitor step owns two categories: *which* terminals (targets) and *how often* (monitor).
    // One node, one panel, two rules — so a missing pick and a too-fast timer both point here.
    monitor: ['targets', 'monitor'],
    parse: ['parse'],
    cond: ['cond'],
    action: ['action'],
};

export interface DeriveContext {
    /** `runtime.rules[rule.id]` — undefined for a draft that has never run. */
    pairs?: Record<string, AutomationRuntimePairState>;
    now: number;
    problems: Problem[];
}

/**
 * A value shown on a face and bound to a control, with the one thing a renderer must not decide for
 * itself: whether it is a real value or a stand-in for a missing one.
 */
export interface StepValue {
    /** What the face and the panel summary show. */
    text: string;
    /** True when `text` is a placeholder — §07's `nothing to look for`, drawn in the warning colour. */
    missing: boolean;
}

const value = (text: string): StepValue => ({ text, missing: false });
const absent = (text: string): StepValue => ({ text, missing: true });

export const OP_PHRASES: Record<string, string> = {
    gt: 'greater than',
    gte: 'greater than or equal to',
    lt: 'less than',
    lte: 'less than or equal to',
    eq: 'equal to',
    neq: 'not equal to',
};

export const READ_PHRASES = {
    newOutput: 'New output as it appears',
    onScreen: "What's on screen right now",
} as const;

export const SEND_PHRASES = {
    submit: 'Type it and press Enter',
    hold: "Type it, don't press Enter",
} as const;

export const SEND_TO_PHRASES = {
    matched: 'The terminal that matched',
    all: 'Every watched terminal',
} as const;

export const KEEP_PHRASES = {
    brackets: 'The number in brackets',
    whole: 'The whole matched text',
} as const;

/**
 * **The single source.** One record per step, read by the node face AND the inspector panel.
 *
 * Keys are stable names rather than positions, because both renderers name what they want and a
 * face that silently picked `values[1]` would break the moment a row moved.
 */
export function stepValues(rule: AutomationRule, step: StepKind): Record<string, StepValue> {
    const { monitor, parse, cond, action } = rule.graph;
    switch (step) {
        case 'monitor':
            return {
                terminals:
                    rule.targetMode === 'pinned' && rule.targetIds.length === 0
                        ? absent('no terminals chosen')
                        : value(describeCriterion(rule)),
                read: value(READ_PHRASES[monitor.read]),
                cadence: value(describeCadence(rule)),
            };
        case 'parse': {
            const shown = displayedPattern(parse);
            return {
                preset: value(presetById(parse.preset).label),
                find: shown.trim().length === 0 ? absent('nothing to look for') : value(shown),
                keep: value(KEEP_PHRASES[parse.keep]),
            };
        }
        case 'cond':
            if (cond.kind === 'text') {
                return {
                    compare: value('the text appears'),
                    threshold: value('—'),
                };
            }
            return {
                compare: cond.op ? value(OP_PHRASES[cond.op]) : absent('no comparison yet'),
                threshold:
                    cond.threshold === null || cond.threshold === undefined
                        ? absent('no number yet')
                        : value(String(cond.threshold)),
            };
        case 'action':
        default:
            return {
                message:
                    action.message.trim().length === 0
                        ? absent('nothing to send')
                        : value(action.message),
                send: value(action.submit ? SEND_PHRASES.submit : SEND_PHRASES.hold),
                sendTo: value(SEND_TO_PHRASES[action.sendTo]),
            };
    }
}

export interface FaceRow {
    label: string;
    value: StepValue;
}

export interface NodeFace {
    title: string;
    rows: FaceRow[];
    /** The badge along the bottom of the card, or `null` when the step has nothing to say. */
    foot: string | null;
    footTone: 'warn' | 'live' | null;
}

/** Which of a step's values go on the card, and under which label. Two or three, as §03 draws. */
const FACE_ROWS: Record<StepKind, Array<{ label: string; key: string }>> = {
    monitor: [
        { label: 'Watch', key: 'terminals' },
        { label: 'Read', key: 'read' },
        { label: 'Check', key: 'cadence' },
    ],
    parse: [
        { label: 'Find', key: 'find' },
        { label: 'Keep', key: 'keep' },
    ],
    cond: [
        { label: 'Fire when', key: 'compare' },
        { label: 'Value', key: 'threshold' },
    ],
    action: [
        { label: 'Send', key: 'message' },
        { label: 'Then', key: 'send' },
    ],
};

/** The problems belonging to a step — both categories, for the monitor. */
export function problemsForStep(problems: Problem[], step: StepKind): Problem[] {
    const fields = STEP_FIELDS[step];
    return problems.filter((p) => fields.includes(p.field));
}

export function faceFor(rule: AutomationRule, step: StepKind, ctx: DeriveContext): NodeFace {
    const values = stepValues(rule, step);
    const rows = FACE_ROWS[step].map(({ label, key }) => ({ label, value: values[key] }));

    const blocking = problemsForStep(ctx.problems, step).find((p) => p.severity === 'blocks');
    if (blocking) {
        return { title: STEP_LABELS[step], rows, foot: `⚠ ${badgeFor(blocking)}`, footTone: 'warn' };
    }

    // The COMPARE step is the only one with a runtime story to tell — the arm machine lives on it —
    // and it tells that story only when there is one. A fresh draft has no pairs, so its foot is
    // empty rather than optimistic; §10.20 asserts it never reads "fired" or "completed", because a
    // node claiming a state its rule has never been in is how the mockup's rev 1 lied.
    if (step === 'cond' && ctx.pairs && Object.keys(ctx.pairs).length > 0) {
        return {
            title: STEP_LABELS[step],
            rows,
            foot: automationRowState(rule, ctx.pairs, ctx.now).pillText,
            footTone: 'live',
        };
    }

    return { title: STEP_LABELS[step], rows, foot: null, footTone: null };
}

export type NodeTone = 'error' | 'warn' | 'live' | 'ready';

export interface NodeState {
    tone: NodeTone;
    /** The dot's `title`, so the colour is never the only carrier. */
    title: string;
}

export function stateFor(rule: AutomationRule, step: StepKind, ctx: DeriveContext): NodeState {
    const mine = problemsForStep(ctx.problems, step);
    const blocking = mine.find((p) => p.severity === 'blocks');
    if (blocking) return { tone: 'error', title: blocking.message };
    const warning = mine.find((p) => p.severity === 'warns');
    if (warning) return { tone: 'warn', title: warning.message };
    if (step === 'cond' && ctx.pairs && Object.keys(ctx.pairs).length > 0) {
        const state = automationRowState(rule, ctx.pairs, ctx.now);
        return { tone: 'live', title: state.pillText };
    }
    return { tone: 'ready', title: 'This step is configured.' };
}

export interface PanelModel {
    step: StepKind;
    title: string;
    subtitle: string;
    /** **The same record the face reads.** The whole point of this module. */
    values: Record<string, StepValue>;
    problems: Problem[];
}

/**
 * The inspector panel's model.
 *
 * A panel component renders controls bound to `rule.graph`, but everything it *displays as text* —
 * summaries, the head's subtitle, the problem list — comes from here, so the two renderings cannot
 * describe different rules.
 */
export function panelFor(rule: AutomationRule, step: StepKind, ctx: DeriveContext): PanelModel {
    const index = STEP_ORDER.indexOf(step) + 1;
    const mine = problemsForStep(ctx.problems, step);
    const count = ctx.problems.length;
    return {
        step,
        title: STEP_LABELS[step],
        subtitle:
            mine.length > 0 && count > 0
                ? `Step ${index} · ${mine.length} of ${count} problem${count === 1 ? '' : 's'}`
                : `Step ${index} · ${STEP_SUBTITLES[step]}`,
        values: stepValues(rule, step),
        problems: mine,
    };
}

/**
 * The palette's *This rule* summary — the sentence in the left rail (mockup §03).
 *
 * Derived from the same values, so the rail cannot summarise a rule the canvas is not showing.
 */
export function ruleSummary(rule: AutomationRule): string {
    const monitor = stepValues(rule, 'monitor');
    const parse = stepValues(rule, 'parse');
    const cond = stepValues(rule, 'cond');
    const action = stepValues(rule, 'action');
    const when =
        rule.graph.cond.kind === 'text'
            ? `when ${parse.find.text} appears`
            : `when the value in ${parse.find.text} is ${cond.compare.text} ${cond.threshold.text}`;
    return `Watching ${monitor.terminals.text} · ${when} · ${
        rule.graph.action.submit ? 'send' : 'type'
    } ${action.message.text}`;
}
