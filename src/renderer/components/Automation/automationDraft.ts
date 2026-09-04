/**
 * The one draft the whole editor is derived from (plan 028 §6.2).
 *
 * `useReducer(draftReducer, …)` over a single value. **Nothing derived is stored**: problems, faces,
 * the palette summary, the header's blocked reason and all four inspector panels are computed in
 * render by `automationValidation` and `automationDerive`, memoised on the draft alone.
 *
 * ## What round-trips, and what does not
 *
 * `rule` is the wire DTO — it goes to `save_automation` unchanged, and comes back from the store the
 * same shape. `present`, `wires` and `layout` are **session-only canvas state**: the `graph` blob has
 * exactly four steps and no place to put a node position, and adding one would be a schema field
 * that nothing reads back. So the canvas is a *drawing of* the rule, re-derived every time the editor
 * opens, and dragging a node is a comfort rather than an edit. That is stated here because the
 * alternative — a layout that silently fails to persist — is the kind of thing a user discovers by
 * losing work.
 *
 * `draftFromRule` / `ruleFromDraft` are therefore the only place the editor's shape and the store's
 * shape meet (§7.7), and the round-trip test asserts draft → wire → row → wire → draft is identity
 * for all six templates.
 */
import type { AutomationRule } from '../../types/electron';
import type { StepKind, Wire } from './automationSteps';
import { STEP_ORDER, STEP_PORTS, defaultWires, samePort } from './automationSteps';
import { applyPreset, setFind, setLiteral } from './automationPresets';

export interface NodePos {
    x: number;
    y: number;
}

/** A finished rule is four cards on a ~900×260 world (§6.5) — hence no minimap. */
export const AU_NODE_W = 206;
export const AU_NODE_H = 132;
const AU_GAP_X = 232;

export const DEFAULT_LAYOUT: Record<StepKind, NodePos> = {
    monitor: { x: 0, y: 0 },
    parse: { x: AU_GAP_X, y: 0 },
    cond: { x: AU_GAP_X * 2, y: 0 },
    action: { x: AU_GAP_X * 3, y: 0 },
};

/**
 * Where a port's dot sits on its card, in world units relative to the card's top-left.
 *
 * Inputs on the left edge, outputs on the right, spread evenly down it — so `cond`'s `yes` and `no`
 * sit at a third and two thirds and are told apart by position as well as by label. Canvas Mode's
 * four-compass `portPoint` is not reused: its sides are *chosen* per pair by `pickSides`, which is
 * right for a free graph and wrong for a chain that always reads left to right.
 */
export function portAnchor(step: StepKind, port: string, pos: NodePos): NodePos {
    const ports = STEP_PORTS[step];
    const spec = ports.find((p) => p.id === port);
    if (!spec) return { x: pos.x, y: pos.y };
    const side = ports.filter((p) => p.dir === spec.dir);
    const index = side.indexOf(spec);
    return {
        x: spec.dir === 'in' ? pos.x : pos.x + AU_NODE_W,
        y: pos.y + (AU_NODE_H * (index + 1)) / (side.length + 1),
    };
}

/** A left-to-right cubic between two anchors. The horizontal handles are what make it read as flow. */
export function auWirePath(from: NodePos, to: NodePos): string {
    const reach = Math.max(46, Math.abs(to.x - from.x) / 2);
    return `M ${from.x} ${from.y} C ${from.x + reach} ${from.y}, ${to.x - reach} ${to.y}, ${to.x} ${to.y}`;
}

export interface AutomationDraft {
    /** The DTO. This, and only this, is what a save sends. */
    rule: AutomationRule;
    /** Which steps are on the canvas. All four for a template or an existing rule; none for a blank. */
    present: StepKind[];
    wires: Wire[];
    layout: Record<StepKind, NodePos>;
    selected: StepKind | null;
    /**
     * The rule as it was last known to be saved, for the dirty check.
     *
     * A **value**, not a flag. A boolean set by every edit says "something changed" and keeps saying
     * it after the change is undone, so a user who types a character and deletes it is told they have
     * unsaved work and offered a dialog about nothing. Comparing against the saved value is the only
     * answer that can go back to false.
     */
    saved: AutomationRule;
}

