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
import { DEFAULT_LAYOUT, draftFromRule, draftReducer, isDirty, ruleFromDraft } from '../automationDraft';
import { STEP_ORDER, defaultWires } from '../automationSteps';
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
                layout: {
                    monitor: { x: 11, y: 12 },
                    parse: { x: 21, y: 22 },
                    cond: { x: 31, y: 32 },
                    action: { x: 41, y: 42 },
                },
            },
        };
        expect(ruleFromDraft(draftFromRule(overTheWire(full)))).toEqual(full);
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

    it('draws all four steps for a template or an existing rule', () => {
        const draft = draftFromRule(draftFromTemplate(AUTOMATION_TEMPLATES[0]));
        expect(draft.present).toEqual([...STEP_ORDER]);
        expect(draft.wires).toEqual(defaultWires(STEP_ORDER));
        expect(draft.layout).toEqual(DEFAULT_LAYOUT);
        expect(draft.selected).toBe('monitor');
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
    });

    it('opens a SEEDED rule dirty, against a baseline that differs only in the seeded pick', () => {
        const draft = draftFromRule(seededRule(), 'seeded');
        expect(isDirty(draft)).toBe(true);
        // Not merely "new rules are always dirty": the baseline names WHAT is unsaved, which is
        // what makes *"Saving keeps them; leaving throws them away"* a true sentence here. Written
        // as a whole-object equality rather than a `targetIds` spot-check, so a future seeding that
        // contributed a second field (a name, a criterion) would fail this rather than quietly
        // going unreported by the dirty check.
        expect(draft.saved).toEqual({ ...draft.rule, targetIds: [] });
    });

    it('a SEEDED draft goes clean when the save lands', () => {
        const draft = draftFromRule(seededRule(), 'seeded');
        const stored = { ...ruleFromDraft(draft), id: 'r-minted' };
        expect(isDirty(draftReducer(draft, { type: 'saved', rule: stored }))).toBe(false);
    });

    it('a SEEDED draft goes clean if the seeded terminal is unticked', () => {
        // The paired negative for the baseline, and the honest consequence of it: the prompt is
        // about the PICK, not about the rule being new. Untick the terminal the menu added and
        // change nothing else and you are looking at an untouched blank rule, which is not
        // something to hold a *Leave without saving?* dialog over.
        const draft = draftFromRule(seededRule(), 'seeded');
        const off = draftReducer(draft, { type: 'toggleTarget', id: 'tm-9' });
        expect(off.rule.targetIds).toEqual([]);
        expect(isDirty(off)).toBe(false);
    });

    it('opens clean, whatever it opened on', () => {
        for (const [, rule] of AUTOMATION_TEMPLATES.map((t) => ['', draftFromTemplate(t)] as const)) {
            expect(isDirty(draftFromRule(rule))).toBe(false);
        }
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
        expect(d.present).toEqual([...STEP_ORDER]);
        // And the wires follow, rather than being appended in drop order.
        expect(d.wires).toEqual(defaultWires(STEP_ORDER));
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
