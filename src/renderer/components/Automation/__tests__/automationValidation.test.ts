/**
 * §10.19 and §10.19b — validation, and the shared fixture that pins it to the Rust mirror.
 *
 * The fixture half is the one that matters: `automation_validation.rs` reads the same JSON and
 * asserts the same list, so a rule edited on one side and not the other goes red on the other. Two
 * implementations of one rule set diverge the first time only one of them is edited, and the
 * divergence is silent in the worst direction — the editor allowing a rule the backend refuses,
 * which the user meets as a save that reported success and a rule that never runs.
 *
 * This file also asserts the PROSE, which the fixture deliberately does not: it compares `code`,
 * because one case quotes the regex engine's own error text and the two engines word that
 * differently. The words are what the user actually reads, so they are pinned here.
 */
import fixture from '../__fixtures__/automationValidationCases.json';
import type { AutomationClause, AutomationRule } from '../../../types/electron';
import {
    BADGES,
    MAX_DELAY_MS,
    MIN_DELAY_MS,
    MINUTES_PER_DAY,
    MIN_TIMER_MS,
    badgeFor,
    blockingProblems,
    patternProblems,
    problems,
} from '../automationValidation';
import type { Problem, ProblemCode } from '../automationValidation';
import { AUTOMATION_TEMPLATES, draftFromTemplate } from '../../Settings/Automations/automationTemplates';

interface FixtureCase {
    name: string;
    rule: AutomationRule;
    expected: Array<{ severity: string; field: string; code: string }>;
}

const cases = (fixture as unknown as { cases: FixtureCase[] }).cases;

const keysOf = (list: Problem[]) => list.map((p) => [p.severity, p.field, p.code]);

describe('automationValidation — the shared fixture', () => {
    it('has not shrunk to nothing', () => {
        // A fixture with no cases passes every comparison by having nothing to compare. The Rust
        // side asserts the same floor.
        expect(cases.length).toBeGreaterThanOrEqual(20);
    });

    it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
        expect(keysOf(problems(testCase.rule))).toEqual(
            testCase.expected.map((e) => [e.severity, e.field, e.code]),
        );
    });

    it('covers every rule this module can report', () => {
        // Otherwise the two implementations are pinned to each other only on the paths someone
        // remembered — and the ones nobody remembered are exactly where they drift.
        //
        // **DERIVED from `BADGES`, never hand-typed.** This was a literal array of twenty codes,
        // which meant a twenty-first `ProblemCode` added to both implementations with no fixture
        // case left this test green — a "we covered every code" list that covers whatever someone
        // remembered to add to it is the exact silent divergence the module header warns about.
        // `BADGES` is `Record<ProblemCode, string>` and already fails `tsc` on a missing key, so it
        // is the one table a new code cannot slip past.
        const covered = new Set(cases.flatMap((c) => c.expected.map((e) => e.code)));
        const all = Object.keys(BADGES) as ProblemCode[];
        // **Exact, not a floor** (M8 review). `toBeGreaterThanOrEqual` stopped pinning anything the
        // moment the count first passed 20: a 22nd code with no fixture case would still satisfy
        // "at least 20" and this test would stay green. `all.length` is DERIVED from `BADGES`
        // (never hand-typed), so bumping this number is the one place a new code cannot be added
        // silently — it forces a look at whether the fixture actually covers it.
        expect(all.length).toBe(29);
        expect(all.filter((code) => !covered.has(code))).toEqual([]);
    });
});

