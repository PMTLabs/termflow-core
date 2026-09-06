/**
 * **What a save WRITES, for a canvas that is missing the three input steps** (plan 032 §3.1, §6.3).
 *
 * `blankDraft()` scaffolds `monitor`, `parse` and `cond` into the graph, while `ruleFromDraft`
 * omits them when a canvas draws none. A user who drags **Wait** and **Send to terminal** onto an
 * empty canvas and then sets the Wait to *At a time of day* therefore writes a schedule rule
 * without an input chain to silence. The mode switch is required: dragging Wait in materialises
 * `DEFAULT_TIMER_MODE`, which is an `afterMatch` delay.
 *
 * **The three input steps are omitted AS A GROUP, never individually**, which is
 * `eval::InputSteps::of`'s own all-or-nothing contract rather than a second one invented here. Per
 * step it would open a worse hole than the one it closes: a *Watch → Wait → Send* canvas would write
 * a monitor with no parse and no cond. That is a possible disabled incomplete draft; after a message
 * is entered, `timer.neverRuns` blocks enabling it, so it cannot count as a live non-runnable rule.
 * As a group, any canvas keeping one input step keeps all three, and `parse.empty` goes on catching
 * the partial cases.
 */
import { blankDraft } from '../../Settings/Automations/automationTemplates';
import { draftFromRule, draftReducer, ruleFromDraft } from '../automationDraft';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import { blockingProblems, problems } from '../automationValidation';

const run = (draft: AutomationDraft, actions: DraftAction[]): AutomationDraft =>
    actions.reduce(draftReducer, draft);

const blockingCodes = (draft: AutomationDraft): string[] =>
    blockingProblems(problems(ruleFromDraft(draft))).map((p) => p.code);

describe('the editor writes the steps the canvas draws', () => {
    it('omits a hidden action scaffold from the graph a save serializes', () => {
        const draft = draftFromRule(blankDraft(), 'blank');
        expect(draft.rule.graph.action).toBeDefined();
        expect(draft.present).not.toContain('action');

        const written = JSON.parse(JSON.stringify(ruleFromDraft(draft)));
        expect(written.graph).not.toHaveProperty('action');
    });

    it('ignores an action edit when the draft has no action', () => {
        const { action: _action, ...graph } = blankDraft().graph;
        const draft = draftFromRule({ ...blankDraft(), graph }, 'blank');

        const after = draftReducer(draft, { type: 'action', patch: { message: 'do not send' } });
        expect(after).toBe(draft);
        expect(after.rule.graph).not.toHaveProperty('action');
    });

    /**
     * **C1, and the one assertion whose absence hid it.** Built the way the palette builds it —
     * `addStep` for each card, then the Wait panel's own mode dispatch — and asked of
     * `ruleFromDraft`, which is what a save sends.
     *
     * Mutation M-0: revert the group omission in `ruleFromDraft` → this fails on a non-empty
     * blocking list naming `timer.scheduleWithMonitor`.
     */
    it('a Wait + Send canvas saves a schedule rule with nothing blocking it', () => {
        const draft = run(draftFromRule(blankDraft(), 'blank'), [
            { type: 'addStep', step: 'timer' },
            { type: 'addStep', step: 'action' },
            { type: 'timer', mode: { dailyAt: { minuteOfDay: 9 * 60, days: 0b0001_1111 } } },
            { type: 'action', patch: { message: 'stand-up in five' } },
        ]);

        expect(draft.present).toEqual(['timer', 'action']);
        expect(blockingCodes(draft)).toEqual([]);

        // The premise, so a scaffold that quietly grew back cannot make the line above vacuous.
        const written = ruleFromDraft(draft);
        expect(written.graph.monitor).toBeUndefined();
        expect(written.graph.parse).toBeUndefined();
        expect(written.graph.cond).toBeUndefined();
        expect(written.graph.timer).toEqual({
            mode: { dailyAt: { minuteOfDay: 9 * 60, days: 0b0001_1111 } },
        });
    });

    /**
     * The group half of the ruling: one input step on the canvas keeps all three in the graph, so a
     * partial rule is still caught by `parse.empty` rather than saved clean and silently inert.
     */
    it('a canvas keeping one input step writes all three, and is still blocked by parse.empty', () => {
        const draft = run(draftFromRule(blankDraft(), 'blank'), [
            { type: 'addStep', step: 'monitor' },
            { type: 'addStep', step: 'timer' },
            { type: 'addStep', step: 'action' },
            { type: 'action', patch: { message: 'go' } },
        ]);

        const written = ruleFromDraft(draft);
        expect(written.graph.monitor).toBeDefined();
        expect(written.graph.parse).toBeDefined();
        expect(written.graph.cond).toBeDefined();
        expect(blockingCodes(draft)).toEqual(['parse.empty']);
    });

    /**
     * **T4-f, ruled deliberately: the list is NOT filtered to `present`.**
     *
     * A blank canvas used to report two problems for two cards nobody had drawn — *"Read a value —
     * Enter something to look for"* and *"Send to terminal — Enter the message this rule should
     * type"* — the first thing a new user sees after *Start from scratch*. The group omission
     * removes the first, because nothing on the canvas claims to read anything.
     *
     * The second stays, and stays on purpose. `action` is the one step the DTO makes mandatory
     * (§3.1: *"every rule in both scenarios ends in a send"*), so *"enter the message"* is true of a
     * blank rule and not a claim about an undrawn card. Filtering it out is the alternative, and it
     * would make the inspector's list disagree with the Enable gate beside it — `blocking.length`
     * is what dims the toggle, so a filtered list reads *no problems* over a control that refuses to
     * move and says nothing. One unfixable-looking sentence is worse than one true one.
     */
    it('a blank canvas reports exactly the one problem a blank rule really has', () => {
        const draft = draftFromRule(blankDraft(), 'blank');
        expect(draft.present).toEqual([]);
        expect(blockingCodes(draft)).toEqual(['action.empty']);
    });
});
