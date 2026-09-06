/**
 * §7.7 — the draft ⇄ row round trip.
 *
 * **The boundary audit's own finding.** The editor's draft and the store's row were two shapes with
 * no stated mapping: `runMode` was not `runsOnce`, and nothing mapped `cfg.monitor.*` onto the
 * targeting columns at all — so a save would have silently defaulted the run mode, the criterion and
 * the entire pick set, reported success, and produced a rule that does nothing
 * (`a-default-parameter-hides-a-dropped-argument`).
 *
 * The resolution was one shared DTO with the store's serde names as the authority, and
 * `draftFromRule`/`ruleFromDraft` as the only place the two meet. This test is what makes a dropped
 * field loud instead of silent: a field added to the rule and forgotten in either direction fails
 * here for all six templates at once.
 */
import {
    AUTOMATION_TEMPLATES,
    blankDraft,
    draftFromTemplate,
} from '../../Settings/Automations/automationTemplates';
import {
    AU_NODE_H,
    DEFAULT_LAYOUT,
    draftFromRule,
    draftReducer,
    isDirty,
    ruleFromDraft,
} from '../automationDraft';
import { problems } from '../automationValidation';
import { STEP_ORDER, canAddStep, defaultWires } from '../automationSteps';

/** The steps an ordinary v1 rule has, and therefore the cards it opens with — the wait is opt-in. */
const WITHOUT_TIMER = STEP_ORDER.filter((s) => s !== 'timer');
import type { AutomationRule } from '../../../types/electron';

/** The wire hop, exactly as `invoke` performs it. */
const overTheWire = (rule: AutomationRule): AutomationRule =>
    JSON.parse(JSON.stringify(rule)) as AutomationRule;

