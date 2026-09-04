/**
 * The app-wide armed-automation index (`plan/028` item D).
 *
 * Four surfaces read this one store, so the things worth pinning are the ones a surface cannot see
 * for itself: that a rule lands on the terminal the ENGINE reports it on and no other, that "first
 * rule" is a decision and not object key order, and that a snapshot keeps its identity when nothing
 * observable changed — the last of which is invisible in every rendered assertion and is the whole
 * reason the tab strip and thirty canvas nodes do not re-render once a second.
 */
import {
    __resetAutomationArmedForTest,
    __seedAutomationArmedForTest,
    countArmedAcross,
    getArmedAutomations,
} from '../automationArmed';
import type { AutomationStatePayload, AutomationRuntimePairState } from '../automationEvents';
import type { AutomationRule } from '../../types/electron';
import {
    armedEntryViews,
    armedOverflow,
    armedTabTitle,
} from '../../components/Automation/automationArmedSummary';

const NOW = 1_700_000_000_000;

function rule(id: string, over: Partial<AutomationRule> = {}): AutomationRule {
    return {
        id,
        name: id.toUpperCase(),
        enabled: true,
        runsOnce: false,
        targetMode: 'pinned',
        criterion: 'allTerminals',
        criterionValue: '',
        followNew: true,
        targetIds: ['tm-1'],
        completedAt: null,
        sortOrder: 0,
        schemaVersion: 1,
        graph: {
            parse: { find: 'x', literal: null },
            cond: { kind: 'text', op: null, threshold: null },
            action: { message: 'go', submit: true },
        },
        createdAt: 0,
        updatedAt: 0,
        ...over,
    } as unknown as AutomationRule;
}

function pair(over: Partial<AutomationRuntimePairState> = {}): AutomationRuntimePairState {
    return { state: 'armed', lastFiredAt: null, firedCount: 0, missing: false, ...over };
}

function runtime(rules: Record<string, Record<string, AutomationRuntimePairState>>): AutomationStatePayload {
    return { rules };
}

afterEach(() => __resetAutomationArmedForTest());

describe('the armed index', () => {
    it('lands a rule on the terminals the engine reports, and on no others', () => {
        __seedAutomationArmedForTest(
            [rule('r1')],
            runtime({ r1: { 'tm-1': pair() } }),
        );

        expect(getArmedAutomations('tm-1').map((a) => a.rule.id)).toEqual(['r1']);
        // `targetIds` also names `tm-1` only, so this is not the interesting half on its own —
        // the next case is.
        expect(getArmedAutomations('tm-2')).toEqual([]);
    });

    it('reports NOTHING for a rule the engine is not running, however its targets read', () => {
        // The rule pins `tm-9` and is enabled, but the engine has no pairs for it — disabled in
        // another window, completed, or simply not started. Deriving armed-ness from the rule's own
        // `targetIds` would light `tm-9` up here, which is the one thing this store promises it
        // cannot do: the engine's answer, never a second implementation of targeting.
        __seedAutomationArmedForTest(
            [rule('r1', { targetIds: ['tm-9'] })],
            runtime({}),
        );

        expect(getArmedAutomations('tm-9')).toEqual([]);
    });

    it('orders by sortOrder then name, so "the first rule" is the same rule everywhere', () => {
        __seedAutomationArmedForTest(
            [
                rule('c', { sortOrder: 5, name: 'Charlie' }),
                rule('a', { sortOrder: 1, name: 'Alpha' }),
                rule('b', { sortOrder: 1, name: 'Bravo' }),
            ],
            runtime({
                c: { 'tm-1': pair() },
                a: { 'tm-1': pair() },
                b: { 'tm-1': pair() },
            }),
        );

        expect(getArmedAutomations('tm-1').map((a) => a.rule.name))
            .toEqual(['Alpha', 'Bravo', 'Charlie']);
    });

    it('counts DISTINCT rules across a tab, not pairs', () => {
        // One rule watching both panes of a split tab is ONE automation on that tab. Counting pairs
        // would report "2 automations" for a tab that has one, and the badge prints the number.
        __seedAutomationArmedForTest(
            [rule('r1'), rule('r2')],
            runtime({
                r1: { 'tm-1': pair(), 'tm-2': pair() },
                r2: { 'tm-2': pair() },
            }),
        );

        expect(countArmedAcross(['tm-1', 'tm-2'])).toBe(2);
        expect(countArmedAcross(['tm-1'])).toBe(1);
        expect(countArmedAcross([])).toBe(0);
    });
});

describe('snapshot identity — what stops the once-a-second re-render of everything', () => {
    it('keeps the same array when a state event changed nothing about this terminal', () => {
        const rules = [rule('r1')];
        __seedAutomationArmedForTest(rules, runtime({ r1: { 'tm-1': pair() } }));
        const first = getArmedAutomations('tm-1');

        // A fresh payload with equal values — exactly what an `automation:state` tick delivers.
        __seedAutomationArmedForTest(rules, runtime({ r1: { 'tm-1': pair() } }));

        expect(getArmedAutomations('tm-1')).toBe(first);
    });

    it('replaces the array when the pair actually changed', () => {
        // The other half, and it is not decoration: a `sameArmed` that always returned true would
        // pass the case above and freeze every badge on its first reading for the whole session.
        const rules = [rule('r1')];
        __seedAutomationArmedForTest(rules, runtime({ r1: { 'tm-1': pair() } }));
        const first = getArmedAutomations('tm-1');

        __seedAutomationArmedForTest(
            rules,
            runtime({ r1: { 'tm-1': pair({ state: 'fired', lastFiredAt: NOW, firedCount: 1 }) } }),
        );

        expect(getArmedAutomations('tm-1')).not.toBe(first);
        expect(getArmedAutomations('tm-1')[0].pair.state).toBe('fired');
    });
});

describe('the words each surface prints', () => {
    it('describes THIS terminal, not the rule across every terminal it watches', () => {
        // `tm-2` is missing, which folds a rule-wide state to `Error`. `tm-1` is merely armed, and
        // saying *Error* on `tm-1`'s pane because some other terminal died is evidence from outside
        // the bucket — the defect `automationState.ts` records one level down.
        __seedAutomationArmedForTest(
            [rule('r1')],
            runtime({ r1: { 'tm-1': pair(), 'tm-2': pair({ missing: true }) } }),
        );

        expect(armedEntryViews(getArmedAutomations('tm-1'), NOW)[0].stateLabel)
            .toBe('Armed · waiting');
        expect(armedEntryViews(getArmedAutomations('tm-2'), NOW)[0].stateLabel)
            .toBe('Error');
    });

    it('offers a +N only once there is more than one rule', () => {
        __seedAutomationArmedForTest(
            [rule('r1'), rule('r2'), rule('r3')],
            runtime({
                r1: { 'tm-1': pair() },
                r2: { 'tm-1': pair() },
                r3: { 'tm-1': pair(), 'tm-2': pair() },
            }),
        );

        expect(armedOverflow(getArmedAutomations('tm-2'))).toBeNull();
        expect(armedOverflow(getArmedAutomations('tm-1'))).toBe('+2');
    });

    it('gives a tab its own sentence, in the singular and the plural', () => {
        expect(armedTabTitle(1)).toBe('1 automation is armed on a terminal in this tab');
        expect(armedTabTitle(3)).toBe('3 automations are armed on terminals in this tab');
    });
});
