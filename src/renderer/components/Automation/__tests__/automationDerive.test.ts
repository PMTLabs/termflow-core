/**
 * §10.20 — the ten-template table, asserted through **both renderers**.
 *
 * **The direct port of the test that caught the mockup's worst rev-1 bug.** Rev 1 had four
 * hard-coded inspector panels, so five of six templates showed one rule on the canvas and a
 * *different* rule in the panel eight pixels away. Nothing was wrong with either renderer — they
 * simply had two sources.
 *
 * So testing `faceFor` alone is not enough, and that is the point of this file: a face derived
 * correctly beside a panel reading a hard-coded per-step default **is** rev 1, and it passes a test
 * that only looks at faces. Every assertion below is made twice, once through each renderer, on the
 * same template.
 */
import {
    AUTOMATION_TEMPLATES,
    draftFromTemplate,
} from '../../Settings/Automations/automationTemplates';
import {
    WIRE_CHIPS,
    condFaceText,
    condSentence,
    describeRule,
    faceFor,
    panelFor,
    ruleSummary,
    stateFor,
    stepValues,
} from '../automationDerive';
import type { DeriveContext } from '../automationDerive';
import { problems } from '../automationValidation';
import { STEP_ORDER, STEP_PORTS } from '../automationSteps';
import type { StepKind } from '../automationSteps';
import { displayedPattern } from '../automationPresets';
import type { AutomationClause, AutomationCondStep } from '../../../types/electron';

const NOW = 1_700_000_000_000;

const ctxFor = (rule: Parameters<typeof problems>[0]): DeriveContext => ({
    now: NOW,
    problems: problems(rule),
});

/** Every string a face draws, flattened — so an assertion does not have to know which row it is in. */
const faceText = (rule: Parameters<typeof problems>[0], step: StepKind) =>
    faceFor(rule, step, ctxFor(rule))
        .rows.map((r) => `${r.label}: ${r.value.text}`)
        .join(' | ');

/** The same, through the panel. */
const panelText = (rule: Parameters<typeof problems>[0], step: StepKind) =>
    Object.entries(panelFor(rule, step, ctxFor(rule)).values)
        .map(([k, v]) => `${k}: ${v.text}`)
        .join(' | ');

describe('automationDerive — each template carries its OWN values, through both renderers', () => {
    it.each(AUTOMATION_TEMPLATES.map((t) => [t.title, t] as const))(
        '%s',
        (_title, template) => {
            const rule = draftFromTemplate(template);
            const { parse, cond, action } = rule.graph;

            // --- the pattern ---------------------------------------------------------------------
            if (parse) {
                const shown = displayedPattern(parse);
                expect(faceText(rule, 'parse')).toContain(shown);
                expect(panelText(rule, 'parse')).toContain(shown);
            }

            // --- the threshold -------------------------------------------------------------------
            if (cond?.kind === 'number' && cond.threshold !== null && cond.threshold !== undefined) {
                expect(faceText(rule, 'cond')).toContain(String(cond.threshold));
                expect(panelText(rule, 'cond')).toContain(String(cond.threshold));
            }

            // --- the message ---------------------------------------------------------------------
            if (action) {
                expect(faceText(rule, 'action')).toContain(action.message);
                expect(panelText(rule, 'action')).toContain(action.message);
            }
        },
    );

    it('and no two templates produce the same faces', () => {
        // The assertion above would also pass if `stepValues` returned one template's values for
        // every template that happened to contain the right substring. This is what makes it a
        // TABLE rather than six copies of one case.
        const rendered = AUTOMATION_TEMPLATES.map((t) => {
            const rule = draftFromTemplate(t);
            return STEP_ORDER.map((step) => faceText(rule, step)).join(' || ');
        });
        expect(new Set(rendered).size).toBe(AUTOMATION_TEMPLATES.length);
    });

    it('and the panel and the face are the same record, not two that agree today', () => {
        for (const template of AUTOMATION_TEMPLATES) {
            const rule = draftFromTemplate(template);
            for (const step of STEP_ORDER) {
                const values = stepValues(rule, step);
                const panel = panelFor(rule, step, ctxFor(rule));
                expect(panel.values).toEqual(values);
                // And every row a face draws is one of those values — never a seventh string
                // computed in the component.
                for (const row of faceFor(rule, step, ctxFor(rule)).rows) {
                    expect(Object.values(values)).toContainEqual(row.value);
                }
            }
        }
    });
});

