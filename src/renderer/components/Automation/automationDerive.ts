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
    AutomationTimerStep,
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
import type { OutPortKey } from './automationSteps';
import { STEP_LABELS, STEP_ORDER, STEP_SUBTITLES } from './automationSteps';
// Moved out to `automationTimerWords.ts` (plan 032 §7): `automationState.ts`'s own `describeCadence`
// needs these same two formatters for a schedule rule's cadence line, and this module already
// imports FROM `automationState.ts` — so leaving them here would be an import cycle. Re-exported
// below so every existing importer of them from this module keeps working unchanged.
import { clockTime, describeDays } from './automationTimerWords';

export { clockTime, daysOf, describeDays } from './automationTimerWords';

/** Every step's `field` in the problem list. They are the same words, and that is deliberate. */
export const STEP_FIELDS: Record<StepKind, ProblemField[]> = {
    // The monitor step owns two categories: *which* terminals (targets) and *how often* (monitor).
    // One node, one panel, two rules — so a missing pick and a too-fast timer both point here.
    monitor: ['targets', 'monitor'],
    parse: ['parse'],
    cond: ['cond'],
    timer: ['timer'],
    action: ['action'],
    // Webhook validation is still owned by the destination field until Task 12 adds its panel.
    webhook: [],
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

/**
 * A step the rule does not HAVE, as distinct from a field it has not filled in.
 *
 * Plan 032 §3.1 lets a schedule rule (§6.3) carry no monitor, parse or cond step at all. Every
 * other `absent(...)` here names a value the user still has to supply — *no number yet* — and that
 * is the wrong thing to say about a step that is not part of the rule and never will be. One
 * placeholder for all of them, deliberately plain: tasks 23-25 own the editor and the copy for
 * authoring and describing a schedule rule.
 */
const NOT_IN_THIS_RULE: StepValue = absent('not in this rule');

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
    // **A reading with neither a clause list nor a complete pair is not "fires on any match".** It
    // is the shape `eval::evaluate` answers `Truth::Unknown` for — evaluated, and unable to fire —
    // and it is reachable from ordinary authoring, because choosing *A reading that stays true*
    // seeds no clause. Falling through to the event wording below made the node face claim it
    // fires on every match while the left rail said *"no comparison yet no number yet"* for the
    // same rule. The words match `dry.rs`'s own row for it, which is the third surface.
    if (cond.kind === 'number') return 'the comparison is not finished';
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
 * The wait step's two modes, in the words the radio uses (mockup §03). **"Wait", never "Timer"** —
 * `AutomationCadence`'s `'timer'` is the monitor's poll interval, and two controls called Timer on
 * one screen is how the two get confused.
 */
export const WAIT_MODE_PHRASES = {
    afterMatch: 'After the comparison passes',
    dailyAt: 'At a time of day',
} as const;

/**
 * The wait as one sentence, or `null` when the rule does not state one yet.
 *
 * `null` rather than a sentence about a blank field: the three ways this step can be unfinished —
 * no wait length, a `minuteOfDay` that is not a time of day, a mask that picks no day — are all
 * blocking problems with their own words in `automationValidation`, and a paraphrase beside them
 * would either repeat them or, worse, describe a rule that cannot run as though it could
 * (*"Waits 0 seconds after the rule matches"*).
 *
 * Lives here rather than in the panel for the reason `saying` does: it is DISPLAYED prose derived
 * from the rule, and the module exists so two surfaces cannot word one rule differently.
 */
export function waitSentence(timer: AutomationTimerStep): string | null {
    if ('afterMatch' in timer.mode) {
        const { delayMs } = timer.mode.afterMatch;
        if (delayMs <= 0) return null;
        return `Waits ${describeDelay(delayMs)} after the rule matches, then sends.`;
    }
    const { minuteOfDay, days } = timer.mode.dailyAt;
    const at = clockTime(minuteOfDay);
    const when = describeDays(days);
    if (at === null || when === '') return null;
    // §6.3: the walk skips `host.tail` for the whole rule, so this half is not a flourish — it is
    // the consequence a user cannot otherwise see, and the reason `timer.scheduleWithMonitor` is a
    // blocking problem rather than a layout rule.
    return `Sends at ${at}, ${when} — nothing on screen is read.`;
}

/**
 * A delay in the largest whole unit that does not lose anything — `30 seconds`, `2 minutes`,
 * `90 seconds`.
 *
 * Whole minutes only when the value IS whole minutes: rounding `90000` to *"2 minutes"* would be
 * the card describing a rule that waits a different length of time from the one the panel's field
 * holds, which is the disagreement this whole module exists to prevent.
 */
export function describeDelay(ms: number): string {
    const seconds = ms / 1_000;
    if (Number.isInteger(seconds) && seconds >= 60 && seconds % 60 === 0) {
        const minutes = seconds / 60;
        return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    const shown = Number.isInteger(seconds) ? String(seconds) : String(Math.round(seconds * 10) / 10);
    return `${shown} second${shown === '1' ? '' : 's'}`;
}

/**
 * **The single source.** One record per step, read by the node face AND the inspector panel.
 *
 * Keys are stable names rather than positions, because both renderers name what they want and a
 * face that silently picked `values[1]` would break the moment a row moved.
 */
export function stepValues(rule: AutomationRule, step: StepKind): Record<string, StepValue> {
    const { monitor, parse, cond, timer, action, webhook } = rule.graph;
    switch (step) {
        case 'monitor':
            return {
                // **Targeting survives an absent monitor step** (plan 032 §3.1): `targetMode` and
                // `targetIds` are the rule's own columns, not fields of the step, so a schedule
                // rule still watches its terminals and this row still says which.
                terminals:
                    rule.targetMode === 'pinned' && rule.targetIds.length === 0
                        ? absent('no terminals chosen')
                        : value(describeCriterion(rule)),
                read: monitor ? value(READ_PHRASES[monitor.read]) : NOT_IN_THIS_RULE,
                cadence: monitor ? value(describeCadence(rule)) : NOT_IN_THIS_RULE,
            };
        case 'parse': {
            if (!parse) {
                return { preset: NOT_IN_THIS_RULE, find: NOT_IN_THIS_RULE, keep: NOT_IN_THIS_RULE };
            }
            const shown = displayedPattern(parse);
            return {
                preset: value(presetById(parse.preset).label),
                find: shown.trim().length === 0 ? absent('nothing to look for') : value(shown),
                keep: value(KEEP_PHRASES[parse.keep]),
            };
        }
        case 'cond': {
            if (!cond) {
                return {
                    compare: NOT_IN_THIS_RULE,
                    threshold: NOT_IN_THIS_RULE,
                    fires: NOT_IN_THIS_RULE,
                };
            }
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
        // **Its own arm, above `action`'s `default:`.** `Record<StepKind, …>` made every other table
        // in this milestone fail to compile until it had a `timer` entry; a switch whose last arm is
        // `case 'action': default:` is the one place that protection does not reach, and a new kind
        // falling through it would draw the ACTION's values under the wait step's labels.
        case 'timer': {
            if (!timer) return { mode: NOT_IN_THIS_RULE, when: NOT_IN_THIS_RULE };
            if ('afterMatch' in timer.mode) {
                return {
                    mode: value(WAIT_MODE_PHRASES.afterMatch),
                    when: value(`${describeDelay(timer.mode.afterMatch.delayMs)} after it matches`),
                };
            }
            const { minuteOfDay, days } = timer.mode.dailyAt;
            const at = clockTime(minuteOfDay);
            const when = describeDays(days);
            // Two independent missing values on one row, and the row can only show one string. The
            // time is named first because it is the field the row is about; either way the value is
            // marked `missing`, so the face draws it in the warning colour and the problem list
            // carries the specific `timer.badMinute` / `timer.noDays` sentence.
            if (at === null) return { mode: value(WAIT_MODE_PHRASES.dailyAt), when: absent('not a time of day') };
            if (when === '') return { mode: value(WAIT_MODE_PHRASES.dailyAt), when: absent(`${at}, no days picked`) };
            return { mode: value(WAIT_MODE_PHRASES.dailyAt), when: value(`${at}, ${when}`) };
        }
        case 'action':
            if (!action) {
                return {
                    message: NOT_IN_THIS_RULE,
                    send: NOT_IN_THIS_RULE,
                    sendTo: NOT_IN_THIS_RULE,
                };
            }
            return {
                message:
                    action.message.trim().length === 0
                        ? absent('nothing to send')
                        : value(action.message),
                send: value(action.submit ? SEND_PHRASES.submit : SEND_PHRASES.hold),
                sendTo: value(SEND_TO_PHRASES[action.sendTo]),
            };
        case 'webhook':
            return { provider: webhook ? value(webhook.provider) : NOT_IN_THIS_RULE };
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
    // ONE row, for the same reason `cond` has one: the two modes say different things
    // (§6.2 *hold 30 seconds*, §6.3 *09:00, weekdays*) and `FACE_ROWS` is keyed by KIND, so a
    // two-row layout would have to give one of them a label that lies. `when` carries the mode in
    // its own words instead — mockup §03's `Fires` row, which is the row that section draws.
    timer: [
        { label: 'Fires', key: 'when' },
    ],
    action: [
        { label: 'Send', key: 'message' },
        { label: 'Then', key: 'send' },
    ],
    webhook: [
        // The endpoint is a credential. Provider is the only webhook configuration safe to show
        // on the canvas; Task 12 owns its editable inspector.
        { label: 'Post', key: 'provider' },
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

    // The rule's runtime pill goes on the card that DRIVES the rule, and only when there is a
    // runtime to report. A fresh draft has no pairs, so its foot is empty rather than optimistic;
    // §10.20 asserts it never reads "fired" or "completed", because a node claiming a state its
    // rule has never been in is how the mockup's rev 1 lied.
    if (step === runtimeFootStep(rule) && ctx.pairs && Object.keys(ctx.pairs).length > 0) {
        return {
            title: STEP_LABELS[step],
            rows,
            foot: automationRowState(rule, ctx.pairs, ctx.now).pillText,
            footTone: 'live',
        };
    }

    return { title: STEP_LABELS[step], rows, foot: null, footTone: null };
}

/**
 * Which card carries the rule's runtime — its live pill and its live dot — or `null` for a rule
 * that has no card to carry it.
 *
 * **The convention it replaces was "always the Compare-it card", and that convention expired.** It
 * was right while `cond` was mandatory: the arm machine lives on the comparison, every rule had
 * one, and rule-level runtime drawn there read as the rule's own. Plan 032 §3.1 made the step
 * optional and §6.3 gave the rule a Wait card that is its step ONE — so a schedule rule's
 * Compare-it card, whose own rows say *not in this rule*, was printing *Armed · waiting* about the
 * rule underneath them. `stateFor`'s dot had already been fixed for exactly that (`430a6d3`); the
 * foot was left because the pill it draws is TRUE of the rule, which is a different defect from a
 * false claim and a real one all the same: the card it is drawn on is not the rule's.
 *
 * So the answer is not "hide it" but "move it". The Wait card is where a schedule rule's runtime
 * belongs, because the clock is what drives that rule — the same relationship the comparison has to
 * a monitor rule, which is why `stepPosition` already numbers a `dailyAt` Wait card as step 1.
 *
 * **`cond` first, so nothing about a monitor rule moves.** A rule with both a comparison and a Wait
 * step (§6.2's *detect → wait 30 s → send*) keeps its pill on the comparison, where the arm machine
 * it reports actually lives; the Wait card there is a middle box, not a start.
 *
 * `null` for a rule with neither — `reload` refuses such a row as having "nothing to watch and no
 * schedule", so it has no runtime to report and the honest foot is no foot. `action` is deliberately
 * not the fallback: it is the only always-present card, which makes it the tempting answer and the
 * wrong one — a send is what the rule DOES, never what it is waiting on.
 *
 * One function and not two branches eight lines apart, because `faceFor` and `stateFor` are the
 * foot and the dot of the same card and a card whose two halves disagree about whether it is live
 * is the failure this module exists to prevent.
 */
function runtimeFootStep(rule: AutomationRule): StepKind | null {
    if (rule.graph.cond) return 'cond';
    if (rule.graph.timer && 'dailyAt' in rule.graph.timer.mode) return 'timer';
    return null;
}

export type NodeTone = 'error' | 'warn' | 'live' | 'ready' | 'absent';

/**
 * Does the rule actually HAVE this step? (plan 032 §3.1.)
 *
 * Every step is optional on the DTO: a rule needs at least one destination, not necessarily a
 * terminal send. Since task 29 `draftFromRule` draws only the steps a rule HAS, so the editor no longer opens
 * a schedule rule on three cards standing for steps it does not have — but this answer is still
 * load-bearing for every other reader of a graph, the test pane included, and for a row that reached
 * the store by some other route.
 */
function hasStep(rule: AutomationRule, step: StepKind): boolean {
    return rule.graph[step] != null;
}

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
    // **A step the rule does not HAVE is not a step that is configured.**
    //
    // `stateFor` never consulted `rule.graph`, so for an absent step — where validation correctly
    // reports nothing — it fell through to a green dot reading *"This step is configured."* on a
    // card whose own rows, from `stepValues`, read *"not in this rule"*. Same card, two claims: the
    // fourth site of the class `430a6d3` fixed at three. The title is built FROM
    // `NOT_IN_THIS_RULE` so the dot and the rows cannot be reworded apart.
    //
    // **Below the two problem branches, not above them, and that is deliberate.** The monitor
    // step's field list includes `targets`, and targeting survives an absent monitor step —
    // `targetMode`/`targetIds` are the rule's own columns (see `stepValues`), so a pinned schedule
    // rule with nothing ticked reports the blocking `targets.empty` against a step it does not
    // have, and the Watch row on that very card says which terminals are missing. An absent-step
    // guard placed first would swallow a real, actionable, on-screen error to say something the
    // rows already say.
    if (!hasStep(rule, step)) {
        return { tone: 'absent', title: `This step is ${NOT_IN_THIS_RULE.text}.` };
    }
    // The same card `faceFor`'s foot goes on, through the same function — see `runtimeFootStep`.
    // It can only name a step the rule HAS, so the absent-step guard above cannot be reached past.
    if (step === runtimeFootStep(rule) && ctx.pairs && Object.keys(ctx.pairs).length > 0) {
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
 * The subtitle's own step number — **counted over the steps the rule HAS**, in `STEP_ORDER`.
 *
 * This used to be `STEP_ORDER.indexOf(step) + 1` with one special case for a `dailyAt` wait, and
 * the special case was the tell. `STEP_ORDER` has five members while most rules have four, so every
 * four-step rule — which is every rule written before this milestone — drew cards numbered 1, 2, 3
 * and **5**, with the Send panel's own head reading *"Step 5 · what happens when it fires"* on a
 * canvas with no step 4 on it. Seen on screen on a stock template.
 *
 * Counting what the rule holds answers all three shapes with one rule rather than three: the
 * four-step chain ends at 4, a delay rule ends at 5 with the wait at 4, and a schedule rule's two
 * cards are 1 and 2 — which is the mockup's *"Step 1"* for the clock, arrived at rather than
 * special-cased. Plan 032 §3's HEAD-OR-MIDDLE wait needs no branch of its own once the count
 * follows the rule.
 *
 * **The fallback is for a card the rule does not have.** `automationDerive` draws placeholder cards
 * (`NOT_IN_THIS_RULE`) for absent steps, and a step that is not in the count has no position in it;
 * such a card keeps `STEP_ORDER`'s fixed slot, which is what it stood in before and the only number
 * available for it.
 */
function stepPosition(rule: AutomationRule, step: StepKind): number {
    const held = STEP_ORDER.filter((s) => hasStep(rule, s));
    const at = held.indexOf(step);
    return at >= 0 ? at + 1 : STEP_ORDER.indexOf(step) + 1;
}

/**
 * The inspector panel's model.
 *
 * A panel component renders controls bound to `rule.graph`, but everything it *displays as text* —
 * summaries, the head's subtitle, the problem list — comes from here, so the two renderings cannot
 * describe different rules.
 */
export function panelFor(rule: AutomationRule, step: StepKind, ctx: DeriveContext): PanelModel {
    const index = stepPosition(rule, step);
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
        // No parse step, nothing to say about a pattern that does not exist.
        saying: step === 'parse' && rule.graph.parse
            ? sayPattern(rule.graph.parse.find, rule.graph.parse.keep)
            : null,
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
    const step = rule.graph.cond;
    // A rule with no condition step is not waiting on anything this sentence can name — a schedule
    // rule fires on the clock (§6.3), which is a Timer clause the rail does not have yet (§7, M5).
    if (!step) return 'with nothing to watch for';
    if ((step.clauses ?? []).length > 0) {
        return `when ${pattern} matches and ${condSentence(step)}`;
    }
    if (step.kind === 'text') return `when ${pattern} appears`;
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
    const timer = rule.graph.timer;
    const destination = rule.graph.action
        ? {
            verb: rule.graph.action.submit ? 'send' : 'type',
            message: rule.graph.action.message,
        }
        : {
            verb: 'post',
            message: rule.graph.webhook?.provider ?? 'no destination',
        };
    // A schedule fires on its clock even when it carries monitor/parse/cond steps (the validator
    // reports that shape separately), so it takes the same precedence as `describeRule` below.
    // The rail omits targets: the list row has no room for them and saying it is “watching” would
    // describe the schedule as an absence rather than a clock-triggered send.
    if (timer && 'dailyAt' in timer.mode) {
        const { minuteOfDay, days } = timer.mode.dailyAt;
        const at = clockTime(minuteOfDay);
        const when = describeDays(days);
        if (at !== null && when !== '') {
            return `At ${at} on ${when} · ${destination.verb} ${destination.message}`;
        }
    }
    const monitor = stepValues(rule, 'monitor');
    const parse = stepValues(rule, 'parse');
    const cond = stepValues(rule, 'cond');
    return `Watching ${monitor.terminals.text} · ${whenPhrase(rule, parse.find.text, cond)} · ${
        destination.verb
    } ${destination.message}`;
}

/**
 * What each wire carries, keyed by the port it LEAVES — the chip `AuWires` draws on it (mockup §03:
 * *"the value rides on the wire: `"ctx:63%"` → `63` → `yes`"*).
 *
 * **`Record<OutPortKey, string>`, and that is the point.** This was a `Record<string, string>` built
 * from four hardcoded keys, so the wait step's output had no entry and `AuWires`' `{chip ?? '·'}`
 * drew a bare dot — on a five-card rule beside four wires that all read a word, and on a schedule
 * rule where it is the canvas's only wire. Keyed off the port table, a port with no chip is a `tsc`
 * error rather than a dot nobody notices.
 *
 * `parse.out` and `cond.true` are the two a dry run can improve on with a real observed value; the
 * editor overlays those and takes the rest from here.
 */
export const WIRE_CHIPS: Record<OutPortKey, string> = {
    'monitor.out': 'lines',
    'parse.out': 'value',
    'cond.true': 'yes/no',
    'cond.false': 'no',
    // What leaves the Wait step is the wait being OVER — not the verdict that went in, and on a
    // schedule rule there was no verdict at all. Same word as the port's own label.
    'timer.out': 'go',
};

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
    /**
     * `when the number in` / `when output starts matching` / `when` / `at` — never carries the
     * pattern or the clock. `'at'` is the schedule mode's own lead (§6.3, §7): it pairs with
     * `subject` carrying the time and days, and with `verb`/`detail` both null, because a schedule
     * rule reads nothing for this sentence to mention.
     */
    lead: string;
    /**
     * The pattern, or the literal the user typed when there is one — emphasised by the row. In
     * schedule mode this carries the clock and days instead (`09:00 on weekdays`), because there is
     * no pattern to show.
     */
    subject: string;
    /** The condition verb, or null when the condition needs none (a plain event rule, or a schedule). */
    verb: string | null;
    /**
     * What the verb reads against, emphasised by the row: a v1 threshold, or the whole clause
     * sentence. Null when the verb is.
     */
    detail: string | null;
    /**
     * The Wait step's own clause — `wait 30 seconds` — shown between the condition and the send in
     * DELAY mode. `null` when there is nothing to add there: no wait step, a delay with no length
     * typed yet (the validator's own blocking sentence covers that), or SCHEDULE mode, whose
     * `lead`/`subject` already carry the whole timing — a second clause would repeat the clock.
     */
    waitClause: string | null;
    /** `send` or `type` — *Answer a confirmation* deliberately does not press Enter. */
    verbSend: string;
    message: string;
    /** ` — no Enter` when the action leaves the text in the composer, else null. */
    sendNote: string | null;
}

/**
 * The wait clause between the condition and the send — `wait 30 seconds` — read through
 * `describeDelay` so the row and the Wait panel's own sentence (`waitSentence`, `stepValues`) never
 * spell one delay two different ways (§1.1). `null` for a schedule timer: `describeRule` never asks
 * this for one, since the clock already carries the whole story in `lead`/`subject`.
 */
function delayClause(timer: AutomationTimerStep | undefined): string | null {
    if (!timer || !('afterMatch' in timer.mode)) return null;
    const { delayMs } = timer.mode.afterMatch;
    // Not yet given a length: the validator's own `timer.delayTooShort` covers a value under the
    // floor, and this must not invent a number the rule does not have for one that is merely unset.
    if (delayMs <= 0) return null;
    return `wait ${describeDelay(delayMs)}`;
}

export function describeRule(rule: AutomationRule): RuleSentence {
    const { parse, cond, timer, action } = rule.graph;
    const send = action
        ? {
        verbSend: action.submit ? 'send' : 'type',
        message: action.message,
        sendNote: action.submit ? null : ' — no Enter',
        }
        : {
            verbSend: 'post',
            message: rule.graph.webhook?.provider ?? 'no destination',
            sendNote: null,
    };

    // **Schedule mode leads with the clock and never with the output.** §6.3: the walk skips
    // `host.tail` for the WHOLE rule on every tick, so there is no condition this sentence could
    // describe truthfully — including for the blocked shape that also carries a monitor
    // (`timer.scheduleWithMonitor`), which is exactly why this is checked before `parse`/`cond` are
    // ever consulted, not after.
    if (timer && 'dailyAt' in timer.mode) {
        const { minuteOfDay, days } = timer.mode.dailyAt;
        const at = clockTime(minuteOfDay);
        const when = describeDays(days);
        if (at !== null && when !== '') {
            return {
                lead: 'at',
                subject: `${at} on ${when}`,
                verb: null,
                detail: null,
                waitClause: null,
                ...send,
            };
        }
        // An unfinished schedule (a bad minute, or no days picked) has nothing worth naming yet —
        // `timer.badMinute`/`timer.noDays` are the validator's own words for it — so this falls
        // through to "says only what it sends" below, the same honest answer a rule with no
        // parse/cond step gets.
    }

    const waitClause = delayClause(timer);

    // **A rule with no parse or cond step says only what it sends.**
    if (!parse || !cond) {
        return { lead: '', subject: '', verb: null, detail: null, waitClause, ...send };
    }
    const subject = parse.literal && parse.literal.length > 0 ? parse.literal : parse.find;

    // A clause list supersedes `op`/`threshold` (§5.3), so it is asked FIRST and for BOTH `finds`:
    // an event rule with clauses used to read "when X appears" and drop them. One reading, through
    // `condSentence` — the same function the node face and `CondPanel` read.
    if ((cond.clauses ?? []).length > 0) {
        return {
            lead: 'when', subject, verb: 'matches and', detail: condSentence(cond), waitClause, ...send,
        };
    }
    if (cond.kind !== 'number') {
        return { lead: 'when output starts matching', subject, verb: null, detail: null, waitClause, ...send };
    }
    // **The same blocked shape, on the third surface.** `OP_WORDS[cond.op ?? 'gt']` invented
    // *"rises above"* for a comparison the rule does not carry and paired it with a `detail` of
    // `null`, which the row draws as an empty `<b>`. One reading, through `condSentence` — §1.1:
    // two surfaces on one screen must not make opposite claims about one rule.
    if (cond.op == null || cond.threshold == null) {
        return {
            lead: 'when', subject, verb: 'matches, but', detail: condSentence(cond), waitClause, ...send,
        };
    }
    return {
        lead: 'when the number in',
        subject,
        verb: OP_WORDS[cond.op] ?? 'reaches',
        detail: String(cond.threshold),
        waitClause,
        ...send,
    };
}
