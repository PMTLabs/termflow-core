/**
 * The editor's validation (plan 028 §6.5, mockup §07) — and the **renderer half of two
 * implementations of one rule set**.
 *
 * The other half is `src-tauri/src/automation_validation.rs`, and the backend is the authority: it
 * owns *"is this rule allowed to run"* and must not be talked into enabling an invalid rule by a
 * stale renderer. This module exists so the editor can say *why* the toggle is off without a
 * round-trip, not so it can decide.
 *
 * **The two are pinned to each other by one shared fixture** — `__fixtures__/automationValidationCases.json`,
 * read by `automationValidation.test.ts` here and by `cargo test` there. Two implementations of one
 * rule set diverge the first time only one of them is edited, and the divergence is silent in the
 * worst possible direction: the editor greys a toggle the backend would have allowed (annoying), or
 * the editor allows one the backend refuses (a save that reports success and a rule that never runs).
 * `two-implementations-one-fix`.
 *
 * Every message below is the Rust one, character for character, because the fixture asserts the
 * `code` and this file's own test asserts the prose — and the prose is what the user reads.
 *
 * **What this gates: the *Enable* toggle, and one thing about Save.** §07 is explicit — "losing work
 * to a validation rule is its own bug" — so a draft with five problems saves happily and comes back
 * exactly as it was. A draft that is already **enabled** is the one exception, and it is the
 * backend's rule rather than this one's: `save_rule` refuses an enabled rule with a blocking
 * problem, because R10's failure is a live rule with an empty message pressing a bare Enter. The
 * editor resolves that without losing anything, by saving such a rule **switched off** — see
 * `AutomationEditor.tsx`'s header, point 4.
 */
import type {
    AutomationClause,
    AutomationGraph,
    AutomationParseStep,
    AutomationRule,
    AutomationSource,
} from '../../types/electron';
import { tokensUsed } from './automationTokens';

export type Severity = 'blocks' | 'warns';

/** Which step owns a problem, so the editor can point at the panel that fixes it. */
export type ProblemField = 'targets' | 'monitor' | 'parse' | 'cond' | 'timer' | 'action';

/**
 * A stable identity for the RULE that fired.
 *
 * The shared fixture compares these rather than the prose: one case is an uncompilable pattern,
 * whose message quotes the regex engine's own error text, and Rust's `regex` and the browser's
 * `RegExp` word that differently. It is also what lets a node badge be chosen per rule without
 * sniffing a message for a substring.
 */
export type ProblemCode =
    | 'targets.empty'
    | 'targets.criterion'
    | 'monitor.interval'
    | 'parse.empty'
    | 'parse.uncompilable'
    | 'parse.noBrackets'
    | 'parse.manyGroups'
    | 'cond.incomplete'
    | 'cond.unknownToken'
    | 'cond.clauseNeedsValue'
    | 'cond.badClausePattern'
    | 'cond.clauseWithoutParse'
    | 'timer.delayTooShort'
    | 'timer.delayTooLong'
    | 'timer.badMinute'
    | 'timer.noDays'
    | 'timer.scheduleWithMonitor'
    | 'timer.neverRuns'
    | 'action.empty'
    | 'action.echo'
    | 'action.tokenWithoutParse'
    | 'action.unknownToken';

export interface Problem {
    severity: Severity;
    field: ProblemField;
    code: ProblemCode;
    message: string;
}

/**
 * The floor on a timer rule's interval — `automation_engine::due::EVENT_MIN_INTERVAL_MS`.
 *
 * `due_now` clamps anything faster, so a rule asking for 100 ms would silently get 250, and a
 * validation rule that lets a user type a number the engine then ignores is worse than one that says
 * so. The fixture pins the constant from both sides: a case at exactly this value expects no problem
 * and a case below it expects one, so a floor that moves on either side goes red on the other.
 */
export const MIN_TIMER_MS = 250;

const problem = (
    severity: Severity,
    field: ProblemField,
    code: ProblemCode,
    message: string,
): Problem => ({ severity, field, code, message });

/**
 * Compile a user pattern the way the browser will run it for the live preview.
 *
 * **This is not the compiler that decides whether a rule may run.** Rust's `regex` is a strict
 * subset of JS syntax — no backtracking, no lookaround — so a pattern that builds here can still be
 * refused by the engine at load, and §2.7 gives `reload` that refusal reported once per load. The
 * asymmetry is deliberate and one-directional: this side is the more permissive one, so it can warn
 * about too little but never about too much.
 */