describe('automationValidation — the words the user reads', () => {
    const find = (rule: AutomationRule, code: ProblemCode) =>
        problems(rule).find((p) => p.code === code);

    const base = (): AutomationRule => cases[0].rule;

    it('names the fix, not the failure', () => {
        const noTerminals: AutomationRule = { ...base(), targetMode: 'pinned', targetIds: [] };
        expect(find(noTerminals, 'targets.empty')?.message).toBe(
            'Pick at least one terminal for this rule to watch.',
        );

        const noExclusionValue: AutomationRule = {
            ...base(),
            targetMode: 'rule',
            criterion: 'allTerminals',
            criterionValue: '',
            excludeCriterion: 'commandContains',
            excludeCriterionValue: '   ',
        };
        expect(find(noExclusionValue, 'targets.excludeValueEmpty')?.message).toBe(
            'Fill in what the exclusion must match, or exclude all terminals instead.',
        );

        const noPattern: AutomationRule = {
            ...base(),
            graph: { ...base().graph, parse: { ...base().graph.parse, find: '' } },
        };
        expect(find(noPattern, 'parse.empty')?.message).toBe('Enter something to look for.');

        const noMessage: AutomationRule = {
            ...base(),
            graph: { ...base().graph, action: { ...base().graph.action, message: '' } },
        };
        expect(find(noMessage, 'action.empty')?.message).toBe(
            'Enter the message this rule should type.',
        );
    });

    /**
     * **A message must name a control that is on screen.** This one said *"Choose how to compare
     * the value, and the number to compare it with"* — the `<select>` and `<input>` pair that was
     * deleted when the condition became a clause list (§5.9). Choosing *A reading that stays true*
     * on a rule with no clauses reached it immediately, and the editor blocked with instructions
     * for two controls that no longer exist.
     *
     * `Add a comparison` is the button that is actually there, spelled exactly as the button
     * spells it. `automation_validation.rs` asserts the same sentence, character for character.
     */
    it('names a control that is on screen', () => {
        const reading: AutomationRule = {
            ...base(),
            graph: {
                ...base().graph,
                cond: { kind: 'number', op: null, threshold: null, clauses: [] },
            },
        };
        expect(find(reading, 'cond.incomplete')?.message).toBe(
            'Add a comparison — this rule reads a value but has nothing to compare it with.',
        );
    });

    /**
     * **The message names both ways out, and names the card, not the field.**
     *
     * `Watch output` is what the palette item and the node face are labelled — the same reason
     * `cond.incomplete` says *Add a comparison* rather than naming `cond`. And both remedies are
     * offered because either is right depending on what the user meant: a rule that should watch
     * has no business carrying a schedule, and a rule that should fire on the clock has no business
     * carrying a monitor it will silently ignore.
     *
     * `automation_validation.rs` asserts this sentence character for character — the shared fixture
     * compares `code`, so prose is pinned once per implementation.
     */
    it('names the workable Wait mode switch for a schedule that would silence the monitor', () => {
        const both: AutomationRule = {
            ...base(),
            graph: {
                ...base().graph,
                monitor: { read: 'newOutput', cadence: 'onOutput', everyMs: 30_000 },
                timer: { mode: { dailyAt: { minuteOfDay: 540, days: 0b0001_1111 } } },
            },
        };
        expect(find(both, 'timer.scheduleWithMonitor')?.message).toBe(
            'A schedule fires on the clock, so this rule will not read its terminals. '
            + 'Switch the Wait step back to after a match.',
        );

        // And the complement, which is the half that makes this a rule about `DailyAt` and not
        // about timers: a DELAY on a watching rule is exactly what a delay is for.
        const delayed: AutomationRule = {
            ...base(),
            graph: {
                ...base().graph,
                monitor: { read: 'newOutput', cadence: 'onOutput', everyMs: 30_000 },
                timer: { mode: { afterMatch: { delayMs: 30_000 } } },
            },
        };
        expect(find(delayed, 'timer.scheduleWithMonitor')).toBeUndefined();
    });

    /**
     * **I2 — the skip is of the whole read chain, not the monitor.** §6.3's walk skips
     * `host.tail` for the WHOLE rule, so `parse` and/or `cond` without a `monitor` are silently
     * ignored by a `dailyAt` rule exactly as a monitor would be. The old predicate
     * (`Boolean(graph.monitor)` alone) let a `parse` + `dailyAt` graph with no monitor through
     * `reload` to run on the clock and silently never read its pattern.
     */
    it('widens to any read step, not only the monitor', () => {
        const daily = { dailyAt: { minuteOfDay: 540, days: 0b0001_1111 } };

        const parseAlone: AutomationRule = {
            ...base(),
            graph: { ...base().graph, monitor: undefined, cond: undefined, timer: { mode: daily } },
        };
        expect(find(parseAlone, 'timer.scheduleWithMonitor')).toBeDefined();

        const condAlone: AutomationRule = {
            ...base(),
            graph: { ...base().graph, monitor: undefined, parse: undefined, timer: { mode: daily } },
        };
        expect(find(condAlone, 'timer.scheduleWithMonitor')).toBeDefined();

        // The paired negative: none of the three present has nothing left to silence.
        const noneLeft: AutomationRule = {
            ...base(),
            graph: {
                ...base().graph,
                monitor: undefined,
                parse: undefined,
                cond: undefined,
                timer: { mode: daily },
            },
        };
        expect(find(noneLeft, 'timer.scheduleWithMonitor')).toBeUndefined();
    });

    // =============================================================================================
    // R7 — a rule needs input steps XOR a schedule; anything else can never run
    // =============================================================================================

    /**
     * **The oracle shape.** `blank → addStep 'timer' → addStep 'action' → type a message`: a Wait
     * step and an action, nothing that could ever cross the wait. Exactly one blocking problem —
     * not zero (this rule used to be admitted all the way to `reload`, which skipped it silently)
     * and not more than one (the default delay must not also trip a bound check).
     */
    it('a Wait with nothing to cross it blocks with exactly one problem', () => {
        const rule: AutomationRule = {
            ...base(),
            graph: {
                monitor: undefined,
                parse: undefined,
                cond: undefined,
                timer: { mode: { afterMatch: { delayMs: 30_000 } } },
                action: { message: 'resume', sendTo: 'matched', submit: true, cliType: 'default' },
            },
        };
        const found = problems(rule);
        expect(found.map((p) => p.code)).toEqual(['timer.neverRuns']);
        expect(found[0].field).toBe('timer');
        expect(found[0].message).toContain('Add one, or switch this Wait to run at a time of day');
    });

    /**
     * **The wider shape (I2/R7 together): no timer at all, and no input steps either.** Reachable
     * through the API even though the editor cannot express "no steps, no timer, just a message" —
     * §3.1 makes all four independently optional. The message must not tell the user to "switch" a
     * Wait step that does not exist (C1's own mistake).
     */
    it('a bare graph with no timer and no input steps also blocks, naming only controls that exist', () => {
        const rule: AutomationRule = {
            ...base(),
            graph: {
                monitor: undefined,
                parse: undefined,
                cond: undefined,
                timer: undefined,
                action: { message: 'resume', sendTo: 'matched', submit: true, cliType: 'default' },
            },
        };
        const neverRuns = find(rule, 'timer.neverRuns');
        expect(neverRuns).toBeDefined();
        expect(neverRuns?.message.toLowerCase()).not.toContain('switch');
        expect(neverRuns?.message).toContain('Add a Watch output step');
    });

    /** The paired negatives: a genuine schedule rule and an ordinary rule both run. */
    it('a schedule or a complete set of input steps never trips never-runs', () => {
        const scheduled: AutomationRule = {
            ...base(),
            graph: {
                monitor: undefined,
                parse: undefined,
                cond: undefined,
                timer: { mode: { dailyAt: { minuteOfDay: 540, days: 0b0001_1111 } } },
                action: base().graph.action,
            },
        };
        expect(find(scheduled, 'timer.neverRuns')).toBeUndefined();

        const ordinary: AutomationRule = { ...base(), graph: { ...base().graph, timer: undefined } };
        expect(find(ordinary, 'timer.neverRuns')).toBeUndefined();
    });

    /**
     * **R7 and I2 are the two halves of one invariant, and a single graph must never trip both**
     * with contradictory advice. They are mutually exclusive by construction: `neverRunsProblem`
     * only fires when the rule is NOT scheduled, and `timer.scheduleWithMonitor` only fires when it
     * IS.
     */
    it('never-runs and schedule-with-monitor are mutually exclusive', () => {
        const timers = [
            undefined,
            { mode: { afterMatch: { delayMs: 30_000 } } },
            { mode: { dailyAt: { minuteOfDay: 540, days: 0b0001_1111 } } },
        ];
        const combos: Array<[boolean, boolean, boolean]> = [
            [true, true, true],
            [true, false, false],
            [false, true, false],
            [false, false, true],
            [false, false, false],
        ];
        for (const timer of timers) {
            for (const [hasMonitor, hasParse, hasCond] of combos) {
                const rule: AutomationRule = {
                    ...base(),
                    graph: {
                        ...base().graph,
                        monitor: hasMonitor ? base().graph.monitor : undefined,
                        parse: hasParse ? base().graph.parse : undefined,
                        cond: hasCond ? base().graph.cond : undefined,
                        timer,
                    },
                };
                const codes = problems(rule).map((p) => p.code);
                expect(codes.includes('timer.neverRuns') && codes.includes('timer.scheduleWithMonitor'))
                    .toBe(false);
            }
        }
    });

    it('quotes the floor in the interval message, rather than restating it', () => {
        const fast: AutomationRule = {
            ...base(),
            graph: { ...base().graph, monitor: { read: 'newOutput', cadence: 'timer', everyMs: 1 } },
        };
        expect(find(fast, 'monitor.interval')?.message).toBe(
            `Check no more often than every ${MIN_TIMER_MS} ms.`,
        );
    });

    /**
     * **Both delay bounds quote their own constant.** `timer.delayTooShort` restated its floor as
     * the literal words *"at least 1 second"* while `MIN_DELAY_MS` sat a few lines above it — a
     * sentence that goes false the day the floor moves, and says nothing when it does.
     *
     * The cap's words are pinned too, because they are the half that was WRONG: they blamed the
     * echo needle, whose life starts when the write LANDS and which therefore no wait length can
     * outlive. `automation_validation.rs` asserts the same two sentences, built the same way.
     */
    it('quotes both delay bounds from their constants, rather than restating them', () => {
        const withDelay = (delayMs: number): AutomationRule => ({
            ...base(),
            graph: { ...base().graph, timer: { mode: { afterMatch: { delayMs } } } },
        });
        expect(find(withDelay(MIN_DELAY_MS - 1), 'timer.delayTooShort')?.message).toBe(
            `Wait at least ${MIN_DELAY_MS / 1_000} second before sending.`,
        );
        expect(find(withDelay(MAX_DELAY_MS), 'timer.delayTooLong')?.message).toBe(
            `Wait less than ${MAX_DELAY_MS / 60_000} minutes — a waiting message is held in memory and is lost if TermFlow quits.`,
        );
    });

    /**
     * **`timer.badMinute` quotes the bound rather than restating it**, for the same reason both
     * delay bounds do: *"between 00:00 and 23:59"* typed out is a sentence that goes false the day
     * `MINUTES_PER_DAY` moves and says nothing when it does. The floor stays literal because zero is
     * what a minute-of-day counts from; there is no constant behind it to drift.
     *
     * `automation_validation.rs` asserts this same sentence, built the same way — the shared fixture
     * compares `code`, so the words are pinned once per implementation.
     */
    it('quotes the last minute of the day from its constant, rather than restating it', () => {
        const at = (minuteOfDay: number): AutomationRule => ({
            ...base(),
            graph: { ...base().graph, timer: { mode: { dailyAt: { minuteOfDay, days: 0b0001_1111 } } } },
        });
        const last = MINUTES_PER_DAY - 1;
        const want = `Pick a time between 00:00 and ${String(Math.floor(last / 60)).padStart(2, '0')}:${String(last % 60).padStart(2, '0')}.`;
        expect(want).toBe('Pick a time between 00:00 and 23:59.');

        expect(find(at(MINUTES_PER_DAY), 'timer.badMinute')?.message).toBe(want);
        expect(find(at(-1), 'timer.badMinute')?.message).toBe(want);
        // And the legal ends of the range report nothing at all.
        expect(find(at(0), 'timer.badMinute')).toBeUndefined();
        expect(find(at(last), 'timer.badMinute')).toBeUndefined();
    });

    it('reports the browser regex error, not a generic one', () => {
        const broken: AutomationRule = {
            ...base(),
            graph: { ...base().graph, parse: { ...base().graph.parse, find: 'ctx:(\\d+%' } },
        };
        const problem = find(broken, 'parse.uncompilable');
        expect(problem?.message.startsWith('That pattern could not be understood: ')).toBe(true);
        // The engine's own words, so a user searching for them finds an answer. A fixed string here
        // would pass whatever the browser said, including nothing.
        expect(problem?.message.length).toBeGreaterThan('That pattern could not be understood: '.length);
    });

    it('gives every code a badge, and the badge is not the message', () => {
        // §07's node foot is a SHORT form. Deriving it by slicing prose is a test that passes until
        // someone fixes a typo, so it is keyed on the code.
        for (const testCase of cases) {
            for (const problem of problems(testCase.rule)) {
                expect(badgeFor(problem)).toBeTruthy();
                expect(badgeFor(problem)).not.toBe(problem.message);
            }
        }
    });
});

