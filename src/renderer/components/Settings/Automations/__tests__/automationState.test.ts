/**
 * §10.24 — the row's runtime state.
 *
 * The seven-state table, the disagree case asserting the qualifier string exactly, and a Completed
 * rule's switch reported disabled. Q5's order is not written down anywhere else, and getting it
 * wrong makes rows describe rules incorrectly — a rule with one dead terminal and one happily armed
 * one must not read *Armed · waiting*.
 */
import type { AutomationRule } from '../../../../types/electron';
import type { AutomationRuntimePairState } from '../../../../services/automationEvents';
import {
    automationRowState,
    describeCadence,
    describeCriterion,
    describeLastFired,
    describeRule,
    describeWatching,
    JUST_FIRED_MS,
} from '../automationState';

const NOW = 1_700_000_000_000;

function rule(over: Partial<AutomationRule> = {}): AutomationRule {
    return {
        id: 'au-1',
        name: 'Context handoff reminder',
        enabled: true,
        runsOnce: false,
        targetMode: 'rule',
        criterion: 'commandContains',
        criterionValue: 'claude',
        followNew: true,
        targetIds: [],
        completedAt: null,
        verboseUntil: null,
        sortOrder: 0,
        schemaVersion: 1,
        graph: {
            monitor: { read: 'newOutput', cadence: 'timer', everyMs: 30000 },
            parse: { preset: 'percentage', literal: null, find: 'ctx:(\\d+)%', keep: 'brackets' },
            cond: { kind: 'number', op: 'gt', threshold: 25 },
            action: { message: 'hand off', sendTo: 'matched', submit: true, cliType: 'default' },
        },
        createdAt: 0,
        updatedAt: 0,
        ...over,
    };
}

function pair(over: Partial<AutomationRuntimePairState> = {}): AutomationRuntimePairState {
    return { state: 'armed', lastFiredAt: null, firedCount: 0, missing: false, ...over };
}