/**
 * Open the editor on a rule.
 *
 * `emptyCanvas` is the mockup's third state — *a brand new rule* — whose canvas starts empty with
 * the "Start with Watch output" hint, so building one from nothing is a thing the palette teaches
 * rather than a thing that has already happened. A template and an existing rule both arrive with
 * all four steps drawn, because they are already complete rules.
 */
export function draftFromRule(rule: AutomationRule, emptyCanvas = false): AutomationDraft {
    const present = emptyCanvas ? [] : [...STEP_ORDER];
    return {
        rule,
        present,
        wires: defaultWires(present),
        layout: { ...DEFAULT_LAYOUT },
        selected: emptyCanvas ? null : 'monitor',
        saved: rule,
    };
}

/** What a save sends. The canvas state is deliberately not part of it. */
export function ruleFromDraft(draft: AutomationDraft): AutomationRule {
    return draft.rule;
}

/**
 * Is there unsaved work?
 *
 * Structural equality over the DTO, via JSON — the shape is small, known, and has no `undefined`
 * holes or cycles, and every field is one the store round-trips. A field-by-field comparison would
 * be a fifth place to add a field to (§7.7 already names four), and the one that fails silently.
 */
export function isDirty(draft: AutomationDraft): boolean {
    return comparable(draft.rule) !== comparable(draft.saved);
}

/**
 * The rule as a string, with the one field whose ORDER means nothing put in a fixed one.
 *
 * `targetIds` is a set: `write_rule` replaces the pick set row by row and the engine resolves it
 * with a lookup, so nothing downstream can tell `['tm-1','tm-2']` from `['tm-2','tm-1']`. The
 * picker's toggle appends, though, so unticking a terminal and ticking it straight back rotated the
 * array — and the draft then read dirty forever, with a *Leave without saving?* dialog over an
 * identical rule.
 *
 * **Both sides go through this**, which is the whole point: normalising one side of a comparison and
 * not the other can only invent differences (`transform-on-one-side-of-a-comparison`). And it
 * normalises for the COMPARISON only — the array that goes to the store is still the user's own.
 */
function comparable(rule: AutomationRule): string {
    return JSON.stringify({ ...rule, targetIds: [...rule.targetIds].sort() });
}

export type DraftAction =
    | { type: 'name'; name: string }
    | { type: 'runsOnce'; runsOnce: boolean }
    /**
     * `persisted` means this field went to the store on its own — the header toggle calls
     * `set_automation_enabled`, which writes one column and returns. The baseline moves with it, so
     * the rule stops reading as dirty *for that field*, while every other unsaved edit stays
     * unsaved. Marking the whole draft clean here would tell the navigation guard there is nothing
     * to lose while the user's edits sit in memory.
     */
    | { type: 'enabled'; enabled: boolean; persisted?: boolean }
    | { type: 'targetMode'; mode: AutomationRule['targetMode'] }
    | { type: 'criterion'; criterion: AutomationRule['criterion'] }
    | { type: 'criterionValue'; value: string }
    | { type: 'followNew'; followNew: boolean }
    | { type: 'targets'; ids: string[] }
    | { type: 'toggleTarget'; id: string }
    | { type: 'monitor'; patch: Partial<AutomationRule['graph']['monitor']> }
    | { type: 'preset'; preset: AutomationRule['graph']['parse']['preset'] }
    | { type: 'literal'; literal: string }
    | { type: 'find'; find: string }
    | { type: 'keep'; keep: AutomationRule['graph']['parse']['keep'] }
    | { type: 'cond'; patch: Partial<AutomationRule['graph']['cond']> }
    | { type: 'action'; patch: Partial<AutomationRule['graph']['action']> }
    | { type: 'select'; step: StepKind | null }
    | { type: 'addStep'; step: StepKind }
    | { type: 'moveStep'; step: StepKind; pos: NodePos }
    | { type: 'addWire'; wire: Wire }
    | { type: 'removeWire'; wire: Wire }
    /** After a successful save: the row the store now holds, including an id it may have minted. */
    | { type: 'saved'; rule: AutomationRule };

const withRule = (draft: AutomationDraft, rule: AutomationRule): AutomationDraft => ({
    ...draft,
    rule,
});