describe('automationValidation — the six templates', () => {
    // §10.19 said "all six report EXACTLY ONE problem (target) before terminals are picked, and zero
    // after", and so did the gallery's own note and `automationTemplates.ts`. **All three were wrong,
    // and this test is what made the claim testable.** Every template targets by CRITERION, which is
    // a complete choice — mockup §04's first panel draws exactly that for the context reminder — and
    // only a PINNED rule can be empty in a way validation can see. None of the six are pinned.
    //
    // The safety property is `enabled: false`, asserted below. That is the one that matters: nothing
    // a template does can happen without one deliberate act.
    it.each(AUTOMATION_TEMPLATES.map((t) => [t.title, t] as const))(
        '%s is valid and enableable as it ships',
        (_title, template) => {
            expect(problems(draftFromTemplate(template))).toEqual([]);
        },
    );

    it.each(AUTOMATION_TEMPLATES.map((t) => [t.title, t] as const))(
        '%s arrives switched off, with nothing pinned',
        (_title, template) => {
            const draft = draftFromTemplate(template);
            expect(draft.enabled).toBe(false);
            expect(draft.targetIds).toEqual([]);
            expect(draft.id).toBe('');
        },
    );

    it('but a template SWITCHED to pinned then has the one problem, and says which', () => {
        // The paired positive for the two above: without it they pass on a `problems` that returns
        // an empty list for everything.
        for (const template of AUTOMATION_TEMPLATES) {
            const pinned = { ...draftFromTemplate(template), targetMode: 'pinned' as const };
            expect(problems(pinned).map((p) => p.code)).toEqual(['targets.empty']);
        }
    });
});