export function compilePattern(find: string): RegExp | null {
    try {
        return new RegExp(browserSource(find));
    } catch {
        return null;
    }
}

/**
 * The pattern as **V8** must spell it, so this side stays the permissive one.
 *
 * `regex` keeps `(?P<name>…)` as its own historical spelling of a named group and runs it; V8
 * accepts only `(?<name>…)` and throws `Invalid group`. Left alone, the editor blocked the Enable
 * toggle and printed *"That pattern could not be understood"* for a pattern **the authority would
 * run** — the strict direction the sentence above says cannot happen.
 *
 * A RESCUE, never a rewrite: the substitution is reached only after V8 has already refused the
 * pattern as typed, so it can turn a refusal into an acceptance and can never change the meaning of
 * a pattern V8 accepts. The two spellings mean the same thing to `regex`, so the group this reports
 * is the group the engine keeps.
 */
function browserSource(find: string): string {
    try {
        // eslint-disable-next-line no-new
        new RegExp(find);
        return find;
    } catch {
        return find.includes('(?P<') ? find.replace(/\(\?P</g, '(?<') : find;
    }
}

/** The compile error the browser gives, first line only — the shape Rust's message has. */
function compileError(find: string): string {
    try {
        // eslint-disable-next-line no-new
        new RegExp(find);
        return '';
    } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        return (text.split('\n')[0] ?? text).trim();
    }
}

/**
 * How many capture groups a pattern has, and the names it declares.
 *
 * `find + '|'` is the standard trick: the alternation with an empty branch makes the expression
 * match the empty string, so `exec('')` always returns a result whose `length - 1` is the group
 * count and whose `.groups` carries every named group. Counting brackets by hand would be a second
 * regex parser, and it would be wrong about `\(`, `(?:` and character classes on its first day.
 *
 * **`names` is what the pattern DECLARES, not what matched** — there is no match at validation
 * time, only a probe against the empty string, so a name is either declared by the pattern or it
 * is not. `hasNamedValue` used to collapse this to one boolean question (`value`, or not); §5's
 * token check needs the full set, to ask of an arbitrary `${name}` whether the pattern could ever
 * supply it.
 *
 * Only ever called on a pattern that has already compiled.
 */
export function groupsOf(find: string): { count: number; names: Set<string> } {
    try {
        const probe = new RegExp(`${browserSource(find)}|`);
        const m = probe.exec('');
        if (!m) return { count: 0, names: new Set() };
        const groups = m.groups as Record<string, unknown> | undefined;
        return {
            count: m.length - 1,
            names: new Set(groups ? Object.keys(groups) : []),
        };
    } catch {
        return { count: 0, names: new Set() };
    }
}

/**
 * Whether a captured token — a clause's `AutomationSource`, or a message's `$N`/`${name}` — is
 * one the pattern's compiled groups can actually supply.
 *
 * **Shared by `cond.unknownToken` and `action.unknownToken`**, so a clause and a message can
 * never disagree about what `$2` means (plan 032 §8) — two different answers to "does this
 * pattern have a group 2" is the drift this milestone keeps having to fix.
 */
function tokenSupplied(
    groups: { count: number; names: Set<string> },
    group: number | null,
    name: string | null,
): boolean {
    if (group !== null) return group <= groups.count;
    if (name !== null) return groups.names.has(name);
    return true; // $0 / Source::Whole is always the whole match.
}

/**
 * `$0` / `$2` / `${name}`, for a clause's own problem message.
 *
 * Exported so `CondPanel`'s token dropdown and `automationDerive`'s clause sentence spell a token
 * exactly the way a validation message about that same token does — one formatter, so a problem
 * and the row it names can never disagree about what `$2` prints as.
 */
export function sourceText(source: AutomationSource): string {
    if (source === 'whole') return '$0';
    if ('group' in source) return `$${source.group}`;
    return `\${${source.named}}`;
}

/**
 * The rule's PARSE step, when it has one that can source clause tokens.
 *
 * **Two different absences, one answer.** A schedule rule (plan 032 §6.3) has no parse step at
 * all; an ordinary rule can have one whose declared pattern is blank, which `parse.empty` already
 * reports on the `parse` field. Neither can supply a token, so both read `null` here.
 *
 * Returns the step rather than a boolean so a caller that has proved presence does not have to ask
 * again — the Rust mirror's `parse_step` does exactly the same.
 */