describe('draft ⇄ row', () => {
    const subjects: Array<[string, AutomationRule]> = [
        ...AUTOMATION_TEMPLATES.map((t) => [t.title, draftFromTemplate(t)] as [string, AutomationRule]),
        ['a blank draft', blankDraft()],
    ];

    /**
     * **Idempotence from the first pass, not equality with the template.**
     *
     * A template has never been opened, so it carries no `graph.layout`; opening one materialises
     * the default arrangement into it. That single addition is intended — it is what lets a drag be
     * saved — so asserting `andBack` equals the raw template would now fail for a reason that is not
     * a defect, and "fixing" it by stripping layout before comparing would blind the test to the
     * field entirely.
     *
     * So the property is stated in two halves: the first pass adds `graph.layout` AND NOTHING ELSE
     * (asserted against the template with that one key removed, so any other drift still fails), and
     * every pass after it is identity. The second half is the one that catches a dropped or mangled
     * field, and it is unweakened.
     */
    it.each(subjects)('%s survives draft → wire → row → wire → draft unchanged', (_name, rule) => {
        const there = ruleFromDraft(draftFromRule(overTheWire(rule)));
        const andBack = ruleFromDraft(draftFromRule(overTheWire(there)));
        expect(andBack).toEqual(there);

        expect(there.graph.layout).toEqual(DEFAULT_LAYOUT);
        const { layout: _added, ...graphWithoutLayout } = there.graph;
        expect({ ...there, graph: graphWithoutLayout }).toEqual(rule);
    });

    it('carries every field the DTO declares, not just the ones a template happens to set', () => {
        // A template with `verboseUntil: null` cannot tell a dropped field from a null one. This
        // one sets every optional to a distinctive value.
        const full: AutomationRule = {
            ...draftFromTemplate(AUTOMATION_TEMPLATES[0]),
            id: 'au-round',
            enabled: true,
            runsOnce: true,
            targetMode: 'pinned',
            criterion: 'workingFolderUnder',
            criterionValue: '~/work/termflow',
            followNew: false,
            targetIds: ['tm-a', 'tm-b'],
            completedAt: 1_700_000_000_000,
            verboseUntil: 1_700_000_600_000,
            sortOrder: 7,
            schemaVersion: 1,
            createdAt: 111,
            updatedAt: 222,
            // A layout that is NOT the default, so this also pins that a saved arrangement survives
            // the wire rather than being quietly replaced by `DEFAULT_LAYOUT` on the way through.
            graph: {
                ...draftFromTemplate(AUTOMATION_TEMPLATES[0]).graph,
                // `substitute` is a plan-032 field none of the templates set — pinning it `true`
                // here is what makes a dropped mapping fail this test rather than pass vacuously.
                action: { ...draftFromTemplate(AUTOMATION_TEMPLATES[0]).graph.action, substitute: true },
                // The plan-032 clause list and its join. Both are optional AND both have a default
                // the backend omits from the wire, so a dropped mapping would pass vacuously unless
                // this fixture sets them — and `join` is set to the NON-default `or` for that reason.
                cond: {
                    ...draftFromTemplate(AUTOMATION_TEMPLATES[0]).graph.cond,
                    clauses: [
                        { source: { group: 1 }, test: { text: { op: 'is', value: '429' } } },
                        { source: { group: 2 }, test: { number: { op: 'gt', value: 60 } } },
                        { source: 'whole', test: { text: { op: 'isNotEmpty', value: '' } } },
                        // **A numeric clause with no threshold yet** — the state `CondPanel` mints
                        // the instant a row is switched to a numeric operator, and the one the wire
                        // could not carry: `NaN` has no JSON spelling, so it arrived as `null` and
                        // `Test::Number { value: f64 }` refused the rule. Every other clause here
                        // holds a finite value, so without this row the mapping passes vacuously
                        // over the only shape that ever failed.
                        { source: { group: 1 }, test: { number: { op: 'lt', value: null } } },
                    ],
                    join: 'or',
                },
                // Plan 032 §3.1/§6 — the M3 timer field. A non-default `afterMatch` value, not
                // `undefined`: a fixture carrying the default proves nothing about the mapping.
                timer: { mode: { afterMatch: { delayMs: 30_000 } } },
                layout: {
                    monitor: { x: 11, y: 12 },
                    parse: { x: 21, y: 22 },
                    cond: { x: 31, y: 32 },
                    // Five, since task 23 gave `StepKind` its `'timer'`. Not decoration: `layoutOf`
                    // walks `STEP_ORDER` and fills a missing card in from `DEFAULT_LAYOUT`, so a
                    // four-key fixture would come back five-key and this identity would be
                    // asserting the default rather than the carried value.
                    timer: { x: 51, y: 52 },
                    action: { x: 41, y: 42 },
                },
            },
        };
        // **One deliberate normalisation, and it is not a dropped field.** This fixture carries the
        // v1 `op`/`threshold` pair AND a clause list, because it inherits the pair from template 0
        // and sets clauses of its own — a shape §5.3 forbids on a saved row. `ruleFromDraft` drops
        // the superseded pair from any row that carries clauses, so the round trip is identity
        // everywhere except there. Stated as an explicit expectation rather than by softening the
        // comparison, so a field that goes missing for any OTHER reason still fails here. The pair
        // itself is still pinned as a carried field by the six-template case above, whose rules
        // have no clauses.
        expect(ruleFromDraft(draftFromRule(overTheWire(full)))).toEqual({
            ...full,
            graph: { ...full.graph, cond: { ...full.graph.cond, op: null, threshold: null } },
        });
    });

    /**
     * **A schedule rule, which has NO monitor, parse or cond step at all** (plan 032 §3.1, §6.3).
     *
     * The §7.7 four-places rule cuts both ways: a field that became optional has to survive the
     * round trip while ABSENT, and the failure mode is the quiet one — `draftFromRule` or
     * `ruleFromDraft` filling the hole in from a default would hand the store a rule with an empty
     * pattern, which compiles and matches everything, and nothing in the shape would look wrong.
     *
     * Two halves. The keys must still be **missing** after the wire hop (`JSON.stringify` drops an
     * `undefined` value, so a mapping that wrote `parse: undefined` would look identical to one
     * that dropped it — `'parse' in graph` tells them apart), and the whole rule must come back
     * equal, which is what catches a default being invented.
     */
    it('carries a SCHEDULE rule, which has no monitor, parse or cond step at all', () => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const { monitor: _m, parse: _p, cond: _c, ...graphWithoutInput } = base.graph;
        const schedule: AutomationRule = {
            ...base,
            id: 'au-schedule',
            graph: {
                ...graphWithoutInput,
                // A schedule rule is not merely a rule with holes in it — it fires on the clock.
                timer: { mode: { dailyAt: { minuteOfDay: 9 * 60, days: 0b0001_1111 } } },
            },
        };

        const there = ruleFromDraft(draftFromRule(overTheWire(schedule)));
        expect('monitor' in there.graph).toBe(false);
        expect('parse' in there.graph).toBe(false);
        expect('cond' in there.graph).toBe(false);

        const { layout: _added, ...graphWithoutLayout } = there.graph;
        expect({ ...there, graph: graphWithoutLayout }).toEqual(schedule);
        // And idempotent from there, the same property the templates above are held to.
        expect(ruleFromDraft(draftFromRule(overTheWire(there)))).toEqual(there);
    });

    /**
     * **The arrangement is saved; which cards are drawn is not.** The two used to travel together as
     * "session-only canvas state" and they no longer do, so the line between them is asserted rather
     * than described: `present`/`wires` are re-derived from the four steps and carry no user choice,
     * while a card's POSITION is a choice the user expects to keep.
     *
     * Both directions in one test on purpose. A save that carried `present` would be inventing a
     * schema field; a save that dropped `layout` would put the *Leave without saving?* prompt back to
     * promising "Saving keeps them" over an arrangement it silently discards.
     */
    it('sends the layout, and still does not send which steps are drawn', () => {
        const rule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        // A FRESH canvas, so `present` can be varied without a remove — which no longer exists,
        // and cannot: see `automationSteps.ts`.
        const draft = draftFromRule(rule, 'blank');
        const moved = draftReducer(draft, { type: 'moveStep', step: 'monitor', pos: { x: 999, y: 999 } });
        const grown = draftReducer(moved, { type: 'addStep', step: 'monitor' });

        expect(grown.present).not.toEqual(draft.present);
        expect(ruleFromDraft(grown).graph.layout?.monitor).toEqual({ x: 999, y: 999 });
        // Nothing else moved with it, and no step list rode along.
        const sent = ruleFromDraft(grown) as unknown as Record<string, unknown>;
        expect(sent.present).toBeUndefined();
        expect(sent.wires).toBeUndefined();
        expect(ruleFromDraft(grown).graph.layout?.cond).toEqual(DEFAULT_LAYOUT.cond);
    });
});

/**
 * §5.3 — `op`/`threshold` are v1 only: read at load, folded into `clauses`, **never written
 * again**. The clause list is the condition once there is one, and a row carrying both is a row
 * with two contradictory conditions on it: this build runs the clause, while an older build
 * ignores `clauses` entirely and runs `> 25`.
 */