describe('automationValidation — the scoped-default lesson', () => {
    const textRule = (keep: 'brackets' | 'whole'): AutomationRule => ({
        ...cases[0].rule,
        graph: {
            ...cases[0].rule.graph,
            parse: { preset: 'custom', literal: null, find: 'FAILED \\d+ test', keep },
            cond: { kind: 'text', op: null, threshold: null },
        },
    });

    it('never judges a text rule on `keep`, which it does not read', () => {
        // R8's own canonical rule. Blocking on `keep` made the entire word-matching half of the
        // feature un-enableable while every test stayed green, because no test ran the rule against
        // a text condition at all.
        expect(patternProblems(textRule('brackets').graph)).toEqual([]);
        expect(patternProblems(textRule('whole').graph)).toEqual([]);
    });

    it('still judges a numeric rule on the same field', () => {
        // The paired positive. Without it the assertion above passes on a `patternProblems` that
        // checks nothing at all.
        const numeric: AutomationRule = {
            ...textRule('brackets'),
            graph: {
                ...textRule('brackets').graph,
                cond: { kind: 'number', op: 'gt', threshold: 1 },
            },
        };
        expect(blockingProblems(patternProblems(numeric.graph)).map((p) => p.code)).toEqual([
            'parse.noBrackets',
        ]);
    });
});