function parseStep(graph: AutomationGraph): AutomationParseStep | null {
    const parse = graph.parse;
    return parse && parse.find.trim().length > 0 ? parse : null;
}

/**
 * Everything wrong with the COND step's clause list — §8's four `cond.*` codes (plan 032 §5.3,
 * §5.4).
 *
 * **An empty list is legal and reports nothing.** It means "fire when the pattern matches",
 * exactly today's text rule — not a special case invented for this check, the existing behaviour
 * written down (§5.4).
 */
/**
 * The reason a clause cannot yet be judged from a capture.
 *
 * The validator owns this predicate and `CondPanel` reads it before drawing a verdict, so a row
 * cannot show a green or red answer beside the blocking problem that says its operand is unfinished.
 */
export function clauseVerdictBlocker(clause: AutomationClause): 'needsValue' | 'badPattern' | null {
    if ('number' in clause.test) {
        const { value } = clause.test.number;
        return value === null || !Number.isFinite(value) ? 'needsValue' : null;
    }

    const { op, value } = clause.test.text;
    if (op !== 'isEmpty' && op !== 'isNotEmpty' && value.trim().length === 0) return 'needsValue';
    return op === 'matches' && compilePattern(value) === null ? 'badPattern' : null;
}

function clauseProblems(graph: AutomationGraph): Problem[] {
    const out: Problem[] = [];
    // No cond step at all is no clauses at all — a schedule rule (§6.3) reports nothing here.
    // Absence is a no-op for this check, never a substitute check invented for it.
    const clauses = graph.cond?.clauses ?? [];
    if (clauses.length === 0) return out;

    const parse = parseStep(graph);
    if (!parse) {
        out.push(
            problem(
                'blocks',
                'cond',
                'cond.clauseWithoutParse',
                'This condition compares a captured value, but the rule has no pattern to capture it from.',
            ),
        );
        return out;
    }

    // Only ask the pattern for its groups once it can compile — an uncompilable pattern is
    // already `parse.uncompilable`'s problem, not this one's, exactly like `action.unknownToken`.
    const groups = compilePattern(parse.find) !== null ? groupsOf(parse.find) : null;

    for (const clause of clauses) {
        if (groups) {
            const bad = clause.source === 'whole'
                ? false
                : 'group' in clause.source
                    ? !tokenSupplied(groups, clause.source.group, null)
                    : !tokenSupplied(groups, null, clause.source.named);
            if (bad) {
                out.push(
                    problem(
                        'blocks',
                        'cond',
                        'cond.unknownToken',
                        `${sourceText(clause.source)} has nothing to stand for. The pattern in Read a value has `
                            + `${groups.count} bracketed group${groups.count === 1 ? '' : 's'}, so the highest you can use is $${groups.count}.`,
                    ),
                );
            }
        }

        const blocker = clauseVerdictBlocker(clause);
        if (blocker === 'needsValue' && 'number' in clause.test) {
            // **Reached by the ordinary path.** `value` is `number | null`, and `null` is what
            // `CondPanel` writes the moment a row is switched from a text operator to a numeric
            // one, or a number is half-typed — §8's *"a numeric clause with no threshold"*. The
            // finiteness half stays for a value that arrives by computation rather than by typing:
            // comparing against NaN/Infinity is exactly the silent-failure shape `CompareOp::Neq`'s
            // own doc warns about for a COERCED token.
            out.push(
                problem(
                    'blocks',
                    'cond',
                    'cond.clauseNeedsValue',
                    'Enter a number to compare this value with.',
                ),
            );
        } else if ('text' in clause.test) {
            const { value } = clause.test.text;
            if (blocker === 'needsValue') {
                out.push(
                    problem(
                        'blocks',
                        'cond',
                        'cond.clauseNeedsValue',
                        'Enter some text to compare this value with.',
                    ),
                );
            } else if (blocker === 'badPattern') {
                out.push(
                    problem(
                        'blocks',
                        'cond',
                        'cond.badClausePattern',
                        `This clause's own pattern could not be understood: ${compileError(value)}`,
                    ),
                );
            }
        }
    }

    return out;
}