describe('automationDerive — a fresh draft claims no runtime state', () => {
    it.each(AUTOMATION_TEMPLATES.map((t) => [t.title, t] as const))(
        "%s's compare step never says fired or completed",
        (_title, template) => {
            const rule = draftFromTemplate(template);
            const face = faceFor(rule, 'cond', ctxFor(rule));
            expect(face.foot ?? '').not.toMatch(/fired|completed/i);
            expect(stateFor(rule, 'cond', ctxFor(rule)).tone).not.toBe('live');
        },
    );

    it('but DOES once the engine reports a pair', () => {
        // The paired positive: without it the assertions above pass on a `faceFor` whose runtime
        // branch was deleted.
        // `enabled: true`, because a switched-off rule reads "Off" whatever its pairs say — and a
        // test arranged with the shipped `enabled: false` would have asserted the absence of a word
        // for the wrong reason entirely.
        const rule = { ...draftFromTemplate(AUTOMATION_TEMPLATES[0]), id: 'au-1', enabled: true };
        const ctx: DeriveContext = {
            now: NOW,
            problems: [],
            pairs: { 'tm-a': { state: 'fired', lastFiredAt: NOW - 1000, firedCount: 1, missing: false, parkedAt: null } },
        };
        expect(faceFor(rule, 'cond', ctx).foot).toMatch(/fired/i);
        expect(stateFor(rule, 'cond', ctx).tone).toBe('live');
    });

    /**
     * The gap the two tests above leave between them.
     *
     * *"never says fired or completed"* is asserted only for templates, which carry NO pairs — the
     * branch that returns an empty foot before touching the runtime at all. So the assertion could
     * not tell a correct runtime foot from one that says *"Fired"* for a pair that has never fired;
     * only the paired positive exercised the runtime branch, and it hands it an already-`fired` pair.
     *
     * A pair the engine has merely REGISTERED is `unseen`, and it is the shape a rule sits in for
     * the whole gap between being switched on and its first evaluation — which is exactly when a
     * node claiming to have fired would be at its most wrong.
     */
    it('reports a registered-but-unseen pair without claiming it has fired', () => {
        const rule = { ...draftFromTemplate(AUTOMATION_TEMPLATES[0]), id: 'au-1', enabled: true };
        const ctx: DeriveContext = {
            now: NOW,
            problems: [],
            pairs: { 'tm-a': { state: 'unseen', lastFiredAt: null, firedCount: 0, missing: false, parkedAt: null } },
        };

        const face = faceFor(rule, 'cond', ctx);
        // It DOES speak — this is the runtime branch, not the empty one...
        expect(stateFor(rule, 'cond', ctx).tone).toBe('live');
        // ...and it says the RESTING state, by name.
        //
        // Asserted as the exact label rather than as `not /fired/`, which was the first attempt and
        // was vacuous: mapping `unseen` to the re-arm state instead survived it, because `everFired`
        // then relabels that pill *"Waiting to re-arm"* — a string containing neither "fired" nor
        // "completed". A negative built from two words cannot see a wrong state that avoids them.
        expect(face.foot).toBe('Armed · waiting');
        expect(stateFor(rule, 'cond', ctx).title).toBe('Armed · waiting');
    });

    it('and a blocking problem outranks the runtime state on the node it belongs to', () => {
        // A node cannot be green because it is running while being red because it cannot run: the
        // problem is the thing the user has to act on.
        const rule = { ...draftFromTemplate(AUTOMATION_TEMPLATES[0]), id: 'au-1', enabled: true };
        const broken = {
            ...rule,
            graph: { ...rule.graph, cond: { kind: 'number' as const, op: null, threshold: null } },
        };
        const ctx: DeriveContext = {
            now: NOW,
            problems: problems(broken),
            pairs: { 'tm-a': { state: 'fired', lastFiredAt: NOW, firedCount: 1, missing: false, parkedAt: null } },
        };
        expect(stateFor(broken, 'cond', ctx).tone).toBe('error');
        expect(faceFor(broken, 'cond', ctx).footTone).toBe('warn');
    });
});

