/**
 * *Compare it* — the `finds` radio, the clause list, and the join (plan 032 §5.9, mockup §06).
 *
 * **`finds` is not "text or number".** Each clause row picks its own comparison independently; the
 * radio above the list answers a different question — is this pattern a reading that PERSISTS
 * (re-arms when the value changes) or an event that HAPPENED (re-arms when it leaves the visible
 * screen)? Plan 032 §5.2 is the authority for why the two cannot be derived from each other:
 * `API error 529 … retry in 60s` is an *event* that contains a *number*.
 *
 * **Nothing here re-derives validation.** `cond.unknownToken` / `cond.clauseNeedsValue` /
 * `cond.badClausePattern` / `cond.clauseWithoutParse` already decide whether a clause is legal —
 * `AuInspector`'s own problem list (fed by `automationValidation.problems`) surfaces them exactly
 * like every other step's problems, so this panel only needs to bind controls to `cond.clauses` and
 * ask `groupsOf` which tokens the pattern actually declares.
 *
 * The *Right now* block is the only place in the editor that draws live engine state, and it draws
 * it through `automationRowState` — the same module the list row uses — so the pill in the editor
 * and the pill in the list can never say different things about one rule.
 *
 * **The live reading (§5.9's own two bullets, task 28).** Every token option carries the value it
 * holds, and every row says what its token holds and whether that row passes — otherwise a user
 * picks `$2` blind and reads an AND / OR chain abstractly, which is the failure §1.1 names. Both
 * halves read ONE sampler, `ActionPanel`'s `sampleFromPattern`, so *Compare it* and *Send to
 * terminal* cannot disagree about what a match looks like; and the verdict comes from
 * `automationClauseTruth`, which is pinned case for case to the engine's own `test_clause` by a
 * shared fixture both jest and `cargo test` read. Two surfaces describing one rule is the defect
 * this milestone kept having to repair, and the fixture is the only thing that makes a second
 * implementation of Kleene logic survivable.
 */
import React from 'react';
import type {
    AutomationClause,
    AutomationCompareOp,
    AutomationFinds,
    AutomationSource,
    AutomationTest,
    AutomationTextOp,
} from '../../../types/electron';
import type { AutomationRuntimePairState } from '../../../services/automationEvents';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import type { PanelModel } from '../automationDerive';
import { NUM_OP_LABELS, TEXT_OP_LABELS, condSentence } from '../automationDerive';
import { compilePattern, groupsOf, sourceText } from '../automationValidation';
import { clauseTruth, tokenOf } from '../automationClauseTruth';
import type { ClauseCaptures, Truth } from '../automationClauseTruth';
import { automationRowState, describeLastFired } from '../../Settings/Automations/automationState';
import { AuField, AuHelp, AuRadio } from './AuFields';
import { sampleFromPattern } from './ActionPanel';

export interface CondPanelProps {
    draft: AutomationDraft;
    model: PanelModel;
    pairs?: Record<string, AutomationRuntimePairState>;
    now: number;
    /** `null` while the rule has never been saved — there is nothing for the engine to re-arm. */
    onRearm: (() => void) | null;
    dispatch: (action: DraftAction) => void;
}

const TEXT_OPS: AutomationTextOp[] = [
    'is',
    'isNot',
    'contains',
    'notContains',
    'matches',
    'isEmpty',
    'isNotEmpty',
];
const NUM_OPS: AutomationCompareOp[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];

/** The two text operators that take no operand at all. */
const NO_VALUE_OPS = new Set<AutomationTextOp>(['isEmpty', 'isNotEmpty']);

const isNumTest = (
    test: AutomationTest,
): test is { number: { op: AutomationCompareOp; value: number | null } } => 'number' in test;

/** The `<select>` value for a source — a stable string key, not the source object itself. */
function sourceKey(source: AutomationSource): string {
    if (source === 'whole') return 'whole';
    if ('group' in source) return `group:${source.group}`;
    return `named:${source.named}`;
}

function sourceFromKey(key: string): AutomationSource {
    if (key === 'whole') return 'whole';
    if (key.startsWith('group:')) return { group: Number(key.slice('group:'.length)) };
    return { named: key.slice('named:'.length) };
}