/**
 * The floor on an `AfterMatch` wait — plan 032 §12 item 1. `MIN_TIMER_MS` (250 ms) is a POLL floor
 * and too permissive for a delay: a sub-second "wait" is a send, not a wait.
 */
export const MIN_DELAY_MS = 1_000;

/**
 * The ceiling on an `AfterMatch` wait — plan 032 §12 item 2. Mirrors `MAX_DELAY_MS` in
 * `automation_validation.rs`.
 *
 * **A parked send lives only in memory.** The engine's `parked` map is built empty at launch and
 * never persisted, so a wait that outlives the process is a message the feature quietly never
 * sends. The cap is what keeps the promise the editor makes by accepting a delay at all.
 *
 * It equals the engine's `ECHO_TTL_MS` today **by coincidence, and the two are unrelated** — the
 * echo needle's life starts when the write LANDS, not at the crossing, so no wait length can
 * outlive it. `MAX_DELAY_MS`'s own doc on the Rust side carries the evidence.
 *
 * TypeScript cannot import a Rust constant, so this number is typed by hand — kept honest, not
 * merely commented, by the shared fixture's two `timer.delayTooLong` boundary cases: one wait at
 * exactly this value (blocks) and one a millisecond under it (clean). If `MAX_DELAY_MS` ever moves
 * in `automation_validation.rs` without this constant moving with it, one of those two cases starts
 * failing on THIS side, in this file's own test run — the drift cannot go silent.
 */
export const MAX_DELAY_MS = 10 * 60 * 1_000;

/**
 * Bits 0–6 of a `dailyAt` timer's `days` are Mon..Sun (plan §3.1). The type is a `number` on this
 * side, but the wire value is a Rust `u8`, which has an 8th bit (0x80) that names no weekday at
 * all. This mask is what `timer.noDays` checks against, so a hand-crafted or corrupted mask with
 * ONLY that spare bit set is still "no day selected" rather than slipping past validation into a
 * schedule that silently never fires — the same decision `automation_validation.rs` makes.
 */
const WEEKDAY_BITS_MASK = 0b0111_1111;

/**
 * The exclusive upper bound on a `dailyAt` timer's `minuteOfDay` — `0..1440`, midnight inclusive.
 *
 * The field is a bare number on both sides of the wire, and nothing else bounds it: `-5` makes the
 * engine's `now >= target` true from midnight every day, and `5000` makes it true never — a rule
 * that looks armed and silently is not. `automation_store.rs` holds the same bound for
 * `automation_validation.rs` and for §6.3's `schedule_due`, and the shared fixture's three
 * `timer.badMinute` cases are what keep this copy honest rather than merely commented.
 */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * **A rule needs input steps XOR a schedule, and this is the guard for the XOR itself** — not a
 * property of the delay instance that first surfaced it (plan 032 review, R7).
 *
 * The runtime's own answer to "can this rule ever do anything" is `InputSteps::of` on the Rust
 * side: `null` unless `monitor`, `parse` and `cond` are ALL present. The one other way a rule can
 * ever fire is a `dailyAt` schedule, which reads nothing and does not need them. Anything else — a
 * lone `afterMatch` wait with nothing to cross it, a bare graph with no timer and no input steps at
 * all, a monitor with no parse — can never do anything, and it must say so in VALIDATION rather
 * than rely on the engine's silent runtime skip: a rule holds for every producer — the editor, the
 * REST API, an import, an older build, and the mode-switch path that reaches this same shape by
 * switching a saved schedule rule's timer back to a delay without touching the input steps at all.
 *
 * **Mutually exclusive with `timer.scheduleWithMonitor` by construction**: this fires only when
 * `scheduled` is false, and that code fires only when it is true. One graph can never trip both
 * with contradictory remedies.
 *
 * The remedy differs by shape, so the message branches on whether a Wait step exists: with one
 * already on the canvas the fix is either add a Watch step or switch that Wait to a schedule; with
 * none at all there is no "switch it" to offer, only "add a Watch step" or "add a Wait step set to
 * a schedule". Naming a control the user does not have is C1's mistake, so this is not one sentence
 * that is wrong half the time.
 */