describe('automationValidation — a branch no JSON literal can reach', () => {
    // `AutomationTest`'s numeric `value` is a mandatory `number`, never absent, so no fixture case
    // (parsed from JSON) can ever hand `clauseNeedsValue` a non-finite one — `JSON.parse` has no
    // spelling for `NaN` or `Infinity`. The check is still promised by `clauseProblems`'s own
    // comment, so it is pinned here by constructing the clause directly in code rather than through
    // the shared fixture — a branch that is promised but never exercised is a coverage hole with a
    // rationale, not proof the branch does what it claims.
    const clauseRule = (value: number): AutomationRule => ({
        ...cases[0].rule,
        graph: {
            ...cases[0].rule.graph,
            parse: { preset: 'custom', literal: null, find: 'ctx:(\\d+)%', keep: 'brackets' },
            cond: {
                kind: 'text',
                op: null,
                threshold: null,
                clauses: [{ source: 'whole', test: { number: { op: 'gt', value } } }],
            },
        },
    });

    it('a non-finite clause value needs a value, the same code an empty text value gets', () => {
        expect(problems(clauseRule(Number.NaN)).map((p) => p.code)).toEqual(['cond.clauseNeedsValue']);
        // Paired: Infinity is also non-finite and must trip the same guard, not merely NaN.
        expect(problems(clauseRule(Number.POSITIVE_INFINITY)).map((p) => p.code)).toEqual([
            'cond.clauseNeedsValue',
        ]);
    });

    it('the paired positive: an ordinary finite value reports nothing', () => {
        expect(problems(clauseRule(25))).toEqual([]);
    });
});

describe('automationValidation — invalid sources do not hide unfinished operands', () => {
    const ruleWith = (clause: AutomationClause): AutomationRule => ({
        ...cases[0].rule,
        graph: {
            ...cases[0].rule.graph,
            parse: { preset: 'custom', literal: null, find: 'ctx:(\\d+)%', keep: 'brackets' },
            cond: {
                kind: 'text',
                op: null,
                threshold: null,
                clauses: [clause],
            },
        },
    });

    const codes = (rule: AutomationRule) => new Set(problems(rule).map((p) => p.code));

    it('reports both an invalid source and a missing numeric threshold', () => {
        expect(codes(ruleWith({
            source: { group: 2 },
            test: { number: { op: 'gt', value: null } },
        }))).toEqual(new Set(['cond.unknownToken', 'cond.clauseNeedsValue']));
    });

    it('reports both an invalid source and an invalid matches operand', () => {
        expect(codes(ruleWith({
            source: { group: 2 },
            test: { text: { op: 'matches', value: '(' } },
        }))).toEqual(new Set(['cond.unknownToken', 'cond.badClausePattern']));
    });
});