describe('automationRowState — the state table', () => {
    it('reports off for a disabled rule, whatever its pairs say', () => {
        // Off outranks everything: the user's own decision is the most important thing a row can
        // say, and a disabled rule's runtime state is stale by definition.
        const state = automationRowState(
            rule({ enabled: false }),
            { 'tm-1': pair({ missing: true }) },
            NOW,
        );
        expect(state.id).toBe('off');
        expect(state.pillText).toBe('Off');
    });

    it('reports completed, with the toggle on but INERT', () => {
        const state = automationRowState(
            rule({ runsOnce: true, completedAt: NOW - 1000 }),
            { 'tm-1': pair() },
            NOW,
        );
        expect(state.id).toBe('completed');
        // Switching it off and on again would be a confusing way to re-arm it, so it isn't the
        // mechanism — the toggle stays on and stops responding, and Reset is what re-admits it.
        expect(state.toggleDisabled).toBe(true);
    });

    it('a completed rule the user then switched OFF reads off, not completed', () => {
        const state = automationRowState(
            rule({ runsOnce: true, enabled: false, completedAt: NOW - 1000 }),
            { 'tm-1': pair() },
            NOW,
        );
        expect(state.id).toBe('off');
    });

    it('reports error for a missing pinned terminal', () => {
        const state = automationRowState(rule(), { 'tm-1': pair({ missing: true }) }, NOW);
        expect(state.id).toBe('error');
    });

    it('reports error for an enabled rule the engine is running with nothing to watch', () => {
        expect(automationRowState(rule(), {}, NOW).id).toBe('error');
    });

    it('does NOT report error before the engine has reported the rule at all', () => {
        // A live set is not existence. On first paint, before `get_automation_runtime` resolves,
        // every enabled rule would otherwise flash *Error · nothing to watch* and then silently
        // retract it — the same trap that made the backend hold missing ids behind a grace period.
        expect(automationRowState(rule(), undefined, NOW).id).toBe('waiting');
    });

    it('reports "just fired" only while the receipt is fresh, then waiting to re-arm', () => {
        const fresh = automationRowState(
            rule(),
            { 'tm-1': pair({ state: 'fired', lastFiredAt: NOW - 1000, firedCount: 1 }) },
            NOW,
        );
        expect(fresh.id).toBe('fired');
        expect(fresh.label).toBe('Just fired');

        const settled = automationRowState(
            rule(),
            {
                'tm-1': pair({
                    state: 'fired',
                    lastFiredAt: NOW - JUST_FIRED_MS - 1,
                    firedCount: 1,
                }),
            },
            NOW,
        );
        expect(settled.id).toBe('rearm');
        expect(settled.label).toBe('Fired · waiting to re-arm');
    });

    /**
     * **A pair that really fired must not lend its receipt to the pair that won.**
     *
     * `everFired` scanned every pair in the rule while the label it guards describes ONE bucket. So a
     * rule watching a terminal that fired for real five minutes ago and a second that is merely held
     * painted the held pair's `rearm` bucket *Fired · waiting to re-arm* — attributing the first
     * terminal's fire to one that has never fired at all. That is the same "held pair painted as
     * Fired" defect the softened label was introduced to fix, reproduced one level up.
     *
     * The two cases differ only in the non-winning pair's `state`, which is the field that decides
     * whether its fire is inside the bucket or outside it.
     */
    it('does not borrow a fire from a pair outside the winning state', () => {
        const held = pair({ state: 'fired', lastFiredAt: null, firedCount: 0 });

        const borrowed = automationRowState(
            rule(),
            {
                // Resting, and it genuinely fired a while ago — so it lands in `waiting`, not in the
                // `rearm` bucket the label is about.
                'tm-1': pair({ state: 'armed', lastFiredAt: NOW - JUST_FIRED_MS - 1, firedCount: 1 }),
                'tm-2': held,
            },
            NOW,
        );
        expect(borrowed.id).toBe('rearm');
        expect(borrowed.label).toBe('Waiting to re-arm');

        // Paired positive: the same fire, moved INSIDE the winning bucket, still earns the word —
        // without which "never says Fired" would pass just as well.
        const earned = automationRowState(
            rule(),
            {
                'tm-1': pair({ state: 'fired', lastFiredAt: NOW - JUST_FIRED_MS - 1, firedCount: 1 }),
                'tm-2': held,
            },
            NOW,
        );
        expect(earned.id).toBe('rearm');
        expect(earned.label).toBe('Fired · waiting to re-arm');
    });

    /**
     * A pair may sit in `fired` having never fired.
     *
     * A presence rule switched on while its text is ALREADY on screen is held, not fired: the engine
     * logs `held — "…is still on screen"` and sends nothing, which is right — it must not fire on
     * output that predates being switched on — but it leaves `state: 'fired'` with
     * `lastFiredAt: null`. The row then read **Fired · waiting to re-arm** beside its own footer
     * **Never fired**. Seen on a live build; the state is right and only the word "Fired" is false.
     */
    it('does not say Fired for a pair that never has', () => {
        const held = automationRowState(
            rule(),
            { 'tm-1': pair({ state: 'fired', lastFiredAt: null, firedCount: 0 }) },
            NOW,
        );
        expect(held.id).toBe('rearm');
        expect(held.label).toBe('Waiting to re-arm');
        expect(held.pillText).not.toContain('Fired');
    });

    /** One terminal really fired, another is merely held — the rule HAS fired, so the word stands. */
    it('still says Fired when any watched terminal actually fired', () => {
        const mixed = automationRowState(
            rule(),
            {
                'tm-1': pair({ state: 'fired', lastFiredAt: null, firedCount: 0 }),
                'tm-2': pair({ state: 'fired', lastFiredAt: NOW - JUST_FIRED_MS - 1, firedCount: 1 }),
            },
            NOW,
        );
        expect(mixed.label).toBe('Fired · waiting to re-arm');
    });

    it('reports armed and waiting for both unseen and armed pairs', () => {
        expect(automationRowState(rule(), { 'tm-1': pair({ state: 'unseen' }) }, NOW).id)
            .toBe('waiting');
        expect(automationRowState(rule(), { 'tm-1': pair({ state: 'armed' }) }, NOW).id)
            .toBe('waiting');
    });

    /**
     * `matched` is in the union because mockup §09 teaches the word and M5's editor uses the same
     * seven ids — but **nothing produces it**, and this test says so in a way that goes red the
     * moment that stops being true. The evaluator advances the arm to `Fired` in the same statement
     * that decides the crossing (deliberately, so a second tick mid-send cannot queue a duplicate),
     * so a pair is never observed armed-and-true.
     *
     * Exhaustive over every shape `RuntimePairState` can take, rather than over the three or four a
     * hand-written table would have thought of.
     */
    it('matched has no producer, over every possible pair shape', () => {
        const seen = new Set<string>();
        for (const state of ['unseen', 'armed', 'fired'] as const) {
            for (const missing of [false, true]) {
                for (const lastFiredAt of [null, NOW, NOW - JUST_FIRED_MS - 1]) {
                    for (const firedCount of [0, 3]) {
                        seen.add(
                            automationRowState(
                                rule(),
                                { 'tm-1': { state, lastFiredAt, firedCount, missing } },
                                NOW,
                            ).id,
                        );
                    }
                }
            }
        }
        expect(seen.has('matched')).toBe(false);
        // The premise: the sweep really did reach the other states, so the assertion above is not
        // passing because nothing ran.
        expect([...seen].sort()).toEqual(['error', 'fired', 'rearm', 'waiting']);
    });
});