describe('a v1 rule that gains a clause', () => {
    /** The canonical v1 numeric rule, exactly as a pre-M2 build wrote it. */
    const v1 = (): AutomationRule => {
        const base = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        return {
            ...base,
            graph: { ...base.graph, cond: { kind: 'number', op: 'gt', threshold: 25 } },
        };
    };

    it('stops carrying the superseded op/threshold on the row a save writes', () => {
        const before = ruleFromDraft(draftFromRule(v1())).graph.cond;
        expect(before.op).toBe('gt');
        expect(before.threshold).toBe(25);

        const withClause = draftReducer(draftFromRule(v1()), {
            type: 'clauses',
            clauses: [{ source: { group: 1 }, test: { number: { op: 'lt', value: 90 } } }],
        });
        // What a SAVE writes — `ruleFromDraft`, not `draft.rule` — and after the wire hop, which
        // is where `skip_serializing_if = "Option::is_none"` decides whether the pair is re-written.
        const saved = overTheWire(ruleFromDraft(withClause)).graph.cond;
        expect(saved.clauses).toHaveLength(1);
        expect(saved.op ?? null).toBeNull();
        expect(saved.threshold ?? null).toBeNull();
    });

    it('keeps them when the clause list goes back to empty', () => {
        // The paired negative, and the reason the clearing is conditional: removing the last clause
        // from a v1 rule must leave it the rule it was, not silently strip its only comparison and
        // turn it into one that fires on every match.
        //
        // **Through the real ADD-then-REMOVE sequence.** This test used to dispatch `{ clauses: [] }`
        // against a fresh draft, which never visits the state the defect lives in — a draft that
        // HAS held clauses and no longer does. `+ Add a comparison` nulled the pair on the way in
        // and `Remove comparison 1` could not put it back, so the rule was blocked and would have
        // been saved with its only comparison gone.
        const added = draftReducer(draftFromRule(v1()), {
            type: 'clauses',
            clauses: [{ source: { group: 1 }, test: { number: { op: 'lt', value: 90 } } }],
        });
        const emptied = draftReducer(added, { type: 'clauses', clauses: [] });
        const saved = overTheWire(ruleFromDraft(emptied)).graph.cond;
        expect(saved.clauses ?? []).toEqual([]);
        expect(saved.op).toBe('gt');
        expect(saved.threshold).toBe(25);
        // The user-visible consequence, and the one that reaches the store: removing the final
        // clause preserves the v1 comparison, so this row is not blocked as `cond.incomplete`.
        expect(problems(ruleFromDraft(emptied)).map((p) => p.code)).not.toContain('cond.incomplete');
    });
});