/**
 * A token's label: the spelling, and **the value it holds in the live preview** (§5.9), so `$2` is
 * never picked blind.
 *
 * `held === undefined` covers both "there is no reading at all" and "this group did not
 * participate", and neither may be drawn as a value — `fallback` is `$0`'s own explanatory words,
 * which are worth keeping only while there is no actual whole match to show instead.
 */
function optionLabel(base: string, held: string | undefined, fallback?: string): string {
    if (held !== undefined) return `${base} — "${held}"`;
    return fallback === undefined ? base : `${base} — ${fallback}`;
}

/**
 * Only the tokens the pattern actually PRODUCES (§5.9) — `$0`, its numbered groups and its NAMED
 * ones, never a free-text field a user could point at a group the pattern does not have. Bound to
 * `groupsOf` rather than re-deriving the group count.
 *
 * **The named groups are offered because `Source::Named` is otherwise unauthorable.** It is
 * modelled, validated (`cond.unknownToken` has a `${bogus}` fixture case), and PRODUCED by the v1
 * fold for a `(?<value>…)` pattern — so a clause could arrive holding one, round-trip through the
 * fallback `<option>` below, and never be creatable. A named group also occupies a numbered slot,
 * so both spellings appear: they are two names for one capture, and `${name}` is the one that
 * survives an edit to the pattern that renumbers the brackets.
 *
 * `caps` is `sampleFromPattern`'s reading, and `null` is a real answer from it — no worked example
 * to run, so nothing to show. The labels then say only what they always said.
 */
function tokenOptions(find: string, caps: ClauseCaptures | null): Array<{ key: string; label: string }> {
    const held = (k: string) => (caps === null ? undefined : caps[k]);
    const out: Array<{ key: string; label: string }> = [
        { key: 'whole', label: optionLabel('$0', held('0'), 'the whole match') },
    ];
    if (compilePattern(find) === null) return out;
    const { count, names } = groupsOf(find);
    for (let i = 1; i <= count; i += 1) {
        out.push({ key: `group:${i}`, label: optionLabel(`$${i}`, held(String(i))) });
    }
    // After the numbered ones, in the pattern's own declaration order — `groupsOf` reads them off
    // `exec('').groups`, which JavaScript builds left to right.
    for (const name of names) {
        out.push({ key: `named:${name}`, label: optionLabel(`\${${name}}`, held(name)) });
    }
    return out;
}

/**
 * How one row's answer is drawn. **Three treatments, because `Truth` has three values.**
 *
 * Rendering `unknown` as the failing treatment is the mistake this table exists to make hard: a row
 * the read could not answer is not a row that failed, an OR chain may still carry it, and a red ✕
 * beside it tells the user the rule will not fire when it may well. The marks are `AuTestPane`'s
 * own (`✓` / `✕` / `?`), so a verdict here and a verdict in the dry run read alike.
 */
const VERDICT: Record<Truth, { cls: string; mark: string; word: string; why: string }> = {
    true: {
        cls: 'pass',
        mark: '✓',
        word: 'passes',
        why: 'This comparison holds for the example above.',
    },
    false: {
        cls: 'fail',
        mark: '✕',
        word: 'fails',
        why: 'This comparison does not hold for the example above.',
    },
    unknown: {
        cls: 'unknown',
        mark: '?',
        word: 'unknown',
        why: 'This comparison could not be answered — the token is missing, is not a number, or '
            + 'the clause is unfinished. It does not count as a failure: with OR, another row can '
            + 'still carry the rule.',
    },
};

/** The operator select's value — `kind:op`, so one list can hold both groups. */
const opKeyOf = (test: AutomationTest): string =>
    isNumTest(test) ? `number:${test.number.op}` : `text:${test.text.op}`;

function needsValue(test: AutomationTest): boolean {
    return isNumTest(test) ? true : !NO_VALUE_OPS.has(test.text.op);
}

function valueOf(test: AutomationTest): string {
    if (!isNumTest(test)) return test.text.value;
    return test.number.value === null ? '' : String(test.number.value);
}