function neverRunsProblem(graph: AutomationGraph): Problem | null {
    const hasInputSteps = Boolean(graph.monitor) && Boolean(graph.parse) && Boolean(graph.cond);
    const scheduled = Boolean(graph.timer && 'dailyAt' in graph.timer.mode);
    // A blank message defers to `action.empty` alone — see the Rust mirror's doc for why (a brand
    // new draft with nothing drawn is not a claim about an undrawn Wait card).
    if (hasInputSteps || scheduled || graph.action.message.trim().length === 0) return null;
    const message = graph.timer
        ? 'This rule waits, but nothing will ever start the wait: it has no Watch output step to '
            + 'match against. Add one, or switch this Wait to run at a time of day instead.'
        : 'This rule has nothing that could ever run it: no terminals to watch, and no schedule '
            + 'either. Add a Watch output step, or add a Wait step set to run at a time of day.';
    return problem('blocks', 'timer', 'timer.neverRuns', message);
}

/**
 * Everything wrong with the WAIT step — §8's `timer.*` codes (plan 032 §6.2, §6.3, §12 item 1).
 *
 * Absent (no wait step at all) reports nothing: every rule saved before this milestone, and every
 * rule that does not use one, is unaffected.
 */
function timerProblems(graph: AutomationGraph): Problem[] {
    const out: Problem[] = [];
    const { timer } = graph;
    if (!timer) return out;

    const { mode } = timer;
    if ('afterMatch' in mode) {
        const { delayMs } = mode.afterMatch;
        if (delayMs < MIN_DELAY_MS) {
            // The number is DERIVED, never restated: a floor quoted as a literal lies the day the
            // constant moves, which is the same reason `monitor.interval` quotes `MIN_TIMER_MS`.
            out.push(
                problem(
                    'blocks',
                    'timer',
                    'timer.delayTooShort',
                    `Wait at least ${MIN_DELAY_MS / 1_000} second before sending.`,
                ),
            );
        } else if (delayMs >= MAX_DELAY_MS) {
            // §12 item 2, and NOT the echo needle — see `MAX_DELAY_MS` above for why that
            // justification was false. A parked send is held in memory and nowhere else, so the
            // words name the thing the cap actually protects the user from.
            out.push(
                problem(
                    'blocks',
                    'timer',
                    'timer.delayTooLong',
                    `Wait less than ${MAX_DELAY_MS / 60_000} minutes — a waiting message is held in memory and is lost if TermFlow quits.`,
                ),
            );
        }
    } else {
        // **A schedule DISABLES the whole read chain, silently, and that is why this blocks**
        // (§6.3, §8).
        //
        // The evaluator's walk asks `schedule_due` for a `DailyAt` rule and skips `host.tail`
        // entirely — for the whole rule, on every tick. So a rule carrying a schedule alongside
        // `monitor`, `parse` and/or `cond` stops reading its terminals: no log row, nothing on
        // screen, the pattern and the comparison simply never run again. Reported here, and FIRST,
        // because it is a fact about the rule's shape while the two below are about the schedule's
        // own fields.
        //
        // **Wider than a monitor check alone (I2).** The skip is of the whole read chain, not the
        // monitor: a graph with `parse` and/or `cond` but no `monitor` is admitted by `reload`,
        // runs on the clock, and silently ignores the pattern and the comparison too. This mirrors
        // the identical widening already made for `schema_version_for` (spec's `monitor == null`
        // widened to all three input steps), for the same reason: any one of the three is what
        // actually breaks the read, not the monitor specifically.
        //
        // **Making the editor's layout exclusive is not enough**, and this codebase has already
        // ruled so: `schedule_due` range-checks `minuteOfDay` and the weekday mask precisely
        // because a row that reached the store by another route — the API, an import — must not be
        // runnable-but-never-firing on one side and unfireable on the other
        // (`an_unfireable_rule_is_unfireable_on_both_sides`). Those routes can write any of the
        // three input steps alongside a `dailyAt` just as easily as a monitor.
        if (graph.monitor || graph.parse || graph.cond) {
            out.push(
                problem(
                    'blocks',
                    'timer',
                    'timer.scheduleWithMonitor',
                    'A schedule fires on the clock, so this rule will not read its terminals. '
                        + 'Remove the schedule, or remove the steps that read them.',
                ),
            );
        }
        const { minuteOfDay, days } = mode.dailyAt;
        if (minuteOfDay < 0 || minuteOfDay >= MINUTES_PER_DAY) {
            // The last minute of the day is DERIVED, never restated: `23:59` written out is a
            // sentence that goes false the day the bound moves. The floor is literal because zero is
            // what "minute of day" counts from — there is no constant behind it.
            const last = MINUTES_PER_DAY - 1;
            const hh = String(Math.floor(last / 60)).padStart(2, '0');
            const mm = String(last % 60).padStart(2, '0');
            out.push(
                problem('blocks', 'timer', 'timer.badMinute', `Pick a time between 00:00 and ${hh}:${mm}.`),
            );
        }
        if ((days & WEEKDAY_BITS_MASK) === 0) {
            out.push(problem('blocks', 'timer', 'timer.noDays', 'Pick at least one day for this to run.'));
        }
    }

    return out;
}

