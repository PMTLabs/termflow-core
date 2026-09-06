/**
 * One clause's answer, in the editor — the **renderer half of two implementations of one
 * three-valued rule set** (plan 032 §5.5, §5.9).
 *
 * The other half is `automation_engine/eval.rs`'s `test_clause`, and the engine is the authority:
 * it owns *"does this rule fire"*. This module exists so `CondPanel` can say what each row would
 * answer **as the user types**, without a round-trip — not so it can decide anything.
 *
 * **The two are pinned to each other by one shared fixture** —
 * `__fixtures__/automationClauseCases.json`, read by `automationClauseTruth.test.ts` here and by
 * `cargo test` there. Kleene's third value, `f64` coercion and the comparison epsilon are exactly
 * the things a hand port gets subtly wrong, and the drift is silent in the worst direction: a green
 * tick beside a comparison the engine reads as `Unknown` tells a user the rule will fire when it
 * will not. That is the M2 review's I1 — two surfaces on one screen making opposite claims about
 * one rule. `two-implementations-one-fix`.
 *
 * **`Unknown` is not `false`, here as everywhere else on this surface.** A token that did not
 * participate, or one that is not a number, taught the read nothing; an OR chain may still carry
 * that row, so drawing it as a failure is a claim the engine never made.
 *
 * **The one divergence the fixture cannot close** is a `matches` clause's own operand: it is
 * compiled by V8 here and by the `regex` crate there, and the two accept different syntax. That gap
 * is not introduced by this module — `cond.badClausePattern` has it already, `compilePattern` on
 * one side and `Regex::new` on the other — and `compilePattern` is reused below precisely so this
 * module inherits that one decision rather than making a second one.
 */
import type {
    AutomationClause,
    AutomationCompareOp,
    AutomationSource,
    AutomationTest,
    AutomationTextOp,
} from '../../types/electron';
import { captureText } from './automationCaptures';
import { compilePattern } from './automationValidation';

/** `Truth` — three-valued, and the third value is never collapsed into the second. */
export type Truth = 'true' | 'false' | 'unknown';

/**
 * The captures one match produced, keyed the way `sampleFromPattern` returns them: a numbered group
 * by its number as a string (`'0'`, `'1'`, …), a named one by its name.
 *
 * **A key is present if and only if that group PARTICIPATED.** An absent key is the `None` slot in
 * Rust's `Captures`, and it is a different fact from a key holding `''` — a declared group that
 * matched nothing at all. `test_clause`'s table treats them differently on purpose (a number test
 * can be told nothing by the first and reads the second as unparseable; a text test sees `''` for
 * both, per §4.4's known-absence), so the distinction survives to here rather than being flattened.
 */
export type ClauseCaptures = Record<string, string>;

/**
 * Rust's `f64` grammar, not JavaScript's `Number`.
 *
 * `coerce` in `eval.rs` is `raw.trim().parse::<f64>().ok().filter(|v| v.is_finite())`, and a bare
 * `Number(raw.trim())` is NOT that function: it reads `''` as `0`, `'0x10'` as `16` and `'0b1'` as
 * `1`, none of which the engine will ever compare. Each of those is a row the editor would draw a
 * verdict on that the engine would answer `Unknown`.
 *
 * The shape Rust accepts is `[sign] ( digits [.] [digits] | . digits ) [exponent]`, plus the
 * `inf`/`infinity`/`nan` words — which `is_finite` then throws out, so they are simply not matched
 * here. `Number` is still what converts, because once the SHAPE is agreed the two parsers agree on
 * the value.
 */
const RUST_F64 = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** `raw` as the engine would read it, or `null` — which is *unknown*, never zero. */
export function coerceNumber(raw: string): number | null {
    const trimmed = raw.trim();
    if (!RUST_F64.test(trimmed)) return null;
    const value = Number(trimmed);
    // `1e400` parses on both sides and is infinite on both sides. `is_finite` is the filter that
    // makes them agree, so it is applied here too rather than assumed unreachable.
    return Number.isFinite(value) ? value : null;
}