/**
 * Applying a NEW operator to a clause. **Switching between text and number CLEARS the operand** —
 * otherwise `"529"` silently becomes a numeric threshold, which is the one behaviour this task's
 * own brief names as the easiest thing to get wrong here. The operator IS the type: there is no
 * separate type control that could disagree with it.
 */
function withOp(test: AutomationTest, key: string): AutomationTest {
    const sep = key.indexOf(':');
    const kindKey = key.slice(0, sep);
    const op = key.slice(sep + 1);
    const wasNum = isNumTest(test);
    if (kindKey === 'number') {
        return {
            number: {
                op: op as AutomationCompareOp,
                // Same-kind (number -> a different number op): keep the value. Cross-kind
                // (text -> number): `null`, "nothing entered yet" — never the old text coerced
                // into a number, and never `NaN`, which has no JSON spelling: `invoke` turns it
                // into `null` on the wire, so the value that actually reached the backend was one
                // the DTO had no field type for and the whole save was refused. `null` is what the
                // wire carries and what `cond.clauseNeedsValue` blocks on, on both sides.
                value: wasNum ? test.number.value : null,
            },
        };
    }
    return {
        text: {
            op: op as AutomationTextOp,
            value: wasNum ? '' : test.text.value,
        },
    };
}

function withValue(test: AutomationTest, raw: string): AutomationTest {
    if (isNumTest(test)) {
        const trimmed = raw.trim();
        // Empty, or something that is not a number at all (`12a`): `null`, for the reason `withOp`
        // gives above. `Number('12a')` is `NaN`, which the wire cannot carry.
        const parsed = trimmed.length === 0 ? null : Number(trimmed);
        return {
            number: { ...test.number, value: parsed === null || !Number.isFinite(parsed) ? null : parsed },
        };
    }
    return { text: { ...test.text, value: raw } };
}

const DEFAULT_CLAUSE: AutomationClause = { source: 'whole', test: { text: { op: 'contains', value: '' } } };