/**
 * Everything wrong with a rule's PARSE step. Blocks first, so a caller showing one shows the one
 * that matters.
 */
export function patternProblems(graph: AutomationGraph): Problem[] {
    const out: Problem[] = [];
    const { parse, cond } = graph;

    // A schedule rule (§6.3) has no parse step at all, which is NOT the same as a blank pattern:
    // there is no field here to be empty, so `parse.empty` would describe a step the rule does not
    // have. Nothing to report.
    if (!parse) return out;

    if (parse.find.trim().length === 0) {
        out.push(problem('blocks', 'parse', 'parse.empty', 'Enter something to look for.'));
        return out;
    }

    // The pattern AS TYPED. Leading and trailing whitespace is part of a regex — `"ctx: "` and
    // `"ctx:"` match different text — so trimming here would validate one expression and run
    // another. Emptiness is the one question asked of the trimmed text.
    if (compilePattern(parse.find) === null) {
        out.push(
            problem(
                'blocks',
                'parse',
                'parse.uncompilable',
                `That pattern could not be understood: ${compileError(parse.find)}`,
            ),
        );
        return out;
    }

    const { count, names } = groupsOf(parse.find);

    // `keep` is a NUMERIC-only concern. §2.2b's presence branch is `is_match` — no group, no
    // coercion, no `keep` — and `brackets` is the default a text rule carries around without ever
    // consulting it. Blocking on it refuses R8's own canonical rule (`FAILED \d+ test`) and makes
    // the whole word-matching half of the feature un-enableable.
    // No cond step is no comparison, so `keep` — a NUMERIC-only concern — has nothing to answer to.
    const numeric = cond?.kind === 'number';

    if (numeric && parse.keep === 'brackets' && count === 0) {
        out.push(
            problem(
                'blocks',
                'parse',
                'parse.noBrackets',
                'This pattern has no brackets, so there is no value to keep. '
                    + 'Put brackets around the part you want, or keep the whole match instead.',
            ),
        );
    }

    if (numeric && parse.keep === 'brackets' && count > 1 && !names.has('value')) {
        out.push(
            problem(
                'warns',
                'parse',
                'parse.manyGroups',
                'This pattern has more than one bracketed group. The comparison uses the first one; '
                    + 'name one of them `value` to use a different one instead. The rest are still available '
                    + 'in the message, as $2, $3 and so on.',
            ),
        );
    }

    return out;
}

/**
 * Everything wrong with a WHOLE rule — §6.5's five categories: **target, interval, pattern,
 * threshold, message**.
 */
