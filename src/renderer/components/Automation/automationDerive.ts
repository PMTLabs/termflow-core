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
import type {
    AutomationClause,
    AutomationCompareOp,
    AutomationCondStep,
    AutomationRule,
    AutomationTextOp,
} from '../../types/electron';
import type { AutomationRuntimePairState } from '../../services/automationEvents';
import {
    automationRowState,
    describeCadence,
    describeCriterion,
} from '../Settings/Automations/automationState';
import { displayedPattern, presetById, sayPattern } from './automationPresets';
import type { PatternSaying } from './automationPresets';
import type { Problem, ProblemField } from './automationValidation';
import { badgeFor, sourceText } from './automationValidation';
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

/**
 * A clause row's own SHORT operator phrasing (plan 032 §5.9, mockup §06) — distinct from
 * `OP_PHRASES`'s longer prose above, which the legacy single-comparison fallback in `condSentence`
 * still uses. One clause row, one wording, read by `CondPanel`'s operator dropdown and by
 * `condSentence`'s clause phrasing, so the row and the sentence built from it never disagree.
 */
export const NUM_OP_LABELS: Record<AutomationCompareOp, string> = {
    gt: 'is over',
    gte: 'is at least',
    lt: 'is under',
    lte: 'is at most',
    eq: 'equals',
    neq: 'does not equal',
};

export const TEXT_OP_LABELS: Record<AutomationTextOp, string> = {
    is: 'is',
    isNot: 'is not',
    contains: 'contains',
    notContains: 'does not contain',
    matches: 'matches',
    isEmpty: 'is empty',
    isNotEmpty: 'is not empty',
};

/** A text operator that takes no operand — `isEmpty`/`isNotEmpty` ask nothing of a value. */
const TEXT_OPS_WITHOUT_VALUE = new Set<AutomationTextOp>(['isEmpty', 'isNotEmpty']);

/** One clause, in words — `$1 is over 30`. */
function clauseSentence(clause: AutomationClause): string {
    const token = sourceText(clause.source);
    if ('number' in clause.test) {
        // A threshold that has not been typed yet reads as the same ellipsis an un-typed text
        // operand gets below, never as the literal word `null`.
        const { op, value } = clause.test.number;
        return `${token} ${NUM_OP_LABELS[op]} ${value === null ? '…' : value}`;
    }
    const { op, value } = clause.test.text;
    const operand = TEXT_OPS_WITHOUT_VALUE.has(op) ? '' : ` ${value || '…'}`;
    return `${token} ${TEXT_OP_LABELS[op]}${operand}`;
}

/**
 * The plain-English sentence a `CondStep` fires on (plan 032 §5.9) — the FULL sentence, exactly as
 * `CondPanel`'s own `.au-plainsay` shows it. `condFaceText` below is the node face's own rendering
 * of this same sentence, truncated-or-counted rather than clipped.
 *
 * **One extraction, two consumers**: the panel and the face read this one function, so they cannot
 * describe two different rules the way the mockup's rev-1 panels did (this file's own header).
 */
export function condSentence(cond: AutomationCondStep): string {
    const clauses = cond.clauses ?? [];
    if (clauses.length > 0) {
        return clauses.map(clauseSentence).join(cond.join === 'or' ? ' or ' : ' and ');
    }
    // A v1 rule that predates the clause list still has its own comparison to show — the same
    // fields `automation_engine`'s own load-time fold reads (plan 032 §5.4), read here for DISPLAY
    // only: this never writes `op`/`threshold` back, and a save from `CondPanel` never sets them.
    if (cond.kind === 'number' && cond.op != null && cond.threshold != null) {
        return `the value is ${OP_PHRASES[cond.op]} ${cond.threshold}`;
    }
    return 'the pattern matches at all';
}

/**
 * The node face's rendering of `condSentence` — the sentence while it fits in 34 characters, else a
 * count (plan 032 §5.9). **A clipped `AND` reads as a different rule, so it is never shown half** —
 * `FACE_ROWS`' truncate-with-ellipsis treatment (see `AU_NODE_W`'s own comment) is deliberately not
 * used for this row.
 *
 * The empty-clause case (a legacy rule, or a bare "fires on match") is exempted from the length
 * cap: there is no clause COUNT to fall back to that would not be actively wrong (`0 comparisons`
 * for a rule that is, in fact, comparing something).
 */
export function condFaceText(cond: AutomationCondStep): string {
    const clauses = cond.clauses ?? [];
    const sentence = condSentence(cond);
    if (clauses.length === 0 || sentence.length <= 34) return sentence;
    return `${clauses.length} comparison${clauses.length === 1 ? '' : 's'} · ${
        cond.join === 'or' ? 'any may pass' : 'all must pass'
    }`;
}

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
        case 'cond': {
            // `fires` is the Task-14 field — the clause-list sentence (or its legacy fallback),
            // read by the node face via `FACE_ROWS`. `compare`/`threshold` are kept exactly as
            // they were: the pre-clause single-comparison summary, still true for a v1 rule and
            // still what `ruleSummary`'s own `cond.compare`/`cond.threshold` reads.
            const fires = value(condFaceText(cond));
            if (cond.kind === 'text') {
                return {
                    compare: value('the text appears'),
                    threshold: value('—'),
                    fires,
                };
            }
            return {
                compare: cond.op ? value(OP_PHRASES[cond.op]) : absent('no comparison yet'),
                threshold:
                    cond.threshold === null || cond.threshold === undefined
                        ? absent('no number yet')
                        : value(String(cond.threshold)),
                fires,
            };
        }
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
    /** Which key of `stepValues` this row draws — the name, so a test can ask for one by it. */
    key: string;
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
    // Task 14: one row, `condFaceText`'s sentence-or-count text — the two-row `compare`/`threshold`
    // layout described a SINGLE comparison and has nothing to say about a clause list or its join.
    cond: [
        { label: 'Fires when', key: 'fires' },
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
    const rows = FACE_ROWS[step].map(({ label, key }) => ({ label, key, value: values[key] }));

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
    /**
     * The plain-words paraphrase, for the parse panel — `null` on every other step, and on a
     * pattern the vocabulary cannot word.
     *
     * It lives here rather than in the panel because it is DISPLAYED prose derived from the rule,
     * which is the one thing this module exists to keep in one place. It was the panel's own call
     * to `sayPattern`, and it was also the one displayed string in the editor that was wrong: it
     * announced *"keep the number"* about a group the engine does not keep, eight pixels under a
     * warning saying the first group is used.
     */
    saying: PatternSaying | null;
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
        saying: step === 'parse' ? sayPattern(rule.graph.parse.find, rule.graph.parse.keep) : null,
    };
}