/**
 * `STEP_FIELDS.monitor` is `['targets', 'monitor']` — one node owning TWO problem categories, which
 * is the only entry in that table that is not the identity mapping.
 *
 * Nothing asserted the `targets` half. Dropping it leaves a rule that cannot run showing a green,
 * configured Watch-output node with nothing on it to click: the missing pick is the single most
 * common reason a rule will not enable, and it is reported by the node the user has to open to fix
 * it. Both categories are checked here so neither half can be dropped silently.
 */
describe('automationDerive — the monitor node owns both of its problem categories', () => {
    const pinnedWithNothingPicked = () => ({
        ...draftFromTemplate(AUTOMATION_TEMPLATES[0]),
        id: 'au-1',
        targetMode: 'pinned' as const,
        targetIds: [],
    });

    it('shows a missing PICK on the monitor node, not on some other step', () => {
        const rule = pinnedWithNothingPicked();
        const ctx = ctxFor(rule);
        // The problem really is the targets one, so a rename of the code cannot make this vacuous.
        expect(ctx.problems.map((p) => p.code)).toContain('targets.empty');

        expect(stateFor(rule, 'monitor', ctx).tone).toBe('error');
        expect(faceFor(rule, 'monitor', ctx).footTone).toBe('warn');
        // And it is not smeared across the other three nodes.
        for (const step of ['parse', 'cond', 'action'] as const) {
            expect(stateFor(rule, step, ctx).tone).not.toBe('error');
        }
    });

    it('shows a too-fast TIMER on the same node', () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const rule = {
            ...base,
            id: 'au-1',
            graph: {
                ...base.graph,
                monitor: { ...base.graph.monitor, cadence: 'timer' as const, everyMs: 200 },
            },
        };
        const ctx = ctxFor(rule);
        expect(ctx.problems.map((p) => p.code)).toContain('monitor.interval');
        expect(stateFor(rule, 'monitor', ctx).tone).toBe('error');
    });
});

/**
 * **A card standing for a step the rule does not have must not claim it is configured.**
 *
 * `draftFromRule` draws all four cards for any SAVED rule, whatever the graph holds, so a schedule
 * rule (plan 032 §3.1, §6.3) opens with three cards whose rows read *"not in this rule"*. `stateFor`
 * never consulted `rule.graph`: validation correctly reports nothing for an absent step, so it fell
 * straight through to a green dot titled *"This step is configured."* — same card, two claims, the
 * fourth site of the class `430a6d3` fixed at three.
 */