describe('automationRowState — the qualifier', () => {
    it("says '1 of 2' when the pairs disagree, and names the state's own noun", () => {
        const state = automationRowState(
            rule(),
            { 'tm-1': pair({ missing: true }), 'tm-2': pair() },
            NOW,
        );
        expect(state.id).toBe('error');
        expect(state.qualifier).toBe('1 of 2');
        expect(state.pillText).toBe('Error · 1 of 2 missing');
    });

    it('says nothing when every pair agrees', () => {
        // *Error · 2 of 2 missing* says nothing *Error* did not.
        const state = automationRowState(
            rule(),
            { 'tm-1': pair({ missing: true }), 'tm-2': pair({ missing: true }) },
            NOW,
        );
        expect(state.qualifier).toBeNull();
        expect(state.pillText).toBe('Error');
    });

    it('says nothing for a single watched terminal', () => {
        expect(automationRowState(rule(), { 'tm-1': pair({ missing: true }) }, NOW).qualifier)
            .toBeNull();
    });
});

describe('automationRowState — severity, pair by pair', () => {
    /**
     * The order itself, asserted as a LIST rather than at one sample. Q5's order is not written
     * down anywhere but the plan, and the first version of this suite only ever put `error` against
     * `waiting` — so a mutation that moved `error` BELOW `fired` and `rearm` survived, because no
     * test ever made those two compete. Every adjacent pair in the order is now exercised.
     */
    const CASES: Array<[string, AutomationRuntimePairState, AutomationRuntimePairState, string]> = [
        [
            'error beats just-fired',
            pair({ missing: true }),
            pair({ state: 'fired', lastFiredAt: NOW, firedCount: 1 }),
            'error',
        ],
        [
            'error beats waiting-to-re-arm',
            pair({ missing: true }),
            pair({ state: 'fired', lastFiredAt: NOW - JUST_FIRED_MS - 1, firedCount: 1 }),
            'error',
        ],
        [
            'just-fired beats waiting-to-re-arm',
            pair({ state: 'fired', lastFiredAt: NOW, firedCount: 1 }),
            pair({ state: 'fired', lastFiredAt: NOW - JUST_FIRED_MS - 1, firedCount: 1 }),
            'fired',
        ],
        [
            'waiting-to-re-arm beats armed and waiting',
            pair({ state: 'fired', lastFiredAt: NOW - JUST_FIRED_MS - 1, firedCount: 1 }),
            pair({ state: 'armed' }),
            'rearm',
        ],
    ];

    it.each(CASES)('%s', (_label, a, b, expected) => {
        // Both orders, so the answer cannot come from which key happened to be enumerated first.
        expect(automationRowState(rule(), { 'tm-1': a, 'tm-2': b }, NOW).id).toBe(expected);
        expect(automationRowState(rule(), { 'tm-1': b, 'tm-2': a }, NOW).id).toBe(expected);
    });
});