export function problems(rule: AutomationRule): Problem[] {
    const out: Problem[] = [];
    const { monitor, parse, cond, action } = rule.graph;

    // --- target ----------------------------------------------------------------------------------
    // Only a PINNED rule can be empty in a way validation can see. A criterion rule that currently
    // matches nothing is not invalid — terminals open and close, which is the entire point of
    // re-resolving every two seconds.
    if (rule.targetMode === 'pinned') {
        if (rule.targetIds.length === 0) {
            out.push(
                problem(
                    'blocks',
                    'targets',
                    'targets.empty',
                    'Pick at least one terminal for this rule to watch.',
                ),
            );
        }
    } else if (rule.criterion !== 'allTerminals' && rule.criterionValue.trim().length === 0) {
        out.push(
            problem(
                'blocks',
                'targets',
                'targets.criterion',
                'Fill in what the terminals must match, or watch all terminals instead.',
            ),
        );
    }

    // --- interval --------------------------------------------------------------------------------
    // A schedule rule (§6.3) has no monitor step, so it has no poll interval to be too fast.
    if (monitor && monitor.cadence === 'timer' && monitor.everyMs < MIN_TIMER_MS) {
        out.push(
            problem(
                'blocks',
                'monitor',
                'monitor.interval',
                `Check no more often than every ${MIN_TIMER_MS} ms.`,
            ),
        );
    }

    // --- pattern ---------------------------------------------------------------------------------
    out.push(...patternProblems(rule.graph));

    // --- threshold -------------------------------------------------------------------------------
    // A numeric rule with no operator, no threshold, AND no clauses cannot be true of anything, and
    // `evaluate` reads it as unknown forever — a rule that runs, logs, and can never fire. `op` /
    // `threshold` are v1-only (§5.3): a rule built in the clause-list editor leaves both null and
    // expresses its comparison as a clause instead, so an empty clause list is what actually makes
    // this incomplete, not a bare absence of `op`/`threshold`.
    // A rule with no cond step reads no value and has nothing to compare it with, so there is no
    // incomplete comparison to report — the check is a no-op for it, not a substitute check.
    if (
        cond?.kind === 'number'
        && (cond.clauses ?? []).length === 0
        && (cond.op === null || cond.op === undefined
            || cond.threshold === null || cond.threshold === undefined)
    ) {
        out.push(
            problem(
                'blocks',
                'cond',
                'cond.incomplete',
                'Add a comparison — this rule reads a value but has nothing to compare it with.',
            ),
        );
    }

    // --- clauses ---------------------------------------------------------------------------------
    // §8's four `cond.*` codes: a clause sourcing a token the pattern cannot supply, a clause with
    // no value to compare, a `matches` clause whose own pattern will not compile, and any clause
    // at all on a rule with no pattern to read them from.
    out.push(...clauseProblems(rule.graph));

    // --- timer -----------------------------------------------------------------------------------
    // R7, first: a rule with no way to ever run at all — neither the input steps `InputSteps::of`
    // needs nor a schedule. Reported ahead of `timerProblems` for the same reason
    // `timer.scheduleWithMonitor` leads that function: it is a fact about the rule's shape, and the
    // two guards are mutually exclusive by construction (this one fires only when `scheduled` is
    // false; that one only when it is true), so a single graph never gets contradictory advice.
    const neverRuns = neverRunsProblem(rule.graph);
    if (neverRuns) out.push(neverRuns);

    // §8's `timer.*` codes: a wait shorter than the floor, a wait at or beyond `MAX_DELAY_MS` —
    // the ceiling a parked send's IN-MEMORY life sets, never the echo TTL it happens to equal, see
    // that constant's own doc — a schedule whose target is not a time of day, one whose weekday
    // mask selects no day, and one on a rule that still reads its terminals and would silently
    // stop.
    out.push(...timerProblems(rule.graph));

    // --- message ---------------------------------------------------------------------------------
    if (action.message.trim().length === 0) {
        out.push(
            problem(
                'blocks',
                'action',
                'action.empty',
                'Enter the message this rule should type.',
            ),
        );
    } else if (parse && parse.find.trim().length > 0) {
        // §2.6's failure, told to the user before it happens. The emptiness guard above is
        // load-bearing: an empty regex matches every position of every string, so without it every
        // draft with a message and no pattern yet is told its message matches a pattern it does not
        // have.
        // The pattern **as typed**, matching the compile above it and the engine below it. This used
        // to compile `find.trim()`, twelve lines under a comment forbidding exactly that: trimming
        // can only widen the match, so ` HANDOFF` — which the engine will never match against the
        // message `HANDOFF now` — was warned about as an echo of itself. Both mirrors had the same
        // bug, so the shared fixture agreed with itself and could not see it.
        const re = compilePattern(parse.find);
        if (re && re.test(action.message)) {
            out.push(
                problem(
                    'warns',
                    'action',
                    'action.echo',
                    "This message matches the rule's own pattern, so the rule can see what it types. "
                        + 'TermFlow ignores its own message, but a shorter pattern is safer.',
                ),
            );
        }
    }

    // --- token substitution ----------------------------------------------------------------------
    // §4.4, opt-in via `ActionStep.substitute` (plan 032 §4.2). Without this, a message naming a
    // token the pattern cannot supply reaches `subst::substitute` only at SEND time, where §4.4's
    // own table refuses the send — silently, from the rule's own log, well after the user who
    // wrote "fix $3" believed they were done. This stops it at save/enable time instead.
    //
    // `tokensUsed` is the validation-side scanner ported from `subst::tokens_used` — the SAME
    // grammar `substitute` reads, so a message this lets through cannot be one the send then
    // refuses anyway.
    // **Absent and blank are one answer here**, and it is the one §8's table already names: the
    // toggle claims the message inserts a capture, and a rule with no parse step at all captures
    // nothing, exactly like one whose pattern is still empty. `parseStep` is what makes the two
    // spellings indistinguishable to this check.
    if (action.substitute) {
        const sourcing = parseStep(rule.graph);
        if (!sourcing) {
            // The toggle itself claims the message inserts a capture, which nothing can be true of
            // before a pattern exists — asked regardless of whether a token has actually been typed
            // yet, the same way `cond.incomplete` above is asked regardless of what a clause would
            // compare against.
            out.push(
                problem(
                    'blocks',
                    'action',
                    'action.tokenWithoutParse',
                    'This message inserts captured values, but the rule has no pattern to capture them from.',
                ),
            );
        } else if (compilePattern(sourcing.find) !== null) {
            const groups = groupsOf(sourcing.find);
            for (const t of tokensUsed(action.message)) {
                const bad = t.kind === 'group'
                    ? !tokenSupplied(groups, t.n, null)
                    : !tokenSupplied(groups, null, t.name);
                if (!bad) continue;
                out.push(
                    problem(
                        'blocks',
                        'action',
                        'action.unknownToken',
                        `${t.text} has nothing to stand for. The pattern in Read a value has `
                            + `${groups.count} bracketed group${groups.count === 1 ? '' : 's'}, so the highest you can use is $${groups.count}.`,
                    ),
                );
            }
        }
    }

    // STABLE, so within each severity the problems stay in step order — targets, monitor, parse,
    // cond, timer, action — which is the order the inspector's problem list draws them in.
    return [...out.filter((p) => p.severity === 'blocks'), ...out.filter((p) => p.severity !== 'blocks')];
}