describe('automationDerive — a step the rule does not have', () => {
    /** A schedule rule: no monitor, no parse, no cond — it fires on the clock. */
    const scheduleRule = () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const { monitor: _m, parse: _p, cond: _c, ...graph } = base.graph;
        return {
            ...base,
            id: 'au-sched',
            enabled: true,
            graph: { ...graph, timer: { mode: { dailyAt: { minuteOfDay: 9 * 60, days: 0b0001_1111 } } } },
        };
    };

    it.each(['monitor', 'parse', 'cond'] as const)(
        'does not report %s as configured when the rule has no such step',
        (step) => {
            const rule = scheduleRule();
            const ctx = ctxFor(rule);
            // The premise, so a fixture that quietly grew the step back cannot make this vacuous.
            expect(rule.graph[step]).toBeUndefined();

            const state = stateFor(rule, step, ctx);
            expect(state.tone).toBe('absent');
            expect(state.title).toBe('This step is not in this rule.');
            // And the dot agrees with the rows on the very same card.
            expect(faceText(rule, step)).toContain('not in this rule');
        },
    );

    it('still says CONFIGURED for the one step every rule has', () => {
        // The paired positive: a guard that answered `absent` for everything would pass the table
        // above completely, and `action` is the step no rule can be without.
        const rule = scheduleRule();
        expect(stateFor(rule, 'action', ctxFor(rule))).toEqual({
            tone: 'ready',
            title: 'This step is configured.',
        });
    });

    it('and a live pair does not make an absent compare step live', () => {
        // The `cond` branch is the one that would otherwise have reached the runtime pill instead
        // of the green dot — a different wrong answer for the same card, not a right one.
        const ctx: DeriveContext = {
            now: NOW,
            problems: [],
            pairs: { 'tm-a': { state: 'fired', lastFiredAt: NOW - 1000, firedCount: 1, missing: false, parkedAt: null } },
        };
        expect(stateFor(scheduleRule(), 'cond', ctx).tone).toBe('absent');
    });

    /**
     * **A rule's runtime goes on the card that DRIVES it, and a schedule rule's is the Wait card.**
     *
     * The dot was fixed for the absent Compare-it card (`and a live pair does not make an absent
     * compare step live`, above) and the FOOT was deliberately left, on the argument that the pill
     * it draws — *Armed · waiting* — is true of the rule even when the card is not the rule's. That
     * argument rested on a convention: rule-level runtime lives on the comparison, because every
     * rule has one and the arm machine is there. Plan 032 §3.1 made `cond` optional and §6.3 gave
     * the rule a Wait card that is its step ONE, so the convention expired — a schedule rule was
     * printing its runtime across a card whose own rows say *not in this rule*.
     *
     * Both halves are asserted, because they are the foot and the dot of one card: `faceFor` and
     * `stateFor` now ask the same function which card is live, and a test that checked only one
     * would pass on a fix applied to only one.
     */
    it('draws a schedule rule runtime on its Wait card, not on the compare card it lacks', () => {
        const rule = scheduleRule();
        const ctx: DeriveContext = {
            now: NOW,
            problems: [],
            pairs: { 'tm-a': { state: 'unseen', lastFiredAt: null, firedCount: 0, missing: false, parkedAt: null } },
        };

        const cond = faceFor(rule, 'cond', ctx);
        expect(cond.foot).toBeNull();
        expect(cond.footTone).toBeNull();
        expect(stateFor(rule, 'cond', ctx).tone).toBe('absent');

        const timer = faceFor(rule, 'timer', ctx);
        expect(timer.foot).toBe('Armed · waiting');
        expect(timer.footTone).toBe('live');
        expect(stateFor(rule, 'timer', ctx)).toEqual({ tone: 'live', title: 'Armed · waiting' });
    });

    /**
     * The other half of that decision, and the one that stops it becoming a rewrite.
     *
     * A rule that HAS a comparison keeps its pill there, where the arm machine it reports actually
     * lives — including a §6.2 rule whose Wait card is a middle box between the comparison and the
     * send. Without this, `runtimeFootStep` could have been written as "the Wait card whenever there
     * is one" and every delay rule would have moved its runtime onto a step that only holds a
     * number.
     */
    it('leaves a rule that HAS a comparison reporting on its compare card', () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const delayed = {
            ...base,
            id: 'au-delay',
            enabled: true,
            graph: { ...base.graph, timer: { mode: { afterMatch: { delayMs: 30_000 } } } },
        };
        const ctx: DeriveContext = {
            now: NOW,
            problems: [],
            pairs: { 'tm-a': { state: 'unseen', lastFiredAt: null, firedCount: 0, missing: false, parkedAt: null } },
        };

        expect(delayed.graph.cond).toBeDefined();
        expect(faceFor(delayed, 'cond', ctx).footTone).toBe('live');
        expect(stateFor(delayed, 'cond', ctx).tone).toBe('live');
        // And the Wait card stays an ordinary configured step: two live cards would be the same
        // two-answers defect wearing the opposite sign.
        expect(faceFor(delayed, 'timer', ctx).footTone).toBeNull();
        expect(stateFor(delayed, 'timer', ctx).tone).toBe('ready');
    });

    /**
     * A parked send reaches the card, in the same words the Settings row uses.
     *
     * `faceFor` renders `automationRowState().pillText` verbatim, so the countdown arrives here for
     * free — which is the property worth pinning: the editor and the list must not word one runtime
     * two ways, which is the failure `automationState.ts`'s own header describes from rev 1.
     */
    it('carries a parked send countdown onto the live card', () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const delayed = {
            ...base,
            id: 'au-delay',
            enabled: true,
            graph: { ...base.graph, timer: { mode: { afterMatch: { delayMs: 30_000 } } } },
        };
        const ctx: DeriveContext = {
            now: NOW,
            problems: [],
            pairs: {
                'tm-a': {
                    state: 'fired',
                    lastFiredAt: null,
                    firedCount: 0,
                    missing: false,
                    parkedAt: NOW + 30_000,
                },
            },
        };
        expect(faceFor(delayed, 'cond', ctx).foot).toBe('Waiting to send · in 30s');
        expect(stateFor(delayed, 'cond', ctx).title).toBe('Waiting to send · in 30s');
    });

    it('but a real problem on an absent step still outranks it', () => {
        // **Why the guard sits BELOW the two problem branches.** `STEP_FIELDS.monitor` includes
        // `targets`, and targeting survives an absent monitor step — `targetMode`/`targetIds` are
        // the rule's own columns — so a pinned schedule rule with nothing ticked has a blocking,
        // actionable problem reported against a step it does not have, and the Watch row on that
        // card names it. Swallowing that to repeat what the rows already say would be a worse card,
        // not a truer one.
        const rule = { ...scheduleRule(), targetMode: 'pinned' as const, targetIds: [] };
        const ctx = ctxFor(rule);
        expect(ctx.problems.map((p) => p.code)).toContain('targets.empty');
        expect(stateFor(rule, 'monitor', ctx).tone).toBe('error');
    });

    /**
     * **The Wait card's subtitle cannot be one fixed number.** Plan 032 §3 makes it a HEAD-OR-MIDDLE
     * box: step 4 in delay mode (between the comparison and the send, `STEP_ORDER`'s own slot) and
     * step 1 in schedule mode, where it is the first thing that happens — the mockup draws both, and
     * `STEP_ORDER` is one array, so a subtitle built only from it can only ever be right about one.
     * Task 25's own dispatch: *"the mockup shows 'Step 1' for a schedule rule — and it is right."*
     */
    it('numbers the Wait card by the rule\'s OWN mode, not by the fixed step order', () => {
        const delayRule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        delayRule.graph.timer = { mode: { afterMatch: { delayMs: 30_000 } } };
        expect(panelFor(delayRule, 'timer', ctxFor(delayRule)).subtitle).toMatch(/^Step 4 ·/);

        const schedRule = scheduleRule();
        expect(panelFor(schedRule, 'timer', ctxFor(schedRule)).subtitle).toMatch(/^Step 1 ·/);

        // The paired negative: a rule with NO wait step at all is not "step 1" either — the fixed
        // order still applies to the placeholder card.
        const noTimer = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        expect(panelFor(noTimer, 'timer', ctxFor(noTimer)).subtitle).toMatch(/^Step 4 ·/);

    });

    /**
     * **M2, confirmed on screen: every four-step rule's Send panel said "Step 5".** A stock template
     * draws FOUR cards and its Send card's head read *"Send to terminal — Step 5 · what happens when
     * it fires"*; the cards read 1, 2, 3, 5, with no step 4 anywhere. That is every rule that exists
     * today, not an edge case.
     *
     * The cause was `stepPosition` special-casing `timer` alone while `action` took its index from a
     * five-element `STEP_ORDER`. The fix is to number from the steps the rule HAS — which is what
     * task 29 makes available — rather than to add a second special case, since one special case is
     * how the first wrong number got here.
     *
     * Mutation: revert to indexing `STEP_ORDER` → the four-step row dies, the five-step row does not.
     */
    it('numbers a card by the steps the rule HAS, so a four-step rule ends at 4', () => {
        const fourStep = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        expect(fourStep.graph.timer).toBeUndefined();
        expect(panelFor(fourStep, 'action', ctxFor(fourStep)).subtitle).toMatch(/^Step 4 ·/);

        const fiveStep = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        fiveStep.graph.timer = { mode: { afterMatch: { delayMs: 30_000 } } };
        expect(panelFor(fiveStep, 'action', ctxFor(fiveStep)).subtitle).toMatch(/^Step 5 ·/);

        // And the schedule rule, whose two cards are 1 and 2 — the same arithmetic, not a third case.
        const sched = scheduleRule();
        expect(panelFor(sched, 'timer', ctxFor(sched)).subtitle).toMatch(/^Step 1 ·/);
        expect(panelFor(sched, 'action', ctxFor(sched)).subtitle).toMatch(/^Step 2 ·/);
    });
});

