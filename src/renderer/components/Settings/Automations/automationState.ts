/**
 * The list row's runtime state, derived — never stored (plan 028 §5.3, Q5).
 *
 * Two states, two controls: the **toggle** says whether the user wants the rule on, the **pill**
 * says what it is doing. Collapsing those into one switch is what makes automation feel haunted
 * (mockup §01), so this module answers only the second question and the row reads `rule.enabled`
 * for the first.
 *
 * Everything here is pure over `(rule, pairs)` so the panel, and later the editor's header, cannot
 * disagree about what a rule's state is — the failure the mockup's own rev 1 shipped, where the
 * canvas and the inspector eight pixels away described different rules.
 */
import type { AutomationRule } from '../../../types/electron';
import type { AutomationRuntimePairState } from '../../../services/automationEvents';

/**
 * The shared state vocabulary of mockup §09. The same seven ids name the list pill, and in M5 the
 * editor header and each node's dot, so a word learned in one place keeps its meaning everywhere.
 */
export type AutomationRowStateId =
    | 'off'
    | 'completed'
    | 'error'
    | 'fired'
    | 'rearm'
    | 'matched'
    | 'waiting';

/**
 * Severity-max, in Q5's order. A rule watching several terminals is described by its **worst**
 * pair, because that is the one that needs attention; the qualifier then says how many.
 *
 * The mockup never states the order, and getting it wrong makes rows describe rules incorrectly —
 * a rule with one dead terminal and one happily armed one must not read *Armed · waiting*.
 */
const SEVERITY: AutomationRowStateId[] = [
    'off',
    'completed',
    'error',
    'fired',
    'rearm',
    'matched',
    'waiting',
];

/** The pill's words, exactly as mockup §09 spells them. No state is signalled by colour alone. */
const LABELS: Record<AutomationRowStateId, string> = {
    off: 'Off',
    completed: 'Completed',
    error: 'Error',
    fired: 'Just fired',
    rearm: 'Fired · waiting to re-arm',
    matched: 'Matched',
    waiting: 'Armed · waiting',
};

/**
 * How long *Just fired* is shown before the row settles into *waiting to re-arm*.
 *
 * It is the receipt, not a state you get stuck in (mockup §09). Six seconds because the engine
 * coalesces `automation:state` to one per second and the send itself holds a 500 ms paste gap, so
 * anything much shorter would be gone before the event that announces it arrives.
 */
export const JUST_FIRED_MS = 6000;

export interface AutomationRowState {
    id: AutomationRowStateId;
    /** The pill's words without the qualifier. */
    label: string;
    /** `'1 of 2'` when the winning state is not shared by every watched terminal, else null. */
    qualifier: string | null;
    /** What the pill actually renders — label, qualifier and the state's own noun, already joined. */
    pillText: string;
    /**
     * A *Completed* rule keeps its toggle **on but inert** and gains a Reset: switching it off and
     * on again would be a confusing way to re-arm it, so it isn't the mechanism (mockup §01, §09).
     */
    toggleDisabled: boolean;
}

/** The noun that follows the qualifier, so `Error · 1 of 2 missing` reads as the mockup draws it. */
const QUALIFIER_NOUN: Partial<Record<AutomationRowStateId, string>> = {
    error: 'missing',
};

/**
 * One pair's contribution. Kept separate from the fold so the ordering above is the only place
 * severity is decided.
 *
 * **`matched` has no producer today, and that is deliberate rather than forgotten.** It means
 * *"the condition is true right now and the rule is armed, so the next check will fire it"*, and
 * this engine never rests there: `loops.rs` advances the arm to `Fired` in the same statement that
 * decides the crossing, precisely so a second tick arriving mid-send cannot queue a duplicate. The
 * id stays in the union because the vocabulary is shared with the editor (M5) and because dropping
 * a word the mockup teaches would make the two surfaces disagree — but nothing below returns it,
 * and a test asserts the mapping rather than pretending to observe it. Producing it needs a new
 * fact in `RuntimePairState` (the last decision, or a `condition_true` bit); that is a backend
 * change and it is raised, not smuggled in here.
 */
