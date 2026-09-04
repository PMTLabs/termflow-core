/**
 * §10.26 — the six built-in templates.
 *
 * Exactly six, unique ids and titles, every draft pointed at **no terminals**, and each template's
 * values different from every other's. That last one is the guard against the failure mode this
 * whole feature's design keeps circling: a table of six entries that are secretly one entry copied
 * six times, which passes every per-item assertion and ships a gallery of identical rules.
 *
 * *(Plan §10.26 says "empty `monitor.ids`". The DTO settled targeting as `rule.targetIds` — ids are
 * columns, not part of the graph blob — so that is the field asserted; the plan is corrected in
 * place.)*
 */
import { AUTOMATION_TEMPLATES, blankDraft, draftFromTemplate } from '../automationTemplates';

describe('AUTOMATION_TEMPLATES', () => {
    it('has exactly six, with unique ids and unique titles', () => {
        expect(AUTOMATION_TEMPLATES).toHaveLength(6);
        expect(new Set(AUTOMATION_TEMPLATES.map((t) => t.id)).size).toBe(6);
        expect(new Set(AUTOMATION_TEMPLATES.map((t) => t.title)).size).toBe(6);
    });

    it('names the fields you will change on every card', () => {
        // Picking a card is a decision you make from the gallery without opening it first, which is
        // only true if every card says what is yours to fill in.
        for (const t of AUTOMATION_TEMPLATES) {
            expect(t.youllChange.length).toBeGreaterThan(0);
            expect(t.why.length).toBeGreaterThan(20);
        }
    });

    it('gives every draft NO terminals, so a fresh template has exactly one problem left', () => {
        // Which terminals to watch is never a sensible default (decision 13), so the draft arrives
        // pointed at nothing and validation blocks *enabling* until the user picks.
        for (const t of AUTOMATION_TEMPLATES) {
            const draft = draftFromTemplate(t);
            expect(draft.targetIds).toEqual([]);
            expect(draft.enabled).toBe(false);
            expect(draft.id).toBe('');
            expect(draft.completedAt).toBeNull();
        }
    });

    it('gives each template its OWN pattern, comparison and message', () => {
        const patterns = AUTOMATION_TEMPLATES.map((t) => t.rule.graph.parse.find);
        const messages = AUTOMATION_TEMPLATES.map((t) => t.rule.graph.action.message);
        expect(new Set(patterns).size).toBe(6);
        expect(new Set(messages).size).toBe(6);
        // At least one of each comparison shape, so the set is not six numeric rules wearing
        // different names.
        const kinds = AUTOMATION_TEMPLATES.map((t) => t.rule.graph.cond.kind);
        expect(kinds).toContain('number');
        expect(kinds).toContain('text');
    });

    it('every starter pattern compiles', () => {
        // A template that ships an uncompilable pattern is a rule the engine refuses at load, and
        // the gallery would offer it anyway.
        for (const t of AUTOMATION_TEMPLATES) {
            expect(() => new RegExp(t.rule.graph.parse.find)).not.toThrow();
        }
    });

    it('every numeric template captures a group, and every bracket-keeping one has one', () => {
        for (const t of AUTOMATION_TEMPLATES) {
            if (t.rule.graph.parse.keep !== 'brackets') continue;
            // `Keep: the number in brackets` reads capture group 1. Without a group the engine has
            // nothing to keep, and the save gate refuses it — so a template must not ship one.
            expect(new RegExp(t.rule.graph.parse.find).exec('') === null).toBe(true);
            expect(t.rule.graph.parse.find).toMatch(/\((?!\?)/);
        }
    });

    it('keeps the literal AND the escaped pattern for an exact-words template', () => {
        // Re-opening the rule must show the user's own text back, not `proceed\?`, which they would
        // then helpfully "fix".
        const prompt = AUTOMATION_TEMPLATES.find((t) => t.id === 'prompt')!;
        expect(prompt.rule.graph.parse.literal).toBe('Do you want to proceed?');
        expect(prompt.rule.graph.parse.find).toBe('Do you want to proceed\\?');
    });

    it('has exactly one template that deliberately does not press Enter', () => {
        const quiet = AUTOMATION_TEMPLATES.filter((t) => !t.rule.graph.action.submit);
        expect(quiet.map((t) => t.id)).toEqual(['prompt']);
    });

    it('hands out a deep copy, so editing one draft cannot poison the next', () => {
        const first = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        first.graph.action.message = 'mutated';
        first.targetIds.push('tm-1');
        const second = draftFromTemplate(AUTOMATION_TEMPLATES[0]);
        expect(second.graph.action.message).not.toBe('mutated');
        expect(second.targetIds).toEqual([]);
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