/**
 * **M1, confirmed on screen twice: the Wait → Send wire had no chip.** It rendered a bare `·` — on a
 * schedule rule, where it is the canvas's ONLY wire, and on a five-card rule where every other wire
 * reads `lines` / `value` / `yes/no` / `verdict` and this one is a dot.
 *
 * The chip map was a `Record<string, string>` built from four hardcoded port keys and `AuWires`
 * draws `{chip ?? '·'}`, so a fifth port arrived with nothing to say and nothing to say so. Keyed
 * off the port table instead, this is now exhaustive by construction: a missing entry is a `tsc`
 * error, and this test is the runtime half of the same claim.
 */
describe('WIRE_CHIPS', () => {
    /** Every port a wire can leave, read off the port table rather than listed here. */
    const outPorts = STEP_ORDER.flatMap((step) =>
        STEP_PORTS[step].filter((p) => p.dir === 'out').map((p) => `${step}.${p.id}`),
    );

    it('says a real word on every port a wire can leave, the wait step included', () => {
        expect(outPorts).toContain('timer.out');
        for (const key of outPorts) {
            const chip = (WIRE_CHIPS as Record<string, string | undefined>)[key];
            // `AuWires` renders `{chip ?? '·'}`, so an absent entry IS the dot that was reported.
            expect(chip).toBeDefined();
            expect(chip).not.toBe('·');
            expect((chip ?? '').trim().length).toBeGreaterThan(0);
        }
    });

    it('carries no entry for a port no wire leaves', () => {
        expect(Object.keys(WIRE_CHIPS).sort()).toEqual([...outPorts].sort());
    });
});