const isNumTest = (
    test: AutomationTest,
): test is { number: { op: AutomationCompareOp; value: number | null } } => 'number' in test;

/**
 * The six comparators, with an epsilon on `eq`/`neq` and never `===`.
 *
 * `EPS` makes equality tolerant of small differences introduced by independent computation or
 * rounding, such as a program printing `0.30000000000000004` for a value compared with `0.3`.
 * Parsing the same decimal literal on both sides yields the same binary double. `EPS` is
 * `eval.rs`'s own constant.
 */
const EPS = 1e-9;

function compare(op: AutomationCompareOp, value: number, threshold: number): boolean {
    switch (op) {
        case 'gt': return value > threshold;
        case 'gte': return value >= threshold;
        case 'lt': return value < threshold;
        case 'lte': return value <= threshold;
        case 'eq': return Math.abs(value - threshold) < EPS;
        case 'neq': default: return Math.abs(value - threshold) >= EPS;
    }
}

const truthOf = (held: boolean): Truth => (held ? 'true' : 'false');

/**
 * The token a clause reads, or `undefined` when it did not participate.
 *
 * A group beyond the pattern's count and a group that is declared but did not participate are the
 * same answer, deliberately — `test_clause`'s own doc says §5.5's table draws no such row, and
 * telling them apart is `cond.unknownToken`'s job, not this one's.
 */
export function tokenOf(source: AutomationSource, caps: ClauseCaptures): string | undefined {
    if (source === 'whole') return captureText(caps, '0');
    if ('group' in source) return captureText(caps, String(source.group));
    return captureText(caps, source.named);
}

/** The text side of the table. Split out for the same reason `test_text` is: it shares nothing. */
function textTruth(op: AutomationTextOp, token: string, value: string): Truth {
    switch (op) {
        case 'is': return truthOf(token === value);
        case 'isNot': return truthOf(token !== value);
        case 'contains': return truthOf(token.includes(value));
        case 'notContains': return truthOf(!token.includes(value));
        case 'isEmpty': return truthOf(token.length === 0);
        case 'isNotEmpty': return truthOf(token.length > 0);
        // A pattern that will not compile teaches nothing — `unknown`, never `false` — the same
        // asymmetry a non-numeric token gets below. `compilePattern` rather than a bare `RegExp`,
        // so the `(?P<name>…)` spelling the engine runs is not refused only on this side.
        case 'matches': default: {
            const re = compilePattern(value);
            return re === null ? 'unknown' : truthOf(re.test(token));
        }
    }
}

/**
 * One clause's answer against one match's captures — `eval.rs`'s `test_clause`, case for case.
 *
 * **A number test cannot be answered from thin air.** A token that did not participate, one that is
 * not a number, and a clause with no threshold typed yet all teach the read nothing: `unknown`.
 * **A text test sees a non-participating token as `''`** — a known absence per §4.4 — so
 * `isEmpty`/`contains` and the rest get a real answer from the same slot a number test could not
 * read at all.
 */
export function clauseTruth(clause: AutomationClause, caps: ClauseCaptures): Truth {
    const token = tokenOf(clause.source, caps);
    if (isNumTest(clause.test)) {
        const { op, value } = clause.test.number;
        const read = token === undefined ? null : coerceNumber(token);
        // A clause with no threshold yet asks nothing, so it can be told nothing. It is a blocking
        // validation problem (`cond.clauseNeedsValue`), so only a hand-edited row reaches here;
        // reading it as `false` would let an unfinished comparison decide the rule.
        if (read === null || value === null) return 'unknown';
        return truthOf(compare(op, read, value));
    }
    const { op, value } = clause.test.text;
    // Dry runs evaluate drafts past save-time validation. Required text that has not been entered
    // therefore cannot answer the clause — in particular, `contains('')` must not become a match.
    // The two emptiness operators deliberately take no text operand, so they still inspect `token`.
    if (op !== 'isEmpty' && op !== 'isNotEmpty' && value.trim().length === 0) return 'unknown';
    return textTruth(op, token ?? '', value);
}
