/**
 * **Taking a card off the canvas** — `removalGroup` and the reducer's `removeStep`.
 *
 * A removal is two things that must happen together: the card leaves `present`, and the step's
 * field leaves the graph. Asserting only the first passes a reducer that hides a Wait while the
 * engine goes on delaying every send, which is precisely the data consequence the old "there is no
 * remove gesture" note was holding out for. Every case here therefore asks BOTH questions, and the
 * write is checked through `ruleFromDraft` rather than off `draft.rule` — a step `graphAsWritten`
 * happens to omit and a step that is really gone are the same picture on screen and different rows
 * in the store.
 *
 * The wires are the third question and the one easiest to get wrong, because removal is not
 * subtraction: dropping the wait does not leave the verdict dangling, it reconnects the verdict to
 * the send the wait used to sit between.
 */
import { blankDraft } from '../../Settings/Automations/automationTemplates';
import { draftFromRule, draftReducer, ruleFromDraft } from '../automationDraft';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import { INPUT_STEPS, STEP_ORDER, removalGroup } from '../automationSteps';
import type { StepKind } from '../automationSteps';
import { blockingProblems, problems } from '../automationValidation';

const run = (draft: AutomationDraft, actions: DraftAction[]): AutomationDraft =>
    actions.reduce(draftReducer, draft);

/** A canvas holding every step the palette can add, so a removal has something to disturb. */
const fullCanvas = (): AutomationDraft =>
    run(draftFromRule(blankDraft(), 'blank'), [
        { type: 'addStep', step: 'monitor' },
        { type: 'addStep', step: 'parse' },
        { type: 'addStep', step: 'cond' },
        { type: 'addStep', step: 'timer' },
        { type: 'addStep', step: 'action' },
    ]);

/** What a save would actually serialize — `undefined` values and absent keys are not the same row. */
const written = (draft: AutomationDraft) => JSON.parse(JSON.stringify(ruleFromDraft(draft))).graph;

describe('removalGroup', () => {
    /**
     * A table over all six, not a spot check on the wait. Half the point of the function is the
     * three steps that answer with something other than themselves, and a test that only asked
     * about `timer` would pass on an implementation that always answered `[kind]`.
     */
    it.each(STEP_ORDER.map((step) => [step] as const))('answers for %s', (step) => {
        const present = [...STEP_ORDER];
        const expected = INPUT_STEPS.includes(step) ? [...INPUT_STEPS] : [step];
        expect(removalGroup(present, step)).toEqual(expected);
    });

    it('reports only the cards actually on the canvas', () => {
        // A schedule rule drawing a wait and a send: aiming at either takes exactly it, and the
        // group answer must not name three reading steps that are not there to remove.
        expect(removalGroup(['timer', 'action'], 'timer')).toEqual(['timer']);
        expect(removalGroup(['monitor', 'action'], 'parse')).toEqual(['monitor']);
    });

    it('is empty for a step that is not drawn, which the reducer treats as a no-op', () => {
        const draft = fullCanvas();
        expect(removalGroup(draft.present, 'webhook')).toEqual([]);
        expect(draftReducer(draft, { type: 'removeStep', step: 'webhook' })).toBe(draft);
    });
});