describe('automationDerive — missing values are marked, not blank', () => {
    it('says what is missing rather than showing an empty row', () => {
        // §07's own node: `Find | nothing to look for`, drawn in the warning colour. A blank row
        // reads as "this step has nothing to configure", which is the opposite of the truth.
        const rule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const empty = {
            ...rule,
            graph: {
                ...rule.graph,
                parse: { ...rule.graph.parse, preset: 'custom' as const, literal: null, find: '' },
                action: { ...rule.graph.action, message: '' },
            },
        };
        expect(stepValues(empty, 'parse').find).toEqual({ text: 'nothing to look for', missing: true });
        expect(stepValues(empty, 'action').message).toEqual({ text: 'nothing to send', missing: true });
        // And a pinned rule with no picks — which no template is, hence the forced `targetMode`
        // on the next line rather than reaching for a template that already has the shape.
        expect(stepValues({ ...empty, targetMode: 'pinned', targetIds: [] }, 'monitor').terminals)
            .toEqual({ text: 'no terminals chosen', missing: true });
    });
});

describe('automationDerive — the palette summary', () => {
    it('describes a webhook-only rule as a post, never a terminal send', () => {
        const { action: _action, ...graph } = draftFromTemplate(AUTOMATION_TEMPLATES[0]).graph;
        const rule = {
            ...draftFromTemplate(AUTOMATION_TEMPLATES[0]),
            graph: {
                ...graph,
                webhook: { provider: 'discord' as const, url: 'https://secret.invalid/hook', body: 'done' },
            },
        };

        expect(ruleSummary(rule)).toBe(
            'Watching command contains "claude" · when the value in ctx:(\\d+)% is greater than 25 · post discord',
        );
        expect(describeRule(rule).verbSend).toBe('post');
    });

    it('describes each template differently, from the same values', () => {
        const summaries = AUTOMATION_TEMPLATES.map((t) => ruleSummary(draftFromTemplate(t)));
        expect(new Set(summaries).size).toBe(AUTOMATION_TEMPLATES.length - 1);
        // And it is the rule's own message, not a label stored beside it.
        for (const template of AUTOMATION_TEMPLATES) {
            const action = template.rule.graph.action;
            if (action) expect(ruleSummary(draftFromTemplate(template))).toContain(action.message);
        }
    });

    /**
     * **The left rail and the node face beside it must not describe two different rules** (§1.1).
     *
     * Three shapes, each of which the rail got wrong in its own direction before it read
     * `condSentence`, so a single case would have caught one of them:
     *
     * - a reading authored in the clause panel leaves `op`/`threshold` null, and the rail read
     *   *"when the value in … is no comparison yet no number yet"* while the face read the clause;
     * - a v1 rule someone added a clause to still carries `op: 'gt'`, and the rail showed the
     *   SUPERSEDED `> 25`;
     * - an event rule with clauses read *"when … appears"* and dropped the clauses entirely.
     *
     * The oracle is `condSentence`'s own output, not a re-spelled copy: the property is that BOTH
     * surfaces read one function, so hard-coding the words here would let them drift while this
     * test stayed green.
     */
    it.each([
        ['a reading authored in the clause panel', 'number' as const, null, null],
        ['a v1 rule that has GAINED a clause', 'number' as const, 'gt' as const, 25],
        ['an event rule with clauses', 'text' as const, null, null],
    ])('summarises %s by its clauses, never by op/threshold', (_label, kind, op, threshold) => {
        const rule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const cond: AutomationCondStep = {
            kind,
            op,
            threshold,
            join: 'and',
            clauses: [{ source: { group: 1 }, test: { number: { op: 'gt', value: 30 } } }],
        };
        const withClause = { ...rule, graph: { ...rule.graph, cond } };
        const summary = ruleSummary(withClause);
        expect(summary).toContain(condSentence(cond));
        expect(summary).toContain('$1 is over 30');
        // None of the three wrong renderings survives: no empty-pair placeholder, no superseded
        // threshold, and the clause is not dropped for an "appears" sentence.
        expect(summary).not.toContain('no comparison yet');
        expect(summary).not.toContain('no number yet');
        expect(summary).not.toContain('25');
        expect(summary).not.toContain('appears');
    });

    it('still summarises a v1 rule with NO clauses by its own comparison', () => {
        // The paired negative: routing every rule through the clause branch would satisfy the
        // table above and break this.
        const rule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const cond: AutomationCondStep = { kind: 'number', op: 'lt', threshold: 5, clauses: [] };
        const summary = ruleSummary({ ...rule, graph: { ...rule.graph, cond } });
        expect(summary).toContain('is less than 5');
    });

    it('names a schedule by its clock and days, never as something watched', () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const rule = {
            ...base,
            graph: { ...base.graph, timer: { mode: { dailyAt: { minuteOfDay: 540, days: 0b0001_1111 } } } },
        };

        const summary = ruleSummary(rule);
        expect(summary).toContain('09:00');
        expect(summary).toContain('weekdays');
        expect(summary).not.toContain('nothing to watch for');
        expect(summary).not.toContain('Watching');
    });

    it('uses the same clock and days in the rail and Settings row for a schedule', () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const rule = {
            ...base,
            graph: { ...base.graph, timer: { mode: { dailyAt: { minuteOfDay: 540, days: 0b0001_1111 } } } },
        };

        const summary = ruleSummary(rule);
        const sentence = describeRule(rule);
        expect(sentence.lead).toBe('at');
        expect(summary).toContain(sentence.subject);
        expect(sentence.subject).toBe('09:00 on weekdays');
    });
});