describe('draftFromRule', () => {
    /**
     * What `AutomationMenuSection`'s `newDraftFor` hands the host for "New automation for this
     * terminal": `blankDraft()` with the targeting overwritten and nothing else touched.
     */
    const seededRule = () => ({
        ...blankDraft(),
        targetMode: 'pinned' as const,
        targetIds: ['tm-9'],
    });

    it('draws the four ordinary steps a template or an existing rule has', () => {
        const draft = draftFromRule(draftFromTemplate(AUTOMATION_TEMPLATES[0]));
        expect(draft.present).toEqual(WITHOUT_TIMER);
        expect(draft.wires).toEqual(defaultWires(WITHOUT_TIMER));
        expect(draft.layout).toEqual(DEFAULT_LAYOUT);
        expect(draft.selected).toBe('monitor');
    });

    /**
     * **Every step is drawn exactly when the rule HAS it, the wait included.**
     *
     * The wait used to be the sole exception to *"draw all four whatever the graph holds"*, and
     * the reason it had to be is the reason the exception became the rule: `canAddStep` refuses a
     * step that is already present, so a card drawn for an absent step closes the palette's only
     * route to adding one. That was true of the wait on every rule ever written, and true of
     * monitor/parse/cond on a schedule rule — which is the half task 29 fixed.
     */
    it('draws the wait step exactly when the rule has one', () => {
        const withWait = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        withWait.graph.timer = { mode: { afterMatch: { delayMs: 30_000 } } };
        const draft = draftFromRule(withWait);
        expect(draft.present).toEqual([...STEP_ORDER]);
        expect(draft.wires).toEqual(defaultWires(STEP_ORDER, 'afterMatch'));
        expect(canAddStep(draft.present, 'timer')).not.toBeNull();

        // And without one, the palette can still offer it.
        expect(canAddStep(draftFromRule(draftFromTemplate(AUTOMATION_TEMPLATES[0])).present, 'timer'))
            .toBeNull();
    });

    /**
     * A SCHEDULE rule draws its clock and its send, and the three steps it does not have (§6.3).
     * The wires it draws are the one wire that shape runs on — a monitor → read → compare chain
     * beside the clock would be a picture of three steps the engine skips on every tick.
     */
    it('draws a schedule rule with the one wire that shape runs on', () => {
        const schedule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        schedule.graph.timer = { mode: { dailyAt: { minuteOfDay: 540, days: 0b0001_1111 } } };
        const draft = draftFromRule(schedule);
        expect(draft.present).toEqual([...STEP_ORDER]);
        expect(draft.wires.map((w) => `${w.from.step}.${w.from.port}->${w.to.step}.${w.to.port}`))
            .toEqual(['timer.out->action.in']);
    });

    /**
     * **Task 29, the READ direction: `present` and the graph agree about which steps a rule has.**
     *
     * `draftFromRule` used to draw all four original steps for any saved rule whatever its graph
     * held, on a premise written in `automationSteps.ts` — *"a rule's graph carries all four steps
     * whatever is drawn"* — that §3.1 made false. Two reviewers reported the two halves of it
     * separately: three dead cards whose panels return `null`, and a saved schedule rule that can
     * never have `monitor`/`parse`/`cond` added back, because `canAddStep` refuses each one as
     * *"already has"* while `graph.monitor` is absent.
     *
     * Mutation M-a: revert the `'saved'` arm to the unconditional
     * `STEP_ORDER.filter((s) => s !== 'timer' || rule.graph.timer != null)` → this dies, and the
     * ordinary-rule test below must not.
     */
    it('draws only the steps a saved schedule rule actually has', () => {
        const { monitor: _m, parse: _p, cond: _c, ...graph } = draftFromTemplate(
            AUTOMATION_TEMPLATES[0],
        ).graph;
        const draft = draftFromRule({
            ...draftFromTemplate(AUTOMATION_TEMPLATES[0]),
            graph: { ...graph, timer: { mode: { dailyAt: { minuteOfDay: 540, days: 0b0001_1111 } } } },
        });
        expect(draft.present).toEqual(['timer', 'action']);
        expect(draft.wires.map((w) => `${w.from.step}.${w.from.port}->${w.to.step}.${w.to.port}`))
            .toEqual(['timer.out->action.in']);
    });

    /**
     * **The case R1 must NOT move**, and it is every rule that exists today: an ordinary v1 rule
     * has all four original steps in its graph, so it goes on opening with all four cards and no
     * wait card. Without this the regression is invisible — the only rule whose behaviour the
     * change touches is one that genuinely lacks a step.
     */
    it('still draws all four cards for an ordinary saved rule, and no wait card', () => {
        const draft = draftFromRule(draftFromTemplate(AUTOMATION_TEMPLATES[0]));
        expect(draft.present).toEqual(WITHOUT_TIMER);
        expect(canAddStep(draft.present, 'timer')).toBeNull();
    });

    /**
     * **R2 — `addStep` materialises whatever it reveals, and the input steps materialise as a
     * GROUP.** The reasoning written at the timer branch — *"revealing a card over nothing would
     * give the panel no step to bind to and the save nothing to write"* — is a fact about absence,
     * not about timers, and after R1 monitor/parse/cond can be absent too.
     *
     * The group half is the same all-or-nothing contract `ruleFromDraft` and `eval::InputSteps::of`
     * keep: filling in only the card that was revealed writes an incomplete graph. It can remain a
     * disabled draft while the user completes it, but `timer.neverRuns` blocks a new enabled write
     * once the rule has a message.
     *
     * Mutation M-b: narrow the materialisation back to `action.step === 'timer'` → this dies.
     */
    it('fills in the graph for a revealed input step, all three of them', () => {
        const { monitor: _m, parse: _p, cond: _c, ...graph } = draftFromTemplate(
            AUTOMATION_TEMPLATES[0],
        ).graph;
        const schedule = draftFromRule({
            ...draftFromTemplate(AUTOMATION_TEMPLATES[0]),
            graph: { ...graph, timer: { mode: { afterMatch: { delayMs: 30_000 } } } },
        });
        expect(schedule.rule.graph.parse).toBeUndefined();

        const added = draftReducer(schedule, { type: 'addStep', step: 'parse' });
        expect(added.rule.graph.parse).not.toBeNull();
        expect(added.rule.graph.parse).toBeDefined();
        expect(added.rule.graph.monitor).toBeDefined();
        expect(added.rule.graph.cond).toBeDefined();
        // The CARD the user asked for, and only that one — the graph is all-or-nothing, the canvas
        // is not.
        expect(added.present).toEqual(['parse', 'timer', 'action']);
        // Sourced from `blankDraft()`, never from a second set of defaults written here.
        expect(added.rule.graph.parse).toEqual(blankDraft().graph.parse);
    });

    /**
     * **T4-c / M3: a click-added card must not land on top of one that is already there.**
     *
     * `addStep` never consulted `draft.layout`, so a new card took `DEFAULT_LAYOUT`'s slot whatever
     * was standing in it. A template does not reproduce it — a template carries no persisted
     * `graph.layout`, so `layoutOf` answers `DEFAULT_LAYOUT`, where `action` has already moved out
     * of the wait's column. It takes a rule whose arrangement was SAVED with a card in that slot:
     * either a layout persisted before `timer` was inserted at the fourth position, or — needing no
     * upgrade at all — any card the user dragged there and saved.
     *
     * Asserted as *clear of the other card*, not merely *not equal*: two positions one pixel apart
     * are two cards on top of each other.
     */
    it('places a new card clear of one already standing in its default slot', () => {
        const rule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        rule.graph.layout = { ...DEFAULT_LAYOUT, action: { ...DEFAULT_LAYOUT.timer } };
        const draft = draftFromRule(rule);
        // The premise: the send really is sitting where a wait card would be placed.
        expect(draft.layout.action).toEqual(DEFAULT_LAYOUT.timer);

        const added = draftReducer(draft, { type: 'addStep', step: 'timer' });
        expect(added.layout.timer).not.toEqual(added.layout.action);
        expect(Math.abs(added.layout.timer.y - added.layout.action.y))
            .toBeGreaterThanOrEqual(AU_NODE_H);
    });

    /** And the case it must not move: nothing in the way, so the canonical slot is kept. */
    it('leaves a new card in its default slot when nothing is standing there', () => {
        const draft = draftFromRule(draftFromTemplate(AUTOMATION_TEMPLATES[0]));
        const added = draftReducer(draft, { type: 'addStep', step: 'timer' });
        expect(added.layout.timer).toEqual(DEFAULT_LAYOUT.timer);
    });

    it('draws NOTHING for a brand-new rule', () => {
        // Mockup §03's third state: an empty canvas and the "Start with Watch output" hint, so
        // building one from nothing is a thing the palette teaches rather than a thing that has
        // already happened.
        const draft = draftFromRule(blankDraft(), 'blank');
        expect(draft.present).toEqual([]);
        expect(draft.wires).toEqual([]);
        expect(draft.selected).toBeNull();
    });

    /**
     * **The third opening — "New automation for this terminal" — and the two things it does that
     * neither of the two above does.**
     *
     * The menu hands over a rule that already pins the terminal the user right-clicked, and this
     * used to open on `'blank'`: an empty canvas, nothing selected, and a draft whose baseline was
     * itself. Both halves of that were wrong in the same direction — the one decision that HAD been
     * made was the one thing nothing on screen said. The canvas showed the "Start with Watch
     * output" hint for a step that was already configured, and Escape threw the pinned terminal
     * away without a prompt, because a draft compared against itself reads clean.
     *
     * Asserted as a pair with the `'blank'` case above rather than on its own: the two differ in
     * exactly these fields, and a `draftFromRule` that ignored its second argument would satisfy
     * either test alone.
     */
    it('draws the one step a SEEDED rule already has, and selects it', () => {
        const draft = draftFromRule(seededRule(), 'seeded');
        expect(draft.present).toEqual(['monitor']);
        // One step wires to nothing — the palette is still how the other three arrive.
        expect(draft.wires).toEqual([]);
        // The whole point: the inspector opens on *Watch output* with the terminal already ticked,
        // rather than one palette drag away from being noticed.
        expect(draft.selected).toBe('monitor');
        /**
         * **And the RULE itself, absolutely — every other assertion in this describe is about the
         * canvas.** `present`/`wires`/`selected` say what is drawn; none of them says the rule
         * being drawn is still the one the menu handed over. A `draftFromRule` that rewrote
         * `targetMode` to `'rule'` on the seeded path satisfied all of them, and all 369 automation
         * tests, while reproducing the exact defect this opening exists to fix: MonitorPanel then
         * renders the criterion UI, and the terminal the user right-clicked is nowhere on screen.
         *
         * Spelled out from `seededRule()` rather than compared against `draft.rule`'s own fields,
         * so the oracle cannot move with the implementation. The layout is the one licensed
         * difference: `draftFromRule` resolves it for a rule that predates the field.
         */
        expect(draft.rule).toEqual({
            ...seededRule(),
            graph: { ...seededRule().graph, layout: DEFAULT_LAYOUT },
        });
    });

    it('opens a SEEDED rule dirty, against a baseline that differs only in the seeded pick', () => {
        const draft = draftFromRule(seededRule(), 'seeded');
        expect(isDirty(draft)).toBe(true);
        /**
         * Not merely "new rules are always dirty": the baseline names WHAT is unsaved, which is
         * what makes *"Saving keeps them; leaving throws them away"* a true sentence here.
         *
         * **Stated from the UNSEEDED starting point, not as `{ ...draft.rule, targetIds: [] }`.**
         * That form restates the implementation's own formula, so the promise this comment used to
         * make — that a future seeding contributing a second field would fail here — was one it
         * could not keep: both sides would move together and the test would stay green while the
         * dirty check silently stopped reporting the new field. Anchored to `blankDraft()`, a
         * second seeded field has to be written down here or the equality breaks.
         */
        expect(draft.saved).toEqual({
            ...blankDraft(),
            targetMode: 'pinned',
            targetIds: [],
            graph: { ...blankDraft().graph, layout: DEFAULT_LAYOUT },
        });
    });

    it('a SEEDED draft goes clean when the save lands', () => {
        const draft = draftFromRule(seededRule(), 'seeded');
        const stored = { ...ruleFromDraft(draft), id: 'r-minted' };
        expect(isDirty(draftReducer(draft, { type: 'saved', rule: stored }))).toBe(false);
    });

    it('a SEEDED draft goes clean if the seeded terminal is unticked', () => {
        // The paired negative for the baseline, and the honest consequence of it: the prompt is
        // about the PICK, not about the rule being new. Untick the terminal the menu added and
        // change nothing else and there is nothing UNSAVED left to warn about — not something to
        // hold a *Leave without saving?* dialog over.
        const draft = draftFromRule(seededRule(), 'seeded');
        const off = draftReducer(draft, { type: 'toggleTarget', id: 'tm-9' });
        expect(off.rule.targetIds).toEqual([]);
        expect(isDirty(off)).toBe(false);
    });

    it('…but that is not the same as being back at a blank rule, and the editor still says so', () => {
        /**
         * The sentence this pins used to read *"you are looking at an untouched blank rule"*, in
         * both the test above and `draftFromRule`'s own doc. It is false, and the difference is
         * visible to the user: `newDraftFor` contributes `targetMode: 'pinned'` as well as the
         * pick, and the baseline drops only the pick — so what is on screen after the untick is a
         * PINNED rule watching nothing, which `problems()` blocks the save on, while `blankDraft()`
         * is `'rule'`/`allTerminals` and has no problem at all.
         *
         * "Nothing unsaved" and "ready to save" are two different questions. The dirty check
         * answers only the first, and this is the test that stops the comment claiming otherwise.
         */
        const draft = draftFromRule(seededRule(), 'seeded');
        const off = draftReducer(draft, { type: 'toggleTarget', id: 'tm-9' });

        expect(off.rule.targetMode).toBe('pinned');
        expect(blankDraft().targetMode).toBe('rule');
        expect(problems(off.rule).some((p) => p.code === 'targets.empty')).toBe(true);
        expect(problems(blankDraft()).some((p) => p.code === 'targets.empty')).toBe(false);
    });

    /**
     * **The fourth opening — a template picked from the gallery.**
     *
     * Tam: *"click New automation -> select predefined template -> it should become Unsaved, when
     * user close it should show confirmation"*. The gallery handed a picked template to the editor
     * on `'saved'`, whose baseline is the rule itself, so it read CLEAN and Escape threw the chosen
     * template away without a word. That is the `'seeded'` defect again, one card to the left: a
     * choice had been made, and nothing on the way out said so.
     *
     * The baseline is the blank rule the gallery was showing BEFORE the click, which makes the whole
     * template the unsaved work — because that is what it is.
     */
    it('opens a picked TEMPLATE dirty, against the blank rule the gallery started from', () => {
        const draft = draftFromRule(draftFromTemplate(AUTOMATION_TEMPLATES[0]), 'template');
        expect(isDirty(draft)).toBe(true);
        expect(draft.saved).toEqual({
            ...blankDraft(),
            graph: { ...blankDraft().graph, layout: DEFAULT_LAYOUT },
        });
    });

    it('every template opens dirty, not just the first', () => {
        // A one-template check is satisfied by a baseline that happens to differ from THAT rule;
        // the claim is about the opening, so it is asserted over the whole gallery.
        for (const template of AUTOMATION_TEMPLATES) {
            expect(isDirty(draftFromRule(draftFromTemplate(template), 'template'))).toBe(true);
        }
    });

    it('a TEMPLATE draws the four ordinary steps it has, like the complete rule it is', () => {
        const rule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const draft = draftFromRule(rule, 'template');
        expect(draft.present).toEqual(WITHOUT_TIMER);
        expect(draft.wires).toEqual(defaultWires(WITHOUT_TIMER));
        expect(draft.selected).toBe('monitor');
        // The RULE, absolutely — for the reason the seeded oracle is absolute: `present`/`wires`/
        // `selected` are all about the canvas, and none of them would notice this opening quietly
        // rewriting a field of the template on its way through.
        expect(draft.rule).toEqual({ ...rule, graph: { ...rule.graph, layout: DEFAULT_LAYOUT } });
    });

    it('a TEMPLATE goes clean when the save lands', () => {
        const draft = draftFromRule(draftFromTemplate(AUTOMATION_TEMPLATES[0]), 'template');
        const stored = { ...ruleFromDraft(draft), id: 'r-minted' };
        expect(isDirty(draftReducer(draft, { type: 'saved', rule: stored }))).toBe(false);
    });

    it("the 'saved' opening is clean, whatever rule it opened on", () => {
        // Templates used here as fixtures for "a complete rule" — this is the path an EXISTING rule
        // takes out of the Settings list, NOT the path the gallery takes. A picked template goes
        // through `'template'` and opens dirty; see above. The name of this test said "whatever it
        // opened ON", which was read as "whatever opening", and that reading is now false.
        for (const [, rule] of AUTOMATION_TEMPLATES.map((t) => ['', draftFromTemplate(t)] as const)) {
            expect(isDirty(draftFromRule(rule))).toBe(false);
        }
        // …and the blank card, the other opening that must not nag.
        expect(isDirty(draftFromRule(blankDraft(), 'blank'))).toBe(false);
    });
});