/**
 * The `when …` half of a rule's sentence, for the left rail.
 *
 * **A clause list SUPERSEDES `op`/`threshold`, so a rule that carries both must never show the
 * pair** (§5.3: v1-only, read at load, never written again). Three renderings were wrong before
 * this read `condSentence`: a rule authored in the clause panel showed *"no comparison yet no
 * number yet"* beside a node face reading the clause; a v1 rule someone added a clause to showed
 * the superseded `> 25`; and an event rule with clauses said *"when X appears"* and dropped them
 * entirely.
 *
 * `condSentence` is the ONE place the three cases (clauses / a v1 pair / neither) become words, and
 * the node face, `CondPanel`'s own plain-say and `describeRule` all read it — §1.1: two surfaces on
 * one screen must not make opposite claims about one rule.
 */
function whenPhrase(rule: AutomationRule, pattern: string, cond: Record<string, StepValue>): string {
    if ((rule.graph.cond.clauses ?? []).length > 0) {
        return `when ${pattern} matches and ${condSentence(rule.graph.cond)}`;
    }
    if (rule.graph.cond.kind === 'text') return `when ${pattern} appears`;
    // A v1 reading rule, or one whose comparison is not authored yet — `compare`/`threshold` carry
    // the missing-value placeholders that tell the user what is still to fill in.
    return `when the value in ${pattern} is ${cond.compare.text} ${cond.threshold.text}`;
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
    return `Watching ${monitor.terminals.text} · ${whenPhrase(rule, parse.find.text, cond)} · ${
        rule.graph.action.submit ? 'send' : 'type'
    } ${action.message.text}`;
}

// =================================================================================================
// The rule as one sentence — the Settings row and the template card
// =================================================================================================

/**
 * The comparison, in the words the mockup uses on the row: *"rises above"*, never *">"*.
 *
 * The crossing **is** the semantics, and a user who reads the row has already been told it will not
 * nag (mockup §01). Every operator gets a crossing verb for that reason.
 */
const OP_WORDS: Record<string, string> = {
    gt: 'rises above',
    gte: 'reaches',
    lt: 'falls below',
    lte: 'drops to',
    eq: 'reaches exactly',
    neq: 'stops being',
};

/**
 * The rule as one sentence: `when ctx % rises above 25 → send "…"`.
 *
 * Derived from the rule itself so it can never describe a rule the engine is not running. The
 * pieces are returned separately rather than as one string because the row emphasises the pattern
 * and the message differently, and a component that has to re-split a sentence will split it wrong.
 *
 * **Lives here, beside `ruleSummary`, because the two are one claim in two renderings.** They are
 * the pair §1.1 names — the Settings row and the editor's left rail, describing one rule — and
 * keeping them in two modules is what let the rail say *"no comparison yet"* while the row said
 * `> 25` and the node face said something else again. It also keeps the dependency one-way:
 * `automationState` cannot import `condSentence` from here without a cycle.
 */
export interface RuleSentence {
    /** `when the number in` / `when output starts matching` / `when` — never carries the pattern. */
    lead: string;
    /** The pattern, or the literal the user typed when there is one. Emphasised by the row. */
    subject: string;
    /** The condition verb, or null when the condition needs none (a plain event rule). */
    verb: string | null;
    /**
     * What the verb reads against, emphasised by the row: a v1 threshold, or the whole clause
     * sentence. Null when the verb is.
     */
    detail: string | null;
    /** `send` or `type` — *Answer a confirmation* deliberately does not press Enter. */
    verbSend: string;
    message: string;
    /** ` — no Enter` when the action leaves the text in the composer, else null. */
    sendNote: string | null;
}

export function describeRule(rule: AutomationRule): RuleSentence {
    const { parse, cond, action } = rule.graph;
    const send = {
        verbSend: action.submit ? 'send' : 'type',
        message: action.message,
        sendNote: action.submit ? null : ' — no Enter',
    };
    const subject = parse.literal && parse.literal.length > 0 ? parse.literal : parse.find;

    // A clause list supersedes `op`/`threshold` (§5.3), so it is asked FIRST and for BOTH `finds`:
    // an event rule with clauses used to read "when X appears" and drop them. One reading, through
    // `condSentence` — the same function the node face and `CondPanel` read.
    if ((cond.clauses ?? []).length > 0) {
        return { lead: 'when', subject, verb: 'matches and', detail: condSentence(cond), ...send };
    }
    if (cond.kind !== 'number') {
        return { lead: 'when output starts matching', subject, verb: null, detail: null, ...send };
    }
    return {
        lead: 'when the number in',
        subject,
        verb: OP_WORDS[cond.op ?? 'gt'] ?? 'reaches',
        detail: cond.threshold !== null && cond.threshold !== undefined ? String(cond.threshold) : null,
        ...send,
    };
}