const withGraph = (
    draft: AutomationDraft,
    graph: Partial<AutomationRule['graph']>,
): AutomationDraft => withRule(draft, { ...draft.rule, graph: { ...draft.rule.graph, ...graph } });

export function draftReducer(draft: AutomationDraft, action: DraftAction): AutomationDraft {
    const { rule } = draft;
    switch (action.type) {
        case 'name':
            return withRule(draft, { ...rule, name: action.name });
        case 'runsOnce':
            return withRule(draft, { ...rule, runsOnce: action.runsOnce });
        case 'enabled':
            return {
                ...draft,
                rule: { ...rule, enabled: action.enabled },
                saved: action.persisted ? { ...draft.saved, enabled: action.enabled } : draft.saved,
            };
        case 'targetMode':
            return withRule(draft, { ...rule, targetMode: action.mode });
        case 'criterion':
            return withRule(draft, { ...rule, criterion: action.criterion });
        case 'criterionValue':
            return withRule(draft, { ...rule, criterionValue: action.value });
        case 'followNew':
            return withRule(draft, { ...rule, followNew: action.followNew });
        case 'targets':
            return withRule(draft, { ...rule, targetIds: [...action.ids] });
        case 'toggleTarget':
            return withRule(draft, {
                ...rule,
                targetIds: rule.targetIds.includes(action.id)
                    ? rule.targetIds.filter((id) => id !== action.id)
                    : [...rule.targetIds, action.id],
            });
        case 'monitor':
            return withGraph(draft, { monitor: { ...rule.graph.monitor, ...action.patch } });
        case 'preset':
            return withGraph(draft, { parse: applyPreset(rule.graph.parse, action.preset) });
        case 'literal':
            return withGraph(draft, { parse: setLiteral(rule.graph.parse, action.literal) });
        case 'find':
            return withGraph(draft, { parse: setFind(rule.graph.parse, action.find) });
        case 'keep':
            return withGraph(draft, { parse: { ...rule.graph.parse, keep: action.keep } });
        case 'cond':
            return withGraph(draft, { cond: { ...rule.graph.cond, ...action.patch } });
        case 'action':
            return withGraph(draft, { action: { ...rule.graph.action, ...action.patch } });
        case 'select':
            return { ...draft, selected: action.step };
        case 'addStep': {
            if (draft.present.includes(action.step)) return draft;
            // Kept in canonical order so the palette, the reading order and the wires all agree,
            // whatever order the user dropped them in.
            const present = STEP_ORDER.filter(
                (s) => s === action.step || draft.present.includes(s),
            );
            return { ...draft, present, wires: defaultWires(present), selected: action.step };
        }
        case 'moveStep':
            return { ...draft, layout: { ...draft.layout, [action.step]: action.pos } };
        case 'addWire':
            return { ...draft, wires: [...draft.wires, action.wire] };
        case 'removeWire':
            return {
                ...draft,
                wires: draft.wires.filter(
                    (w) =>
                        !(samePort(w.from, action.wire.from) && samePort(w.to, action.wire.to)),
                ),
            };
        case 'saved':
            // Two different things, deliberately not the same thing.
            //
            // The BASELINE becomes what was sent. That is what makes the draft read as clean, and it
            // has to be the sent value rather than the current one, or a keystroke that landed while
            // the save was in flight would be counted as already saved.
            //
            // The DRAFT keeps whatever it holds now, and adopts exactly two fields — which it must,
            // because they are the two the editor does not get to decide. Replacing it wholesale
            // would discard every character typed during the save: the save's own echo overwriting
            // the user's newer text, with no error and no way to notice except by re-reading what
            // you typed.
            //
            //  - **`id`**, or the next save mints a second one and the same draft becomes two rows.
            //  - **`enabled`**, because a draft with a blocking problem is written SWITCHED OFF
            //    rather than refused, and a header still reading *Enabled* over a row that is not
            //    would be the editor lying about the only field that decides whether it runs.
            return {
                ...draft,
                rule: {
                    ...draft.rule,
                    id: draft.rule.id.length === 0 ? action.rule.id : draft.rule.id,
                    enabled: action.rule.enabled,
                },
                saved: action.rule,
            };
        default:
            return draft;
    }
}