describe('isDirty', () => {
    const draft = () => draftFromRule(draftFromTemplate(AUTOMATION_TEMPLATES[0]));

    it('is a comparison, not a flag — an edit undone is not dirty', () => {
        // A boolean set by every edit keeps saying "unsaved" after the change is undone, so a user
        // who types a character and deletes it is offered a dialog about nothing.
        const named = draftReducer(draft(), { type: 'name', name: 'Something else' });
        expect(isDirty(named)).toBe(true);
        const back = draftReducer(named, { type: 'name', name: draft().rule.name });
        expect(isDirty(back)).toBe(false);
    });

    /**
     * **A canvas move is a change.** This assertion used to be `false`, on the reasoning that the
     * prompt should not appear "for a change that cannot be saved and cannot be lost" — sound while
     * the layout went nowhere, and exactly backwards once it does: the change could be lost, and
     * silently, which is the case the prompt exists for.
     *
     * Paired with the undo, so this cannot pass as "dirty forever after any move".
     */
    it('counts a canvas move as unsaved work', () => {
        const start = draft();
        const moved = draftReducer(start, { type: 'moveStep', step: 'cond', pos: { x: 40, y: 40 } });
        expect(isDirty(moved)).toBe(true);

        const back = draftReducer(moved, {
            type: 'moveStep',
            step: 'cond',
            pos: start.layout.cond,
        });
        expect(isDirty(back)).toBe(false);
    });

    /** A rule reopened on its own saved arrangement is not dirty just for having one. */
    it('is not dirty when a rule opens on the layout it was saved with', () => {
        const arranged = {
            ...draftFromTemplate(AUTOMATION_TEMPLATES[0]),
            graph: {
                ...draftFromTemplate(AUTOMATION_TEMPLATES[0]).graph,
                layout: { ...DEFAULT_LAYOUT, cond: { x: 77, y: 88 } },
            },
        };
        const reopened = draftFromRule(arranged);
        expect(reopened.layout.cond).toEqual({ x: 77, y: 88 });
        expect(isDirty(reopened)).toBe(false);
    });

    it('is cleared by a save, and adopts the id the store minted', () => {
        // The P0. `save_rule` INSERTs the id verbatim, so a draft saved with `id: ''` becomes a row
        // keyed on the empty string — and without adopting the minted id back, the NEXT save mints
        // a second one and one draft becomes two rows.
        const edited = draftReducer(draft(), { type: 'name', name: 'Mine' });
        expect(edited.rule.id).toBe('');
        const saved = draftReducer(edited, {
            type: 'saved',
            rule: { ...edited.rule, id: 'au-minted' },
        });
        expect(saved.rule.id).toBe('au-minted');
        expect(saved.saved.id).toBe('au-minted');
        expect(isDirty(saved)).toBe(false);
    });

    it('does NOT discard a keystroke that landed while the save was in flight', () => {
        // `save()` sends the draft as it was when the button was pressed and dispatches `saved` when
        // the promise resolves. Replacing the draft with the SENT rule at that point overwrites
        // whatever the user typed in between — the save's own echo, arriving after their newer
        // text, with no error and no way to notice except by re-reading the field.
        const start = draft();
        const sent = draftReducer(start, { type: 'name', name: 'First' }).rule;

        // ... the user keeps typing while the write is in flight ...
        const stillTyping = draftReducer(
            draftReducer(start, { type: 'name', name: 'First' }),
            { type: 'name', name: 'First and second' },
        );

        const settled = draftReducer(stillTyping, { type: 'saved', rule: sent });
        expect(settled.rule.name).toBe('First and second');
        // And it still reads as dirty, because the newer text genuinely has not been saved.
        expect(isDirty(settled)).toBe(true);
        expect(settled.saved.name).toBe('First');
    });

    it("an enable that went to the store on its own clears only that field's dirtiness", () => {
        // The header toggle calls `set_automation_enabled`, which writes one column and returns.
        // Marking the WHOLE draft clean would tell the navigation guard there is nothing to lose
        // while the user's other edits sit in memory.
        const edited = draftReducer(draft(), { type: 'name', name: 'Mine' });
        const enabled = draftReducer(edited, { type: 'enabled', enabled: true, persisted: true });
        expect(enabled.rule.enabled).toBe(true);
        expect(enabled.saved.enabled).toBe(true);
        expect(isDirty(enabled)).toBe(true);
        expect(enabled.rule.name).toBe('Mine');

        // And an ordinary in-editor toggle (no `persisted`) IS dirty, which is the paired case.
        const localOnly = draftReducer(draft(), { type: 'enabled', enabled: true });
        expect(isDirty(localOnly)).toBe(true);
    });
});