/**
 * Task 14 — `condSentence` (the full, untruncated sentence `CondPanel`'s `.au-plainsay` shows) and
 * `condFaceText` (the node face's own rendering of it: the sentence while it fits in 34 characters,
 * else a count). Plan 032 §5.9: **a clipped `AND` reads as a different rule**, so the face is never
 * shown half — this is what pins the 34-character cutoff as an exact boundary, not a rough guide.
 */
describe('automationDerive — condSentence / condFaceText (plan 032 §5.9)', () => {
    const clause = (
        source: AutomationClause['source'],
        test: AutomationClause['test'],
    ): AutomationClause => ({ source, test });

    it('joins clauses in words, AND lowercase, exactly like the mockup', () => {
        const cond: AutomationCondStep = {
            kind: 'text',
            clauses: [
                clause({ group: 1 }, { text: { op: 'is', value: '429' } }),
                clause({ group: 2 }, { number: { op: 'gt', value: 60 } }),
            ],
            join: 'and',
        };
        expect(condSentence(cond)).toBe('$1 is 429 and $2 is over 60');
    });

    it('joins with OR, lowercase, when the join is OR', () => {
        const cond: AutomationCondStep = {
            kind: 'text',
            clauses: [
                clause('whole', { text: { op: 'contains', value: 'quota' } }),
                clause({ group: 1 }, { text: { op: 'isNotEmpty', value: '' } }),
            ],
            join: 'or',
        };
        expect(condSentence(cond)).toBe('$0 contains quota or $1 is not empty');
    });

    /** The boundary itself: 27 characters, comfortably under the cutoff, shown in full. */
    it('shows the sentence in full on the face when it is 34 characters or fewer', () => {
        const cond: AutomationCondStep = {
            kind: 'text',
            clauses: [
                clause({ group: 1 }, { text: { op: 'is', value: '429' } }),
                clause({ group: 2 }, { number: { op: 'gt', value: 60 } }),
            ],
            join: 'and',
        };
        expect(condSentence(cond)).toHaveLength(27);
        expect(condFaceText(cond)).toBe(condSentence(cond));
    });

    /**
     * One character past the cutoff — the mutation this pins is `<=` becoming `<` (or vice versa),
     * which a boundary test one character EITHER side of 34 is what actually catches; a sentence
     * that is merely "long" would not.
     */
    it('switches to the count form once the sentence exceeds 34 characters', () => {
        const cond: AutomationCondStep = {
            kind: 'text',
            clauses: [
                clause({ group: 1 }, { text: { op: 'is', value: '429' } }),
                clause({ group: 2 }, { number: { op: 'gt', value: 60 } }),
                clause('whole', { text: { op: 'contains', value: 'quota' } }),
            ],
            join: 'and',
        };
        expect(condSentence(cond).length).toBeGreaterThan(34);
        expect(condFaceText(cond)).toBe('3 comparisons · all must pass');
    });

    it('says "any may pass" for the count form under OR', () => {
        const cond: AutomationCondStep = {
            kind: 'text',
            clauses: [
                clause({ group: 1 }, { text: { op: 'is', value: '429' } }),
                clause({ group: 2 }, { number: { op: 'gt', value: 60 } }),
                clause('whole', { text: { op: 'contains', value: 'quota' } }),
            ],
            join: 'or',
        };
        expect(condFaceText(cond)).toBe('3 comparisons · any may pass');
    });

    it('pluralises the count form correctly for exactly one long clause', () => {
        const cond: AutomationCondStep = {
            kind: 'text',
            clauses: [
                clause('whole', { text: { op: 'matches', value: 'this-is-a-very-long-pattern-value' } }),
            ],
            join: 'and',
        };
        expect(condSentence(cond).length).toBeGreaterThan(34);
        expect(condFaceText(cond)).toBe('1 comparison · all must pass');
    });

    /**
     * The legacy fallback (plan 032 §5.4): a v1 rule that predates the clause list has no clauses
     * at all, but still has its own comparison to show — read from `op`/`threshold`, never written
     * back. This is also what keeps the two "High memory"/"Compact when low" templates' thresholds
     * visible on the face after Task 14's rewrite (`automationPanelsRender.test.tsx`).
     */
    it('falls back to the legacy op/threshold sentence when there are no clauses', () => {
        const cond: AutomationCondStep = { kind: 'number', op: 'gt', threshold: 25 };
        expect(condSentence(cond)).toBe('the value is greater than 25');
        expect(condFaceText(cond)).toBe(condSentence(cond));
    });

    /**
     * The legacy fallback is exempted from the 34-character cutoff — there is no clause COUNT to
     * fall back to for a rule with zero clauses that would not be actively wrong (`0 comparisons`
     * for a rule that is, in fact, comparing something).
     */
    it('never collapses the legacy fallback to a count form, even past 34 characters', () => {
        const cond: AutomationCondStep = { kind: 'number', op: 'gte', threshold: 100_000 };
        expect(condSentence(cond).length).toBeGreaterThan(34);
        expect(condFaceText(cond)).toBe(condSentence(cond));
    });

    it('says the pattern simply matches when there is no clause and no legacy comparison', () => {
        const cond: AutomationCondStep = { kind: 'text', op: null, threshold: null };
        expect(condSentence(cond)).toBe('the pattern matches at all');
        expect(condFaceText(cond)).toBe('the pattern matches at all');
    });

    /**
     * **A READING with no clause and no complete pair is a different rule from an EVENT with
     * neither, and it used to borrow the event's words.**
     *
     * `eval::evaluate` answers `Truth::Unknown` for this shape — evaluated, and unable to fire —
     * so *"the pattern matches at all"* was the opposite of what it does. It is reachable from
     * ordinary authoring: choosing *A reading that stays true* seeds no clause. A table, because
     * a half-filled pair is as blocked as an empty one and only the empty one is obvious.
     * `dry.rs`'s cond row is the third surface and uses the same words.
     */
    it.each([
        ['neither half of the pair', null, null],
        ['an operator but no threshold', 'gt' as const, null],
        ['a threshold but no operator', null, 25],
    ])('says the comparison is unfinished for a reading with %s', (_label, op, threshold) => {
        const cond: AutomationCondStep = { kind: 'number', op, threshold };
        expect(condSentence(cond)).toBe('the comparison is not finished');
        expect(condFaceText(cond)).toBe('the comparison is not finished');
    });
});
