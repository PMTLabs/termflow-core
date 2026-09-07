/**
 * §10.26 — the ten built-in templates.
 *
 * Exactly ten, unique ids and titles, every draft pointed at **no terminals**, and each template's
 * values different from every other's. That last one is the guard against the failure mode this
 * whole feature's design keeps circling: a table of ten entries that are secretly one entry copied
 * ten times, which passes every per-item assertion and ships a gallery of identical rules.
 *
 * *(Plan §10.26 says "empty `monitor.ids`". The DTO settled targeting as `rule.targetIds` — ids are
 * columns, not part of the graph blob — so that is the field asserted; the plan is corrected in
 * place.)*
 */
import { AUTOMATION_TEMPLATES, blankDraft, draftFromTemplate } from '../automationTemplates';
import type { AutomationTemplate } from '../automationTemplates';

const byId = (id: string): AutomationTemplate => {
    const template = AUTOMATION_TEMPLATES.find((t) => t.id === id);
    if (!template) throw new Error(`Missing template: ${id}`);
    return template;
};

describe('AUTOMATION_TEMPLATES', () => {
    it('has exactly ten, with unique ids and unique titles', () => {
        expect(AUTOMATION_TEMPLATES).toHaveLength(10);
        expect(new Set(AUTOMATION_TEMPLATES.map((t) => t.id)).size).toBe(10);
        expect(new Set(AUTOMATION_TEMPLATES.map((t) => t.title)).size).toBe(10);
    });

    it('names the fields you will change on every card', () => {
        // Picking a card is a decision you make from the gallery without opening it first, which is
        // only true if every card says what is yours to fill in.
        for (const t of AUTOMATION_TEMPLATES) {
            expect(t.youllChange.length).toBeGreaterThan(0);
            expect(t.why.length).toBeGreaterThan(20);
        }
    });

    it('gives every draft NO pinned terminals, and lands it switched off', () => {
        // Which terminals to watch is never a sensible default (decision 13), so the draft arrives
        // with an empty pick set — and targets by CRITERION, which is a complete choice rather than
        // a gap. `enabled: false` is the safety property here, not validation: nothing a template
        // does can happen without one deliberate act.
        //
        // This test used to be named "...so a fresh template has exactly one problem left", which is
        // false for all six and was asserted nowhere. `automationValidation.test.ts` now asserts the
        // truth, and the paired positive beside it — that a PINNED rule with no picks does block.
        for (const t of AUTOMATION_TEMPLATES) {
            const draft = draftFromTemplate(t);
            expect(draft.targetIds).toEqual([]);
            expect(draft.enabled).toBe(false);
            expect(draft.id).toBe('');
            expect(draft.completedAt).toBeNull();
        }
    });

    /**
     * NOT "each its OWN", which this test claimed while asserting something weaker. `backoff` is
     * deliberately `ratelimit` plus a Teams webhook — spec C4's fan-out — so it shares that
     * template's pattern AND its message. The old name was true of the original six and quietly
     * became false when the tenth arrived.
     *
     * The counts stay EXACT, so a second collision still fails; and the one permitted duplicate is
     * named, so `length - 1` cannot be satisfied by some other pair colliding instead.
     *
     * Comparisons are left out of the claim because they *cannot* be distinct: every text rule's
     * comparison is the same `{ text, null, null }` triple. That both kinds occur is the strongest
     * true statement available, and it is what the assertion below actually makes.
     */
    it('gives each template its own pattern and message, bar one deliberate duplicate', () => {
        const patterns = AUTOMATION_TEMPLATES.flatMap((t) => (
            t.rule.graph.parse ? [t.rule.graph.parse.find] : []
        ));
        const messages = AUTOMATION_TEMPLATES.flatMap((t) => (
            t.rule.graph.action ? [t.rule.graph.action.message] : []
        ));
        expect(new Set(patterns).size).toBe(patterns.length - 1);
        expect(new Set(messages).size).toBe(messages.length - 1);
        expect(byId('backoff').rule.graph.parse?.find).toBe(byId('ratelimit').rule.graph.parse?.find);
        expect(byId('backoff').rule.graph.action?.message)
            .toBe(byId('ratelimit').rule.graph.action?.message);
        // At least one of each comparison shape, so the set is not ten numeric rules wearing
        // different names.
        const kinds = AUTOMATION_TEMPLATES.flatMap((t) => (
            t.rule.graph.cond ? [t.rule.graph.cond.kind] : []
        ));
        expect(kinds).toContain('number');
        expect(kinds).toContain('text');
    });

    it('every starter pattern compiles', () => {
        // A template that ships an uncompilable pattern is a rule the engine refuses at load, and
        // the gallery would offer it anyway.
        for (const t of AUTOMATION_TEMPLATES) {
            if (t.rule.graph.parse) expect(() => new RegExp(t.rule.graph.parse.find)).not.toThrow();
        }
    });

    it('every numeric template captures a group, and every bracket-keeping one has one', () => {
        for (const t of AUTOMATION_TEMPLATES) {
            const parse = t.rule.graph.parse;
            if (!parse || parse.keep !== 'brackets') continue;
            // `Keep: the number in brackets` reads capture group 1. Without a group the engine has
            // nothing to keep, and the save gate refuses it — so a template must not ship one.
            expect(new RegExp(parse.find).exec('') === null).toBe(true);
            expect(parse.find).toMatch(/\((?!\?)/);
        }
    });

    it('keeps the literal AND the escaped pattern for an exact-words template', () => {
        // Re-opening the rule must show the user's own text back, not `proceed\?`, which they would
        // then helpfully "fix".
        const parse = byId('prompt').rule.graph.parse;
        if (!parse) throw new Error('Prompt template needs a parse step');
        expect(parse.literal).toBe('Do you want to proceed?');
        expect(parse.find).toBe('Do you want to proceed\\?');
    });

    it('has exactly one template that deliberately does not press Enter', () => {
        const quiet = AUTOMATION_TEMPLATES.filter((t) => t.rule.graph.action?.submit === false);
        expect(quiet.map((t) => t.id)).toEqual(['prompt']);
    });

    it('builddiscord is webhook-only, with a Discord provider and a capturing pattern', () => {
        const t = byId('builddiscord');
        expect(t.rule.graph.action).toBeUndefined();
        expect(t.rule.graph.webhook?.provider).toBe('discord');
        expect(t.rule.graph.parse?.find).toMatch(/\\d/);
        expect(t.rule.graph.webhook?.substitute).toBe(true);
    });

    it('backoff has BOTH destinations', () => {
        const graph = byId('backoff').rule.graph;
        expect(graph.action?.message).toBe('/wait 60');
        expect(graph.webhook?.provider).toBe('teams');
    });

    it('nightly and settle cover both Wait modes, by id', () => {
        expect(byId('nightly').rule.graph.timer?.mode).toEqual({
            dailyAt: { minuteOfDay: 2 * 60, days: 0b0001_1111 },
        });
        expect(byId('settle').rule.graph.timer?.mode).toEqual({
            afterMatch: { delayMs: 30_000 },
        });
    });

    it('no template ships a real webhook URL', () => {
        for (const t of AUTOMATION_TEMPLATES) expect(t.rule.graph.webhook?.url ?? '').toBe('');
    });

    it('hands out a deep copy, so editing one draft cannot poison the next', () => {
        const first = draftFromTemplate(byId('ctx'));
        if (!first.graph.action) throw new Error('Context template needs an action step');
        first.graph.action.message = 'mutated';
        first.targetIds.push('tm-1');
        const second = draftFromTemplate(byId('ctx'));
        if (!second.graph.action) throw new Error('Context template needs an action step');
        expect(second.graph.action.message).not.toBe('mutated');
        expect(second.targetIds).toEqual([]);
    });

    it('clones a template with no action without creating one', () => {
        const base = byId('ctx');
        const { action: _action, ...graph } = base.rule.graph;
        const withoutAction: AutomationTemplate = {
            ...base,
            rule: { ...base.rule, graph },
        };

        expect(() => draftFromTemplate(withoutAction)).not.toThrow();
        expect(draftFromTemplate(withoutAction).graph).not.toHaveProperty('action');
    });

    /**
     * **A hand-rolled copy that rebuilds a shape field by field drops the next field silently.**
     *
     * `structuredCloneRule` listed `monitor`/`parse`/`cond`/`action` and justified it as *"the
     * shape is small and known"*. That justification expired the moment the graph gained `timer`
     * this milestone: a template with a Wait step handed out a draft with none, and `layout` had
     * been going the same way since it was added. It now spreads the graph first and replaces the
     * nested members, so a field added later rides through by construction.
     *
     * Two oracles, and the SECOND is the one that turns the next silent drop into a red test: a
     * deep-equal alone would still pass a clone that had lost a key holding `undefined`, and it
     * says nothing about a key the source has and the copy never mentions.
     */
    it('carries every graph field a rule can have, not just the four a template happens to set', () => {
        const base = byId('ctx');
        const full: AutomationTemplate = {
            ...base,
            rule: {
                ...base.rule,
                excludedIds: ['tm-excluded'],
                graph: {
                    ...base.rule.graph,
                    cond: {
                        kind: 'number',
                        op: 'gt',
                        threshold: 25,
                        join: 'or',
                        clauses: [{ source: { group: 1 }, test: { number: { op: 'lt', value: 90 } } }],
                    },
                    // The two the field-by-field rebuild dropped.
                    timer: { mode: { afterMatch: { delayMs: 30_000 } } },
                    webhook: {
                        provider: 'discord',
                        url: '',
                        body: 'Build failed — $1 red',
                        substitute: true,
                    },
                    layout: {
                        monitor: { x: 11, y: 12 },
                        parse: { x: 21, y: 22 },
                        cond: { x: 31, y: 32 },
                        action: { x: 41, y: 42 },
                    },
                },
            },
        };

        const clone = draftFromTemplate(full);
        expect(clone.graph).toEqual(full.rule.graph);
        expect(Object.keys(clone.graph).sort()).toEqual(Object.keys(full.rule.graph).sort());

        // **And it is a COPY, which deep equality cannot see.** A nested member left shared with
        // the frozen module-level template satisfies both assertions above and still lets an
        // editor reach back into it — which is the entire reason this function exists.
        const { timer, webhook, layout, cond } = clone.graph;
        const excludedIds = clone.excludedIds;
        if (!timer || !webhook || !layout || !cond?.clauses || !excludedIds) {
            throw new Error('Full graph clone lost a nested step');
        }
        timer.mode = { afterMatch: { delayMs: 1 } };
        webhook.body = 'mutated';
        layout.monitor.x = 999;
        cond.clauses[0].test = { number: { op: 'gt', value: 1 } };
        excludedIds.push('tm-another');
        expect(full.rule.graph.timer).toEqual({ mode: { afterMatch: { delayMs: 30_000 } } });
        expect(full.rule.graph.webhook!.body).toBe('Build failed — $1 red');
        expect(full.rule.graph.layout!.monitor).toEqual({ x: 11, y: 12 });
        expect(full.rule.graph.cond!.clauses![0].test).toEqual({ number: { op: 'lt', value: 90 } });
        expect(full.rule.excludedIds).toEqual(['tm-excluded']);
    });
});

describe('blankDraft', () => {
    it('is not a seventh template: no pattern, no message, no terminals', () => {
        const blank = blankDraft();
        expect(blank.graph.parse.find).toBe('');
        expect(blank.graph.action.message).toBe('');
        expect(blank.targetIds).toEqual([]);
        expect(blank.enabled).toBe(false);
    });
});