/** The problems that stop the rule running. */
export function blockingProblems(list: Problem[]): Problem[] {
    return list.filter((p) => p.severity === 'blocks');
}

/** The problems belonging to one step's panel. */
export function problemsFor(list: Problem[], field: ProblemField): Problem[] {
    return list.filter((p) => p.field === field);
}

/**
 * The short form a node's foot badge shows — *"⚠ needs a pattern"* in §07.
 *
 * Keyed on `code`, never on the message: a badge derived by slicing prose is a test that passes
 * until someone fixes a typo. A code with no entry here has no badge rather than a wrong one.
 *
 * **Exported so the shared fixture's exhaustiveness check can DERIVE its list of codes from it.**
 * `Record<ProblemCode, string>` already fails `tsc` on a missing key, so this table is the one
 * place a new code cannot be forgotten — and a hand-typed "we covered every code" array beside it
 * is a list that goes quietly stale, which is the divergence this module's header warns about.
 */
export const BADGES: Record<ProblemCode, string> = {
    'targets.empty': 'needs terminals',
    'targets.criterion': 'needs something to match',
    'monitor.interval': 'checks too often',
    'parse.empty': 'needs a pattern',
    'parse.uncompilable': 'pattern not understood',
    'parse.noBrackets': 'needs brackets',
    'parse.manyGroups': 'more than one group',
    'cond.incomplete': 'needs a comparison',
    'cond.unknownToken': 'names a value the pattern has not got',
    'cond.clauseNeedsValue': 'needs a value to compare with',
    'cond.badClausePattern': 'pattern not understood',
    'cond.clauseWithoutParse': 'needs a pattern to compare from',
    'timer.delayTooShort': 'wait is too short',
    'timer.delayTooLong': 'wait is too long',
    'timer.badMinute': 'needs a time of day',
    'timer.noDays': 'needs a day picked',
    'timer.scheduleWithMonitor': 'the watch is ignored',
    'timer.neverRuns': 'this rule can never run',
    'action.empty': 'needs a message',
    'action.echo': 'may read its own message',
    'action.tokenWithoutParse': 'needs a pattern to capture from',
    'action.unknownToken': 'names a value the pattern has not got',
};

export function badgeFor(p: Problem): string {
    return BADGES[p.code];
}