describe('the reducer', () => {
    const draft = () => draftFromRule(blankDraft(), 'blank');

    it('keeps steps in canonical order whatever order they were dropped in', () => {
        let d = draft();
        for (const step of ['action', 'monitor', 'cond', 'parse'] as const) {
            d = draftReducer(d, { type: 'addStep', step });
        }
        expect(d.present).toEqual(WITHOUT_TIMER);
        // And the wires follow, rather than being appended in drop order.
        expect(d.wires).toEqual(defaultWires(WITHOUT_TIMER));

        // The wait step drops in fifth wherever it is dropped, and re-draws the chain THROUGH it.
        d = draftReducer(d, { type: 'addStep', step: 'timer' });
        expect(d.present).toEqual([...STEP_ORDER]);
        expect(d.wires).toEqual(defaultWires(STEP_ORDER, 'afterMatch'));
    });

    /**
     * **The canvas follows the mode, and only the reducer can make it.**
     *
     * `wires` is re-derived on open and on `addStep`, and nowhere else — so before this case
     * existed, switching a finished rule to a schedule left the canvas drawing the delay's whole
     * chain over a rule that no longer reads anything. The picture and the rule are the one thing
     * `defaultWires`' own header promises cannot disagree.
     */
    it('re-draws the wires when the wait switches mode', () => {
        const rule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        rule.graph.timer = { mode: { afterMatch: { delayMs: 30_000 } } };
        const opened = draftFromRule(rule);
        expect(opened.wires).toEqual(defaultWires(STEP_ORDER, 'afterMatch'));

        const scheduled = draftReducer(opened, {
            type: 'timer',
            mode: { dailyAt: { minuteOfDay: 540, days: 0b0001_1111 } },
        });
        expect(scheduled.rule.graph.timer).toEqual({
            mode: { dailyAt: { minuteOfDay: 540, days: 0b0001_1111 } },
        });
        expect(scheduled.wires).toEqual(defaultWires(STEP_ORDER, 'dailyAt'));

        // And back, so this is a re-derivation rather than a one-way collapse.
        const back = draftReducer(scheduled, { type: 'timer', mode: { afterMatch: { delayMs: 5_000 } } });
        expect(back.wires).toEqual(defaultWires(STEP_ORDER, 'afterMatch'));
    });

    /**
     * A patch to a step the rule does not have is a no-op, never a materialisation — the same
     * discipline the monitor/parse/cond cases follow. The palette's `addStep` is the one route that
     * adds a wait, and it is explicit about it.
     */
    it('ignores a mode change on a rule with no wait step', () => {
        const rule = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        const opened = draftFromRule(rule);
        const after = draftReducer(opened, { type: 'timer', mode: { afterMatch: { delayMs: 5_000 } } });
        expect(after).toBe(opened);
        expect(after.rule.graph.timer).toBeUndefined();
    });

    /**
     * **Adding the wait card writes the step into the rule.** Every other `addStep` is
     * presentation-only, because `blankDraft()` already carries a monitor, a parse, a cond and an
     * action — the card is revealed over a field that exists. `graph.timer` is absent by design on
     * a rule that does not use one (§3.1), so a reveal with no write would give the panel no step
     * to bind to, leave the save nothing to write, and put a card on the canvas that the rule does
     * not have.
     */
    it('writes a wait step into the rule when its card is added, and leaves it alone after', () => {
        const empty = draft();
        expect(empty.rule.graph.timer).toBeUndefined();

        const added = draftReducer(empty, { type: 'addStep', step: 'timer' });
        expect(added.rule.graph.timer).toEqual({ mode: { afterMatch: { delayMs: 30_000 } } });
        // A wait is only a wait if it is long enough to be one, and short enough to survive the
        // session — the card must not be born blocked.
        expect(problems(added.rule).some((p) => p.field === 'timer')).toBe(false);

        // And a rule that already has one keeps ITS value: re-adding is a no-op, and so is adding
        // the card back to a rule whose graph still carries the step.
        const edited = {
            ...added,
            rule: { ...added.rule, graph: { ...added.rule.graph, timer: { mode: { afterMatch: { delayMs: 90_000 } } } } },
        };
        expect(draftReducer(edited, { type: 'addStep', step: 'timer' }).rule.graph.timer)
            .toEqual({ mode: { afterMatch: { delayMs: 90_000 } } });
    });

    it('re-derives the wires as steps are added, rather than appending in drop order', () => {
        // Built in the order the palette enforces — `canAddStep` gates the gesture, and the
        // reducer trusts it, so arranging an order the palette refuses would be testing a state the
        // editor cannot reach.
        const fresh = draftFromRule(draftFromTemplate(AUTOMATION_TEMPLATES[0]), 'blank');
        const one = draftReducer(fresh, { type: 'addStep', step: 'monitor' });
        expect(one.wires).toEqual([]);
        const two = draftReducer(one, { type: 'addStep', step: 'parse' });
        expect(two.wires).toEqual(defaultWires(['monitor', 'parse']));
        const three = draftReducer(two, { type: 'addStep', step: 'cond' });
        expect(three.wires).toEqual(defaultWires(['monitor', 'parse', 'cond']));
        expect(three.wires.some((w) => w.to.step === 'action')).toBe(false);
    });

    it('is not dirty when a target set comes back to where it started', () => {
        // `toggleTarget` APPENDS, so unticking a terminal and ticking it straight back rotates the
        // array: ['tm-1','tm-2'] becomes ['tm-2','tm-1']. `targetIds` is a SET — `write_rule`
        // replaces the pick set row by row and the engine resolves it with a lookup — so nothing
        // downstream can tell those apart, but `JSON.stringify` could, and the draft then read dirty
        // forever with a *Leave without saving?* dialog over an identical rule.
        const base = draftFromRule({
            ...draftFromTemplate(AUTOMATION_TEMPLATES[0]),
            targetMode: 'pinned',
            targetIds: ['tm-1', 'tm-2'],
        });
        expect(isDirty(base)).toBe(false);

        const off = draftReducer(base, { type: 'toggleTarget', id: 'tm-1' });
        expect(isDirty(off)).toBe(true);

        const back = draftReducer(off, { type: 'toggleTarget', id: 'tm-1' });
        expect(back.rule.targetIds).toEqual(['tm-2', 'tm-1']);
        expect(isDirty(back)).toBe(false);

        // And the normalisation is for the COMPARISON only — what a save sends is still the user's
        // own array, not a sorted copy.
        expect(ruleFromDraft(back).targetIds).toEqual(['tm-2', 'tm-1']);
    });

    it('IS dirty when the target set really changes', () => {
        // The paired positive: sorting both sides could have been written as sorting nothing.
        const base = draftFromRule({
            ...draftFromTemplate(AUTOMATION_TEMPLATES[0]),
            targetMode: 'pinned',
            targetIds: ['tm-1', 'tm-2'],
        });
        expect(isDirty(draftReducer(base, { type: 'toggleTarget', id: 'tm-3' }))).toBe(true);
        expect(isDirty(draftReducer(base, { type: 'targets', ids: ['tm-2'] }))).toBe(true);
    });

    it('toggles a target without disturbing the others', () => {
        let d = draftFromRule({ ...blankDraft(), targetIds: ['tm-a', 'tm-b'] });
        d = draftReducer(d, { type: 'toggleTarget', id: 'tm-a' });
        expect(d.rule.targetIds).toEqual(['tm-b']);
        d = draftReducer(d, { type: 'toggleTarget', id: 'tm-c' });
        expect(d.rule.targetIds).toEqual(['tm-b', 'tm-c']);
    });
});