describe('the row reads as a sentence', () => {
    it('uses the crossing verb, never an operator symbol', () => {
        // "Rises above", not ">", because the crossing IS the semantics: a user who reads the row
        // has already been told it will not nag.
        const s = describeRule(rule());
        expect(s.lead).toBe('when the number in');
        expect(s.subject).toBe('ctx:(\\d+)%');
        expect(s.verb).toBe('rises above');
        expect(s.threshold).toBe('25');
        expect(s.verbSend).toBe('send');
        expect(s.sendNote).toBeNull();
    });

    it('says "type … — no Enter" for an action that deliberately does not submit', () => {
        const r = rule();
        r.graph.action.submit = false;
        r.graph.action.message = '1';
        const s = describeRule(r);
        expect(s.verbSend).toBe('type');
        expect(s.sendNote).toBe(' — no Enter');
    });

    it('shows the literal the user typed, not its regex-escaped form', () => {
        const r = rule();
        r.graph.cond = { kind: 'text', op: null, threshold: null };
        r.graph.parse = {
            preset: 'exactWords',
            literal: 'Do you want to proceed?',
            find: 'Do you want to proceed\\?',
            keep: 'whole',
        };
        const s = describeRule(r);
        expect(s.lead).toBe('when output starts matching');
        expect(s.subject).toBe('Do you want to proceed?');
        expect(s.verb).toBeNull();
    });

    it('describes a PINNED rule by its picked terminals, not by its stale criterion', () => {
        // A pinned rule still carries a criterion — the columns are non-optional and keep whatever
        // they last held — and `watched_set` ignores it entirely for that mode. Switching on the
        // criterion alone made a rule watching two hand-picked terminals read "all terminals",
        // which is the one thing this module promises cannot happen.
        const pinned = rule({
            targetMode: 'pinned',
            criterion: 'allTerminals',
            criterionValue: '',
            targetIds: ['tm-1', 'tm-2'],
        });
        expect(describeCriterion(pinned)).toBe('2 picked terminals');
        expect(describeWatching(pinned, { 'tm-1': pair(), 'tm-2': pair({ missing: true }) }))
            .toBe('2 picked terminals · 1 open');

        const one = rule({ targetMode: 'pinned', targetIds: ['tm-1'] });
        expect(describeCriterion(one)).toBe('1 picked terminal');
    });

    it('describes a criterion rule by its criterion, and counts in "now"', () => {
        const r = rule();
        expect(describeWatching(r, { 'tm-1': pair(), 'tm-2': pair() }))
            .toBe('command contains "claude" · 2 now');
        // No pairs reported yet: the subject alone, never "· 0 now", which would read as a finding.
        expect(describeWatching(r, undefined)).toBe('command contains "claude"');
        expect(describeWatching(r, {})).toBe('command contains "claude"');
    });

    it('says how long ago it fired, the way the mockup words it', () => {
        const now = 1_700_000_000_000;
        expect(describeLastFired(now - 5_000, now)).toBe('just now');
        expect(describeLastFired(now - 4 * 60_000, now)).toBe('4 min ago');
        expect(describeLastFired(now - 2 * 3_600_000, now)).toBe('2 hours ago');
        expect(describeLastFired(now - 3_600_000, now)).toBe('1 hour ago');
    });

    it('describes the criterion and the cadence in the picker′s own words', () => {
        expect(describeCriterion(rule())).toBe('command contains "claude"');
        expect(describeCriterion(rule({ criterion: 'allTerminals' }))).toBe('all terminals');
        expect(describeCadence(rule())).toBe('Checks every 30s');
        const timed = rule();
        timed.graph.monitor.everyMs = 300000;
        expect(describeCadence(timed)).toBe('Checks every 5 min');
        const streamed = rule();
        streamed.graph.monitor.cadence = 'onOutput';
        expect(describeCadence(streamed)).toBe('On every new line');
    });
});
