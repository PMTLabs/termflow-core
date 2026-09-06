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
    AutomationGraph,
    AutomationRule,
} from '../../types/electron';
import { tokensUsed } from './automationTokens';

export type Severity = 'blocks' | 'warns';

/** Which step owns a problem, so the editor can point at the panel that fixes it. */
export type ProblemField = 'targets' | 'monitor' | 'parse' | 'cond' | 'action';

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
function groupsOf(find: string): { count: number; names: Set<string> } {
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
 * Everything wrong with a rule's PARSE step. Blocks first, so a caller showing one shows the one
 * that matters.
 */
export function patternProblems(graph: AutomationGraph): Problem[] {
    const out: Problem[] = [];
    const { parse, cond } = graph;

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
    const numeric = cond.kind === 'number';

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
    if (monitor.cadence === 'timer' && monitor.everyMs < MIN_TIMER_MS) {
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
    // A numeric rule with no operator or no threshold cannot be true of anything, and `evaluate`
    // reads it as unknown forever — a rule that runs, logs, and can never fire.
    if (
        cond.kind === 'number'
        && (cond.op === null || cond.op === undefined
            || cond.threshold === null || cond.threshold === undefined)
    ) {
        out.push(
            problem(
                'blocks',
                'cond',
                'cond.incomplete',
                'Choose how to compare the value, and the number to compare it with.',
            ),
        );
    }

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
    } else if (parse.find.trim().length > 0) {
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
    if (action.substitute) {
        if (!parse.find.trim()) {
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
        } else if (compilePattern(parse.find) !== null) {
            const { count, names } = groupsOf(parse.find);
            for (const t of tokensUsed(action.message)) {
                const bad = t.kind === 'group' ? t.n > count : !names.has(t.name);
                if (!bad) continue;
                out.push(
                    problem(
                        'blocks',
                        'action',
                        'action.unknownToken',
                        `${t.text} has nothing to stand for. The pattern in Read a value has `
                            + `${count} bracketed group${count === 1 ? '' : 's'}, so the highest you can use is $${count}.`,
                    ),
                );
            }
        }
    }

    // STABLE, so within each severity the problems stay in step order — targets, monitor, parse,
    // cond, action — which is the order the inspector's problem list draws them in.
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
 */
const BADGES: Record<ProblemCode, string> = {
    'targets.empty': 'needs terminals',
    'targets.criterion': 'needs something to match',
    'monitor.interval': 'checks too often',
    'parse.empty': 'needs a pattern',
    'parse.uncompilable': 'pattern not understood',
    'parse.noBrackets': 'needs brackets',
    'parse.manyGroups': 'more than one group',
    'cond.incomplete': 'needs a comparison',
    'action.empty': 'needs a message',
    'action.echo': 'may read its own message',
    'action.tokenWithoutParse': 'needs a pattern to capture from',
    'action.unknownToken': 'names a value the pattern has not got',
};

export function badgeFor(p: Problem): string {
    return BADGES[p.code];
}