describe('removeStep', () => {
    it('takes the wait off the canvas AND out of the graph', () => {
        const before = fullCanvas();
        expect(before.rule.graph.timer).toBeDefined();

        const after = draftReducer(before, { type: 'removeStep', step: 'timer' });
        expect(after.present).toEqual(['monitor', 'parse', 'cond', 'action']);
        // `graphAsWritten` has no rule for `timer`, so a card merely hidden would still be saved —
        // and the rule would go on holding every send for thirty seconds with nothing on screen.
        expect(written(after)).not.toHaveProperty('timer');
    });

    it('reconnects the verdict to the send the wait sat between', () => {
        const after = draftReducer(fullCanvas(), { type: 'removeStep', step: 'timer' });
        expect(after.wires).toEqual([
            { from: { step: 'monitor', port: 'out' }, to: { step: 'parse', port: 'in' } },
            { from: { step: 'parse', port: 'out' }, to: { step: 'cond', port: 'in' } },
            { from: { step: 'cond', port: 'true' }, to: { step: 'action', port: 'in' } },
        ]);
    });

    it('takes all three reading steps when any one of them is aimed at', () => {
        const after = draftReducer(fullCanvas(), { type: 'removeStep', step: 'parse' });
        expect(after.present).toEqual(['timer', 'action']);
        const graph = written(after);
        for (const step of INPUT_STEPS) expect(graph).not.toHaveProperty(step);
    });

    /**
     * The reason the three travel together, stated as behaviour rather than as a comment.
     * `eval::InputSteps::of` answers `None` for a strict subset, so a rule keeping two of them
     * reads nothing — and `neverRunsProblem` only recognises the shape when all three are gone.
     */
    it('never leaves a strict subset of the reading steps behind', () => {
        for (const step of INPUT_STEPS) {
            const graph = written(draftReducer(fullCanvas(), { type: 'removeStep', step }));
            const kept = INPUT_STEPS.filter((s) => s in graph);
            expect(kept).toEqual([]);
        }
    });

    it('clears the selection only when it pointed at what just went', () => {
        const draft = fullCanvas();

        const gone = draftReducer({ ...draft, selected: 'monitor' }, { type: 'removeStep', step: 'parse' });
        expect(gone.selected).toBeNull();

        const kept = draftReducer({ ...draft, selected: 'action' }, { type: 'removeStep', step: 'timer' });
        expect(kept.selected).toBe('action');
    });

    it('keeps the arrangement, so the palette puts a card back where its owner left it', () => {
        const moved = draftReducer(fullCanvas(), { type: 'moveStep', step: 'timer', pos: { x: 111, y: 222 } });
        const removed = draftReducer(moved, { type: 'removeStep', step: 'timer' });
        expect(removed.layout.timer).toEqual({ x: 111, y: 222 });

        const readded = draftReducer(removed, { type: 'addStep', step: 'timer' });
        expect(readded.layout.timer).toEqual({ x: 111, y: 222 });
    });

    /**
     * The trap this gesture would otherwise open, and the reason `never_runs_problem` stopped
     * treating a webhook as a trigger: strip the reading steps off a webhook rule that has no wait,
     * and nothing reads a terminal and no clock fires. Before the fix this rule reported no problem
     * whatsoever — saveable, enabled, and silent forever.
     */
    it('leaves an unrunnable rule BLOCKED rather than quietly saveable', () => {
        const webhookRule = run(draftFromRule(blankDraft(), 'blank'), [
            { type: 'addStep', step: 'monitor' },
            { type: 'addStep', step: 'parse' },
            { type: 'addStep', step: 'cond' },
            { type: 'addStep', step: 'webhook' },
        ]);
        const configured = draftReducer(webhookRule, {
            type: 'webhook',
            patch: { url: 'https://hooks.example.invalid/gone', body: 'done' },
        });
        const stripped = draftReducer(configured, { type: 'removeStep', step: 'monitor' });

        expect(written(stripped)).toEqual({ webhook: expect.any(Object), layout: expect.any(Object) });
        expect(blockingProblems(problems(ruleFromDraft(stripped))).map((p) => p.code))
            .toContain('timer.neverRuns');
    });

    /**
     * The wire chip and the Delete key are two gestures reaching ONE removal. They were separate
     * code paths until this milestone, which is how they would have drifted: the chip removed the
     * destination, and a second implementation of "and re-derive the wires, and clear the
     * selection" is a second set of answers to those questions.
     */
    it.each(['action', 'webhook'] as StepKind[])(
        'reaches the same draft for %s whether the card or its wire is aimed at',
        (destination) => {
            const canvas = run(draftFromRule(blankDraft(), 'blank'), [
                { type: 'addStep', step: 'monitor' },
                { type: 'addStep', step: 'parse' },
                { type: 'addStep', step: 'cond' },
                { type: 'addStep', step: destination },
            ]);
            const wire = canvas.wires.find((w) => w.to.step === destination)!;

            expect(draftReducer(canvas, { type: 'removeStep', step: destination }))
                .toEqual(draftReducer(canvas, { type: 'removeWire', wire }));
        },
    );
});