// `model` is not read here: every problem this panel would otherwise announce (`cond.unknownToken`,
// `cond.clauseNeedsValue`, `cond.badClausePattern`, `cond.clauseWithoutParse`) already surfaces
// through `AuInspector`'s own generic problem list, fed by `model.problems` one level up — this
// panel binds its controls straight to `groupsOf` and `cond.clauses` rather than re-deriving any
// of it. Kept in `CondPanelProps` anyway, so every panel `AuInspector` mounts takes the same shape.
export const CondPanel: React.FC<CondPanelProps> = ({
    draft,
    pairs,
    now,
    onRearm,
    dispatch,
}) => {
    const { cond, parse } = draft.rule.graph;
    const clauses = cond?.clauses ?? [];
    /**
     * The live preview every row below reads — the SAME sampler *Send to terminal* previews its
     * message with, never a second one, so the two panels cannot disagree about what a match here
     * looks like.
     *
     * **`null` is a real answer and is not `{}`.** It means there is nothing to read at all: the
     * pattern will not compile, or it compiles and `sayPattern`'s vocabulary has no worked example
     * for it (`\S` is not on that list). Every consumer below treats `null` as *no verdict*, never
     * as an empty capture set — collapsing the two is the M1 review's Important 1, and here it
     * would put a confident ✕ on every row of a rule nobody has been able to read yet.
     */
    const caps = parse ? sampleFromPattern(parse.find, parse.keep) : null;
    // The token dropdown offers the PATTERN's groups; a rule with no parse step offers none.
    const tokens = tokenOptions(parse?.find ?? '', caps);
    const live = pairs && Object.keys(pairs).length > 0 ? automationRowState(draft.rule, pairs, now) : null;
    const lastFired = pairs
        ? Object.values(pairs).reduce<number | null>(
            (best, p) => (p.lastFiredAt !== null && (best === null || p.lastFiredAt > best) ? p.lastFiredAt : best),
            null,
        )
        : null;

    // Every control below is bound to the cond step, so there is nothing to draw without one.
    // A rule with no condition (plan 032 §3.1's schedule rule) should not reach this panel at all;
    // which step cards are drawn is tasks 23-25's decision, and this is only the guard. No hooks
    // run above this line, so the early return cannot change hook order.
    if (!cond) return null;

    const setClauses = (next: AutomationClause[]) => dispatch({ type: 'clauses', clauses: next });
    const updateClause = (i: number, patch: Partial<AutomationClause>) =>
        setClauses(clauses.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

    return (
        <>
            <AuField label="What this pattern finds">
                <AuRadio
                    name="au-condfinds"
                    on={cond.kind === 'number'}
                    title="A reading that stays true"
                    sub="A number that is still current even when nothing reprints it. Re-arms when the printed value changes."
                    onPick={() =>
                        dispatch({ type: 'cond', patch: { kind: 'number' as AutomationFinds } })}
                />
                <AuRadio
                    name="au-condfinds"
                    on={cond.kind === 'text'}
                    title="Something that happened"
                    sub="An event. Re-arms when it leaves the visible screen — not when it scrolls out of 200 lines."
                    onPick={() =>
                        dispatch({ type: 'cond', patch: { kind: 'text' as AutomationFinds } })}
                />
                <AuHelp>
                    This is not the same question as &ldquo;text or number&rdquo;. It chooses{' '}
                    <b>how far back the rule reads</b>, and each row below picks its own comparison
                    independently.
                </AuHelp>
            </AuField>

            <AuField label="Comparisons">
                <div className="au-clauses">
                    {clauses.map((clause, i) => {
                        const valueNeeded = needsValue(clause.test);
                        const held = caps === null ? undefined : tokenOf(clause.source, caps);
                        const verdict = caps === null ? null : VERDICT[clauseTruth(clause, caps)];
                        return (
                            // eslint-disable-next-line react/no-array-index-key
                            <div className="au-clause" key={i}>
                                <div className="au-crow">
                                    <select
                                        className="au-finput"
                                        aria-label="Which captured value"
                                        value={sourceKey(clause.source)}
                                        onChange={(e) =>
                                            updateClause(i, { source: sourceFromKey(e.target.value) })}
                                    >
                                        {tokens.map((t) => (
                                            <option key={t.key} value={t.key}>
                                                {t.label}
                                            </option>
                                        ))}
                                        {/* A clause can carry a token the pattern no longer produces — a
                                            group removed after the clause was written. It stays selected
                                            (never silently swapped for `$0`) so the pattern-vs-clause
                                            mismatch is what `cond.unknownToken` reports, not something
                                            this dropdown quietly hid. */}
                                        {!tokens.some((t) => t.key === sourceKey(clause.source)) && (
                                            <option value={sourceKey(clause.source)}>
                                                {sourceText(clause.source)}
                                            </option>
                                        )}
                                    </select>
                                    <select
                                        className="au-finput"
                                        aria-label="How to compare"
                                        value={opKeyOf(clause.test)}
                                        onChange={(e) =>
                                            updateClause(i, { test: withOp(clause.test, e.target.value) })}
                                    >
                                        <optgroup label="Text">
                                            {TEXT_OPS.map((op) => (
                                                <option key={op} value={`text:${op}`}>
                                                    {TEXT_OP_LABELS[op]}
                                                </option>
                                            ))}
                                        </optgroup>
                                        <optgroup label="Number">
                                            {NUM_OPS.map((op) => (
                                                <option key={op} value={`number:${op}`}>
                                                    {NUM_OP_LABELS[op]}
                                                </option>
                                            ))}
                                        </optgroup>
                                    </select>
                                    {valueNeeded ? (
                                        <input
                                            className="au-finput"
                                            aria-label="Compare against"
                                            placeholder={isNumTest(clause.test) ? 'number' : 'text'}
                                            inputMode={isNumTest(clause.test) ? 'decimal' : undefined}
                                            value={valueOf(clause.test)}
                                            onChange={(e) =>
                                                updateClause(i, { test: withValue(clause.test, e.target.value) })}
                                        />
                                    ) : (
                                        <span className="au-novalue">no value needed</span>
                                    )}
                                    <button
                                        type="button"
                                        className="au-crow-del"
                                        aria-label={`Remove comparison ${i + 1}`}
                                        onClick={() => setClauses(clauses.filter((_, idx) => idx !== i))}
                                    >
                                        ✕
                                    </button>
                                </div>
                                {/* §5.9's second bullet — what this token holds now, and whether this
                                    row passes, so AND / OR is concrete rather than abstract.

                                    Drawn only when there is a reading to judge against: with
                                    `caps === null` the row shows nothing rather than a default, because
                                    a wrong verdict is worse than no verdict. `held === undefined` is the
                                    token that did not participate — said as an absence, never as an
                                    empty value, since that absence is the whole reason a number test
                                    above it reads `unknown`. */}
                                {verdict !== null && (
                                    <div className="au-cread">
                                        <span className="au-cheld">
                                            {held === undefined
                                                ? `${sourceText(clause.source)} did not match`
                                                : `${sourceText(clause.source)} holds "${held}"`}
                                        </span>
                                        <span className={`au-cv ${verdict.cls}`} title={verdict.why}>
                                            <span aria-hidden="true">{verdict.mark}</span>
                                            {verdict.word}
                                        </span>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                <button
                    type="button"
                    className="au-btn sm"
                    style={{ marginTop: 9 }}
                    onClick={() => setClauses([...clauses, DEFAULT_CLAUSE])}
                >
                    + Add a comparison
                </button>
                {clauses.length === 0 && (
                    <AuHelp>
                        {/* `condSentence` covers BOTH readings of "no clauses": a plain
                            word-matching rule (fires whenever the pattern matches, exactly what one
                            does today), and a v1 rule that predates the clause list and still has
                            its own number comparison to show — the same fallback the node face
                            reads, so the two never disagree about what an empty list means here. */}
                        No comparisons — this rule fires when {condSentence(cond)}.
                    </AuHelp>
                )}
            </AuField>

            {/* A join over ONE row is meaningless — hidden until there is something to combine. */}
            {clauses.length >= 2 && (
                <AuField label="How they combine">
                    <div className="au-seg" role="group" aria-label="How the comparisons combine">
                        <button
                            type="button"
                            className={cond.join !== 'or' ? 'on' : undefined}
                            onClick={() => dispatch({ type: 'cond', patch: { join: 'and' } })}
                        >
                            AND
                        </button>
                        <button
                            type="button"
                            className={cond.join === 'or' ? 'on' : undefined}
                            onClick={() => dispatch({ type: 'cond', patch: { join: 'or' } })}
                        >
                            OR
                        </button>
                    </div>
                    <AuHelp>
                        {cond.join === 'or'
                            ? (
                                <>
                                    <b>OR</b> — any one passing is enough. All failing stops it; none
                                    passing but one unknown holds it.
                                </>
                            )
                            : (
                                <>
                                    <b>AND</b> — every comparison must pass. One that fails stops the
                                    rule; one that is unknown holds it.
                                </>
                            )}
                    </AuHelp>
                    <div className="au-plainsay">
                        Fires when <b>{condSentence(cond)}</b>.
                    </div>
                </AuField>
            )}

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

            {/*
              * An empty pair map has TWO causes and they need different sentences. The rule may
              * never have been saved or switched on — the case this help text was written for. Or
              * it may be running and simply have no pair state yet, which is what a save does on
              * purpose: a save moves `updated_at`, `reload` drops the rule's arm keys (Q11), and the
              * map is empty until the next check. Telling a user with a green toggle that their rule
              * "is not running" and to "switch it on" is wrong twice, and invites them to toggle a
              * rule that is already working.
              */}
            {!live && (
                <AuHelp>
                    {draft.rule.enabled
                        ? 'This rule is running and has not reported on any terminal yet — a save '
                          + 'clears its armed-or-fired state, so this fills in at the next check.'
                        : 'This rule is not running, so there is no armed-or-fired state to show '
                          + 'yet. Save it and switch it on, and this is where it reports what it is '
                          + 'waiting for.'}
                </AuHelp>
            )}
        </>
    );
};