function pairState(pair: AutomationRuntimePairState, now: number): AutomationRowStateId {
    if (pair.missing) return 'error';
    if (pair.state === 'fired') {
        const at = pair.lastFiredAt;
        return at !== null && now - at <= JUST_FIRED_MS ? 'fired' : 'rearm';
    }
    // `unseen` and `armed` are both resting states: the rule is watching and the condition is not
    // true. They differ only in read depth (§2.2c), which is not something a row can usefully say.
    return 'waiting';
}

/**
 * The row's runtime state.
 *
 * `pairs` is `runtime.rules[rule.id]` — **undefined and empty mean different things.** Undefined is
 * "the engine has not reported this rule", which happens on first paint before
 * `get_automation_runtime` resolves and for every disabled rule; empty is "the engine is running
 * this rule and nothing matches its criterion", which is the mockup's *Nothing to watch* error. A
 * live set is not existence (`live-set-is-not-existence`), so absence must not paint an error.
 */
export function automationRowState(
    rule: AutomationRule,
    pairs: Record<string, AutomationRuntimePairState> | undefined,
    now: number,
): AutomationRowState {
    const id = winningState(rule, pairs, now);
    const qualifier = qualifierFor(id, pairs, now);
    const noun = QUALIFIER_NOUN[id];
    const label = id === 'rearm' && !everFired(pairs, now) ? 'Waiting to re-arm' : LABELS[id];
    return {
        id,
        label,
        qualifier,
        pillText: qualifier
            ? `${label} · ${qualifier}${noun ? ` ${noun}` : ''}`
            : label,
        // Completed is a success, not a problem, and not an off switch: the toggle stays on and
        // stops responding, and Reset is what makes the rule eligible again.
        toggleDisabled: id === 'completed',
    };
}

/**
 * Has any watched terminal ACTUALLY fired?
 *
 * A presence rule switched on while its text is already on screen is **held**, not fired: the
 * engine logs `held — "…is still on screen"`, sends nothing (correctly — it must not fire on output
 * that was there before it was switched on), and leaves the pair at `state: 'fired'` with
 * `lastFiredAt: null`. `pairState` folds that to `rearm`, whose label begins *"Fired · "* — so the
 * row painted **Fired · waiting to re-arm** directly beside its own footer **Never fired**, with the
 * activity log agreeing with the footer. One row, two answers.
 *
 * The state itself is right — the rule really will not fire until the text stops matching — so this
 * drops only the word that is false, rather than inventing a state id the mockup does not teach.
 *
 * **Asked of the pairs that WON, not of the rule.** The label describes one bucket, so evidence from
 * outside that bucket cannot answer for it: a rule watching `tm-1` (fired for real five minutes ago,
 * now resting) and `tm-2` (held, never fired) wins `rearm` on `tm-2` alone, and a rule-wide scan then
 * finds `tm-1`'s timestamp and restores the very word `tm-2` makes false. That is this same defect
 * one level up from where it was first fixed.
 */
function everFired(
    pairs: Record<string, AutomationRuntimePairState> | undefined,
    now: number,
): boolean {
    return (
        !!pairs
        && Object.values(pairs)
            .filter((p) => pairState(p, now) === 'rearm')
            .some((p) => p.lastFiredAt !== null)
    );
}

function winningState(
    rule: AutomationRule,
    pairs: Record<string, AutomationRuntimePairState> | undefined,
    now: number,
): AutomationRowStateId {
    if (!rule.enabled) return 'off';
    if (rule.completedAt !== null && rule.completedAt !== undefined) return 'completed';
    if (pairs === undefined) return 'waiting';

    const ids = Object.values(pairs).map((p) => pairState(p, now));
    // An enabled rule the engine is running with nothing to watch: the mockup's *Rate-limit
    // backoff* row. It will start watching on its own as soon as a matching terminal opens, which
    // is what the row's error line says — so this is an explanation, not a dead end.
    if (ids.length === 0) return 'error';

    let worst: AutomationRowStateId = 'waiting';
    for (const candidate of ids) {
        if (SEVERITY.indexOf(candidate) < SEVERITY.indexOf(worst)) worst = candidate;
    }
    return worst;
}

/**
 * `N of M` — but only when the pairs **disagree**. A rule whose terminals are all in the winning
 * state needs no qualifier: *Error · 2 of 2 missing* says nothing *Error* did not.
 */
