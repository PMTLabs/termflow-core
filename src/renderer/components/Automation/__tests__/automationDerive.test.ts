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
import { faceFor, panelFor, ruleSummary, stateFor, stepValues } from '../automationDerive';
import type { DeriveContext } from '../automationDerive';
import { problems } from '../automationValidation';
import { STEP_ORDER } from '../automationSteps';
import type { StepKind } from '../automationSteps';
import { displayedPattern } from '../automationPresets';

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
