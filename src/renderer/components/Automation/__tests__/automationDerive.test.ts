/**
 * §10.20 — the six-template table, asserted through **both renderers**.
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
    condFaceText,
    condSentence,
    faceFor,
    panelFor,
    ruleSummary,
    stateFor,
    stepValues,
} from '../automationDerive';
import type { DeriveContext } from '../automationDerive';
import { problems } from '../automationValidation';
import { STEP_ORDER } from '../automationSteps';
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
            const shown = displayedPattern(parse);
            expect(faceText(rule, 'parse')).toContain(shown);
            expect(panelText(rule, 'parse')).toContain(shown);

            // --- the threshold -------------------------------------------------------------------
            if (cond.kind === 'number' && cond.threshold !== null && cond.threshold !== undefined) {
                expect(faceText(rule, 'cond')).toContain(String(cond.threshold));
                expect(panelText(rule, 'cond')).toContain(String(cond.threshold));
            }

            // --- the message ---------------------------------------------------------------------
            expect(faceText(rule, 'action')).toContain(action.message);
            expect(panelText(rule, 'action')).toContain(action.message);
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
            pairs: { 'tm-a': { state: 'fired', lastFiredAt: NOW - 1000, firedCount: 1, missing: false } },
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
            pairs: { 'tm-a': { state: 'unseen', lastFiredAt: null, firedCount: 0, missing: false } },
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
            pairs: { 'tm-a': { state: 'fired', lastFiredAt: NOW, firedCount: 1, missing: false } },
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
    it('describes each template differently, from the same values', () => {
        const summaries = AUTOMATION_TEMPLATES.map((t) => ruleSummary(draftFromTemplate(t)));
        expect(new Set(summaries).size).toBe(AUTOMATION_TEMPLATES.length);
        // And it is the rule's own message, not a label stored beside it.
        for (const template of AUTOMATION_TEMPLATES) {
            expect(ruleSummary(draftFromTemplate(template))).toContain(template.rule.graph.action.message);
        }
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
});