function qualifierFor(
    id: AutomationRowStateId,
    pairs: Record<string, AutomationRuntimePairState> | undefined,
    now: number,
): string | null {
    if (!pairs) return null;
    const ids = Object.values(pairs).map((p) => pairState(p, now));
    const hits = ids.filter((candidate) => candidate === id).length;
    // No `ids.length < 2` guard above: it looked like the "a single terminal needs no qualifier"
    // rule but it was DEAD, because one pair always satisfies `hits === ids.length` and zero pairs
    // always satisfies `hits === 0`. Mutation found it — deleting it changed nothing, which is the
    // signature of a guard whose test is really exercising the check below it.
    if (hits === 0 || hits === ids.length) return null;
    return `${hits} of ${ids.length}`;
}

// =================================================================================================
// The row's sentence
// =================================================================================================

// =================================================================================================
// The rest of the row's meta line
// =================================================================================================

/**
 * *Watching command contains "claude"* — the criterion in the words the picker uses.
 *
 * **Reads `targetMode` first, because a rule has two ways of choosing terminals and only one of
 * them is the criterion.** A `pinned` rule watches the ids the user picked and `watched_set`
 * ignores its criterion entirely — but the criterion columns are non-optional and keep whatever
 * they last held, so switching on `rule.criterion` alone made a rule watching two hand-picked
 * terminals read *"Watching all terminals"*. Both reviewers found that independently, and it is
 * the one thing this module promises cannot happen: a row describing a rule the engine is not
 * running.
 */
export function describeCriterion(rule: AutomationRule): string {
    if (rule.targetMode === 'pinned') {
        const n = rule.targetIds.length;
        return `${n} picked terminal${n === 1 ? '' : 's'}`;
    }
    switch (rule.criterion) {
        case 'allTerminals':
            return 'all terminals';
        case 'commandContains':
            return `command contains "${rule.criterionValue}"`;
        case 'tabNameContains':
            return `tab name contains "${rule.criterionValue}"`;
        case 'workingFolderUnder':
            return `working folder under ${rule.criterionValue}`;
        case 'terminalIdIs':
            return `terminal id is ${rule.criterionValue}`;
        default:
            return rule.criterionValue;
    }
}

/** *Checks every 30s* / *On every new line*. */
export function describeCadence(rule: AutomationRule): string {
    const { monitor } = rule.graph;
    if (monitor.cadence === 'onOutput') return 'On every new line';
    const ms = monitor.everyMs;
    if (ms % 60000 === 0) {
        const mins = ms / 60000;
        return `Checks every ${mins} min`;
    }
    return `Checks every ${Math.round(ms / 1000)}s`;
}

/** How many of the rule's watched terminals are open right now, or null when unknown. */
export function openCount(
    pairs: Record<string, AutomationRuntimePairState> | undefined,
): number | null {
    if (!pairs) return null;
    return Object.values(pairs).filter((p) => !p.missing).length;
}

/**
 * The whole *"Watching ... · N now"* line, assembled here rather than in the row.
 *
 * The mockup uses different words for the two targeting modes — a pinned rule reads
 * *"2 picked terminals · 1 open"* and a criterion rule reads *"command contains \"claude\" · 2 now"*
 * — and a component that joined a noun to a count would have to know which mode it was in. That is
 * the same reason `describeRule` returns its pieces instead of a string: whatever a component has
 * to re-derive, it will eventually re-derive differently.
 */
export function describeWatching(
    rule: AutomationRule,
    pairs: Record<string, AutomationRuntimePairState> | undefined,
): string {
    const subject = describeCriterion(rule);
    const open = openCount(pairs);
    const watched = pairs ? Object.keys(pairs).length : 0;
    if (open === null || watched === 0) return subject;
    return rule.targetMode === 'pinned' ? `${subject} · ${open} open` : `${subject} · ${open} now`;
}

/** *Fired 4 min ago* — the mockup's own relative phrasing, not a wall-clock stamp. */
export function describeLastFired(at: number, now: number): string {
    const secs = Math.max(0, Math.round((now - at) / 1000));
    if (secs < 60) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    return new Date(at).toLocaleString();
}
