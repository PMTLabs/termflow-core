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
 * same shape. `present` and `wires` are **session-only canvas state**, re-derived from the four steps
 * on every open: they carry no user choice, so the canvas is a *drawing of* the rule.
 *
 * **`layout` DOES round-trip, corrected here.** This paragraph used to say it did not, on the
 * grounds that the `graph` blob had "no place to put a node position, and adding one would be a
 * schema field that nothing reads back" — and it warned, correctly, that "a layout that silently
 * fails to persist is the kind of thing a user discovers by losing work". That warning is what
 * overturned the ruling rather than a change of mind about schemas: a card's position IS a user
 * choice, dragging one made the editor read clean, and closing threw the arrangement away without a
 * word. `graph.layout` now carries it (`Option`al, so older rows still load), which is also what
 * makes the *Leave without saving?* prompt's "Saving keeps them" true for a drag.
 *
 * `draftFromRule` / `ruleFromDraft` are therefore the only place the editor's shape and the store's
 * shape meet (§7.7), and the round-trip test asserts draft → wire → row → wire → draft is identity
 * for all six templates.
 */
import type { AutomationClause, AutomationRule } from '../../types/electron';
import type { StepKind, Wire } from './automationSteps';
import { STEP_ORDER, STEP_PORTS, defaultWires, samePort } from './automationSteps';
import { applyPreset, setFind, setLiteral } from './automationPresets';
// The gallery's own starting point, used here as the `'template'` opening's dirty BASELINE — the
// state the gallery was showing before a card was clicked. Same direction `AutomationMenuSection`
// already imports it in; `automationTemplates` imports nothing back, so there is no cycle.
import { blankDraft } from '../Settings/Automations/automationTemplates';

export interface NodePos {
    x: number;
    y: number;
}

/** A finished rule is four cards on a ~900×260 world (§6.5) — hence no minimap. */
export const AU_NODE_W = 244;
// The card is a FIXED box, so its height has to be big enough for the tallest face any step can
// draw, and that is the monitor's: three rows (Watch / Read / Check) whose first value is the
// criterion sentence — `command contains "claude" · 3 now` — the longest string on any card.
// `.au-nval` clamps a value to TWO lines rather than ellipsing it at one, so a row is one line or
// two, and the budget has to say WHICH rows take two.
//
// The value column is ~159px (`AU_NODE_W` less the node borders, the body's 11/9 padding, the 56px
// label and the 7px row gap) at 0.85rem, so roughly 23 characters a line. Measured against that:
// Watch wraps on any real criterion, and **Read wraps too** — `READ_PHRASES` are 24 and 26
// characters. Check does not: every `describeCadence` string (`On every new line`,
// `Checks every 30s`, `Checks every 5 min`) is 18 characters or fewer. That is FIVE text lines,
// not the four this budget was first written for:
//
//   head    19px icon + 7/5 padding + 1px rule                     = 32
//   body    12px padding + 2×3px gaps + 5×17px lines               = 103
//   foot    the badge, plus its 7px padding                        ≈ 31
//   borders                                                        =  2
//                                                                  ≈ 168
//
// 180 rather than that 168 because two of those terms — the head's icon row and the foot's badge —
// are set in the UA's `normal` line-height, which is not the same number on every platform. The
// 17px in the body term is stated in `.au-nval` for exactly this reason; the other two cannot be
// without restyling text this change has no business touching.
//
// **The slack is one line, and it is spent.** A third wrapped row would want ~185px, and `.au-node`
// is `overflow: visible`, so a card that runs out of room does not clip — it spills over the card
// below it. Anything that lengthens a monitor row's phrasing, widens the label column or raises
// `.au-nval`'s line-height has to come back here; `auNodeTwoLineValue.test.tsx` derives this same
// arithmetic from the stylesheet and the rendered face, and fails if it stops adding up.
export const AU_NODE_H = 180;
// Node PITCH, not the space between nodes: the gap is `AU_GAP_X - AU_NODE_W`, and at the old
// 232/206 that gap was 26px. A port label is centred on its port, and a port sits ON the node's
// edge — so an output label and the next node's input label were each half-overhanging into the
// same 26px and printed on top of each other (`lines lines`, `value value`). 116px is measured
// from that: two half-labels plus air.
//
// Changing this moves NEW rules and rules saved before `graph.layout` existed; a rule that has been
// dragged and saved keeps its own arrangement and is unaffected, which is the point of persisting it.
const AU_GAP_X = 360;

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
/** Which vertical edge of its card a port's dot sits on. */
export type PortSide = 'l' | 'r';

/** The map key for one port. Exported so nobody builds this string a second, different way. */
export const portKey = (step: StepKind, port: string): string => `${step}.${port}`;

/** Where a port sits when nothing is wired to it: the reading order, inputs left and outputs right. */
export function defaultPortSide(dir: 'in' | 'out'): PortSide {
    return dir === 'in' ? 'l' : 'r';
}

/**
 * Which edge each port sits on, given where the cards currently are.
 *
 * **The decision belongs to the CARD, not to the port.** A card is either the normal way round
 * (inputs left, outputs right) or flipped, and every one of its ports follows — so a card can never
 * end up with an input and an output on the same edge. Deciding per port instead, by facing each one
 * at its own peer, is what put `Compare it`'s input and its `no` output both on its right-hand side.
 *
 * A card flips when its flow runs right to left: `pull` adds how far its targets sit to the right of
 * it and how far its sources sit to the left, so a card dragged past both scores negatively twice,
 * and a card with a source on one side and a target on the other is decided by whichever is further.
 * There is no arrangement of a chain in which every card gets what it wants, so this picks one
 * coherent answer per card rather than a locally optimal one per port.
 *
 * Averaged over peers rather than taken from the first wire: a port can carry several, and picking
 * one arbitrarily would let the dots jump when an unrelated card moved.
 *
 * **"To one side of me" needs a DEADBAND, not an exact tie.** Cards stacked vertically are never
 * quite aligned, and the first version of this fell back to the reading order only when the centres
 * were exactly EQUAL — so a ten-pixel drift between two cards sitting one above the other read as
 * "my peer is to the left", threw both ports to the far edges, and looped the wire around the
 * outside of both cards. Reported from a live build at a 10px offset. A peer must now be clear of
 * the card by `AU_NODE_W` — less than that and the two overlap in x, where neither "left" nor
 * "right" describes the arrangement. That also makes the layout STABLE: nudging a card a few pixels
 * can no longer make the wires jump.
 *
 * Returned as a plain map so `AuNode` (which draws the dot) and `AuWires` (which anchors the line to
 * it) read ONE value. Two private copies of this rule is how the dot and the line end up on
 * different edges of the same card.
 */
export function portSides(
    wires: Wire[],
    layout: Record<StepKind, NodePos>,
): Record<string, PortSide> {
    const centre = (step: StepKind): number | null => {
        const pos = layout[step];
        return pos ? pos.x + AU_NODE_W / 2 : null;
    };

    type Pull = { own: number; outSum: number; outN: number; inSum: number; inN: number };
    const acc = new Map<StepKind, Pull>();
    const at = (step: StepKind): Pull | null => {
        const own = centre(step);
        if (own === null) return null;
        const cur = acc.get(step) ?? { own, outSum: 0, outN: 0, inSum: 0, inN: 0 };
        acc.set(step, cur);
        return cur;
    };

    for (const wire of wires) {
        const fromC = centre(wire.from.step);
        const toC = centre(wire.to.step);
        if (fromC === null || toC === null) continue;
        const source = at(wire.from.step);
        const target = at(wire.to.step);
        if (source) {
            source.outSum += toC;
            source.outN += 1;
        }
        if (target) {
            target.inSum += fromC;
            target.inN += 1;
        }
    }

    const out: Record<string, PortSide> = {};
    for (const [step, v] of acc) {
        // How strongly this card's flow runs LEFT to RIGHT. Both halves are signed the same way, so
        // a card whose source is on its left and whose target is on its right scores positively
        // twice, and one that has been dragged past both scores negatively twice.
        let pull = 0;
        if (v.outN > 0) pull += v.outSum / v.outN - v.own;
        if (v.inN > 0) pull += v.own - v.inSum / v.inN;

        const flipped = pull <= -AU_NODE_W;
        for (const spec of STEP_PORTS[step] ?? []) {
            const normal = defaultPortSide(spec.dir);
            out[portKey(step, spec.id)] = flipped ? (normal === 'l' ? 'r' : 'l') : normal;
        }
    }
    return out;
}

/** The side this port is on, or its default when nothing is wired to it. */
export function sideOf(
    sides: Record<string, PortSide>,
    step: StepKind,
    port: string,
): PortSide {
    const chosen = sides[portKey(step, port)];
    if (chosen) return chosen;
    const dir = STEP_PORTS[step]?.find((p) => p.id === port)?.dir ?? 'out';
    return defaultPortSide(dir);
}

/**
 * Where a port's dot sits on its card, in world units relative to the card's top-left.
 *
 * `side` is passed in rather than derived from the port's direction, because which edge a port uses
 * now depends on where the cards ARE (see `portSides`). It is a required argument on purpose: a
 * default here would let a caller that forgot it silently anchor wires to the old fixed edge while
 * the dot the user sees moved — the exact split this function's own comment warns about below.
 */
export function portAnchor(
    step: StepKind,
    port: string,
    pos: NodePos,
    side: PortSide,
): NodePos {
    const ports = STEP_PORTS[step];
    const spec = ports.find((p) => p.id === port);
    if (!spec) return { x: pos.x, y: pos.y };
    const column = ports.filter((p) => p.dir === spec.dir);
    const index = column.indexOf(spec);
    return {
        x: side === 'l' ? pos.x : pos.x + AU_NODE_W,
        y: pos.y + (AU_NODE_H * (index + 1)) / (column.length + 1),
    };
}

/**
 * A cubic between two anchors. The horizontal handles are what make it read as flow.
 *
 * Each handle points OUT of the edge its anchor sits on, so a wire always leaves and arrives
 * perpendicular to the card. With both sides fixed this was `from.x + reach` and `to.x - reach`,
 * which is the same thing while every wire runs left to right and a kink the moment one does not.
 */
export function auWirePath(
    from: NodePos,
    to: NodePos,
    // Required, for the same reason `portAnchor`'s `side` is: defaulting these to the old
    // left-to-right pair would let a caller that forgot them draw a correct-LOOKING curve out of the
    // wrong edge, with nothing failing to say so.
    fromSide: PortSide,
    toSide: PortSide,
): string {
    const reach = Math.max(46, Math.abs(to.x - from.x) / 2);
    const c1 = from.x + (fromSide === 'r' ? reach : -reach);
    const c2 = to.x + (toSide === 'r' ? reach : -reach);
    return `M ${from.x} ${from.y} C ${c1} ${from.y}, ${c2} ${to.y}, ${to.x} ${to.y}`;
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
 * What the editor is opening ON.
 *
 * It decides two things at once, and they are the same decision: **which steps the canvas draws**,
 * and **what the dirty check compares against**. Keeping them in one value is what stops a fourth
 * way of opening the editor from arriving with a canvas rule and no answer to "is this unsaved".
 *
 * - `'saved'` — an existing rule, opened from the list. All four steps drawn, because it is
 *   already a complete rule, and clean, because what is on screen is what is stored.
 * - `'blank'` — the gallery's blank card. Mockup §03's third state: an empty canvas and the
 *   "Start with Watch output" hint, so building a rule from nothing is a thing the palette
 *   TEACHES rather than a thing that has already happened. Clean, because nothing is there yet;
 *   a *Leave without saving?* prompt over an untouched blank rule is a dialog about nothing.
 * - `'seeded'` — "New automation for this terminal". Neither of the above: the menu has already
 *   made a choice on the user's behalf, so the canvas must SHOW that choice and the editor must
 *   know it is unsaved. See `draftFromRule` for both halves.
 * - `'template'` — a card picked from the gallery. Drawn exactly like `'saved'`, because a template
 *   IS a complete rule — but UNSAVED, because picking one is a choice the user made and nothing has
 *   stored it yet. Tam: *"select predefined template -> it should become Unsaved, when user close
 *   it should show confirmation"*.
 *
 * This used to be a boolean (`emptyCanvas`), then a three-way. It stopped being a boolean at the
 * moment there were three openings rather than two, and the fourth arrived for the same reason the
 * third did: a flag that cannot say what you need it to say is the wrong type, not a thing to
 * overload. Note that the four are **two independent questions** that happen to be answered
 * together — what the canvas draws, and what the dirty check compares against — and `'template'` is
 * the case that proves they are independent: it draws like `'saved'` and compares like nothing else.
 */
export type CanvasOpening = 'saved' | 'blank' | 'seeded' | 'template';

/**
 * Open the editor on a rule.
 *
 * **The `'seeded'` opening is the only one whose two arms differ, and both differences are the
 * point.** "New automation for this terminal" hands over a rule that already pins the terminal the
 * user right-clicked, and the editor used to open it on `'blank'`'s empty canvas — so the one thing
 * that had already been decided was the one thing nothing on screen said. The canvas showed the
 * palette hint for a step that was already configured, and the *Leave without saving?* guard let
 * Escape throw the pinned terminal away without a word, because the draft and its own baseline were
 * the same object and so it read clean.
 *
 * So `'seeded'` draws `monitor` and selects it — the inspector opens on *Watch output* with the
 * terminal already ticked, which is the state the menu row promised — and the BASELINE is this rule
 * with the seeded pick removed. That is what makes the dirty check honest rather than merely loud:
 * it names the pinned terminal as the unsaved work, so the prompt is telling the truth about what
 * closing would cost, it clears itself the moment the rule is saved, and a user who unticks that
 * terminal and changes nothing else is back AT THE BASELINE and is not nagged on the way out.
 * `targetIds` alone, and not `targetMode`: `'pinned'` with an empty pick set is the mode the picker
 * itself renders, so the baseline stays a rule the editor could actually be showing.
 *
 * **`'template'` is the same argument with everything in it.** The gallery used to hand a picked
 * template over on `'saved'`, whose baseline is the rule itself — so a template read CLEAN, and
 * Escape threw away the card the user had just chosen without a word. Identical to the `'seeded'`
 * defect one screen to the left: a choice had been made and nothing on the way out said so. Its
 * baseline is the blank rule the gallery was showing BEFORE the click, which makes the whole
 * template the unsaved work, because that is what it is.
 *
 * **"Back at the baseline" is not "back to a blank rule", and the two are distinguishable on
 * screen.** `newDraftFor` contributes `targetMode: 'pinned'` as well as the pick, and the baseline
 * keeps the mode — so an unticked seeded draft is a PINNED rule watching nothing, which `problems()`
 * reports as the blocking `targets.empty`, while `blankDraft()` is `'rule'`/`allTerminals` and has
 * no problem at all. All the dirty check claims there is that nothing is UNSAVED, which is true.
 * Whether the rule is finishable is a different question, asked and answered by `problems()`.
 */
export function draftFromRule(rule: AutomationRule, opening: CanvasOpening = 'saved'): AutomationDraft {
    // `'blank'` alone draws nothing; `'seeded'` draws the one step it configured; `'saved'` and
    // `'template'` are both complete rules and draw all four.
    const present: StepKind[] = opening === 'blank'
        ? []
        : opening === 'seeded'
            ? ['monitor']
            : [...STEP_ORDER];
    const layout = layoutOf(rule);
    // **The rule and the baseline are the SAME object, layout already resolved.** A rule saved
    // before this field existed has no `graph.layout`, so the arrangement it opens with is the
    // default one — and if the baseline kept the absent field while the draft carried the resolved
    // one, every such rule would read dirty the instant it opened, with a *Leave without saving?*
    // prompt over an untouched rule. Resolving once and using it for both sides is the same
    // both-sides rule `comparable` follows below.
    const resolved: AutomationRule = { ...rule, graph: { ...rule.graph, layout } };
    return {
        rule: resolved,
        present,
        wires: defaultWires(present),
        layout,
        // `'blank'` alone opens with nothing selected: it is the only opening with nothing on the
        // canvas to select. `'seeded'` selects the step it drew, which is what puts the pinned
        // terminal in front of the user instead of one palette drag away from being noticed.
        selected: opening === 'blank' ? null : 'monitor',
        saved: baselineFor(opening, resolved, layout),
    };
}

/**
 * The value the dirty check compares against — *what leaving would throw away*, stated as a rule.
 *
 * Two of the four openings answer with something other than the rule itself, and in both the
 * DIFFERENCE is precisely the unsaved work:
 *
 * - `'seeded'` drops the terminal the menu pinned, so the prompt is about that pick and clears
 *   itself if the user unticks it.
 * - `'template'` drops everything, because everything is unsaved: the baseline is the blank rule the
 *   gallery was showing before the card was clicked. It carries the RESOLVED layout so that the
 *   arrangement alone can never be what makes a freshly picked template read dirty — the same
 *   both-sides rule `comparable` follows, and the same one that keeps a layout-less legacy rule from
 *   opening dirty.
 *
 * `'saved'` and `'blank'` are the rule itself. An existing rule is already stored, and a blank canvas
 * has nothing on it yet — a *Leave without saving?* prompt over either is a dialog about nothing.
 */
function baselineFor(
    opening: CanvasOpening,
    resolved: AutomationRule,
    layout: Record<StepKind, NodePos>,
): AutomationRule {
    if (opening === 'seeded') return { ...resolved, targetIds: [] };
    if (opening === 'template') {
        const blank = blankDraft();
        return { ...blank, graph: { ...blank.graph, layout } };
    }
    return resolved;
}

/** The saved arrangement, or the default one for a rule that predates the field. */
function layoutOf(rule: AutomationRule): Record<StepKind, NodePos> {
    const saved = rule.graph.layout;
    if (!saved) return { ...DEFAULT_LAYOUT };
    const out = { ...DEFAULT_LAYOUT };
    // Step by step rather than a spread of `saved`, so a blob carrying a key this build does not
    // know cannot put an unplaceable card into the layout.
    for (const step of STEP_ORDER) {
        const pos = saved[step];
        if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
            out[step] = { x: pos.x, y: pos.y };
        }
    }
    return out;
}

/**
 * What a save sends.
 *
 * The canvas ARRANGEMENT is part of it; which steps are drawn and how they are wired still is not.
 * `present` and `wires` are re-derived from the four steps on every open and carry no user choice,
 * but a card's position is a choice, and one the user expects to survive — which is exactly what
 * makes it dirty-able and therefore what makes the unsaved-changes prompt honest.
 *
 * Injected HERE rather than mirrored into `draft.rule` on every drag, so `draft.layout` stays the
 * single owner of the arrangement and the two cannot disagree.
 */
export function ruleFromDraft(draft: AutomationDraft): AutomationRule {
    return { ...draft.rule, graph: { ...draft.rule.graph, layout: draft.layout } };
}

/**
 * Is there unsaved work?
 *
 * Structural equality over the DTO, via JSON — the shape is small, known, and has no `undefined`
 * holes or cycles, and every field is one the store round-trips. A field-by-field comparison would
 * be a fifth place to add a field to (§7.7 already names four), and the one that fails silently.
 */
export function isDirty(draft: AutomationDraft): boolean {
    // `ruleFromDraft`, not `draft.rule` — dirtiness has to be asked of exactly what a save would
    // WRITE, or a change that only reaches the DTO at save time (the layout) is invisible here and
    // the editor closes without a word over work the user can see on screen.
    return comparable(ruleFromDraft(draft)) !== comparable(draft.saved);
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
    // The layout is normalised for the same reason `targetIds` is, and it is a stronger case: this
    // one crosses the wire into a Rust `BTreeMap` and comes back with ITS key order, while the
    // draft's own object carries insertion order. Two orders of the same four positions are the
    // same arrangement, and `JSON.stringify` cannot know that.
    const layout = rule.graph.layout;
    const graph = layout
        ? {
              ...rule.graph,
              layout: Object.fromEntries(
                  Object.keys(layout)
                      .sort()
                      .map((k) => [k, layout[k]]),
              ),
          }
        : rule.graph;
    return JSON.stringify({ ...rule, graph, targetIds: [...rule.targetIds].sort() });
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
    /**
     * The whole clause list, replaced — the same shape `targets` already uses for `targetIds`
     * (plan 032 §5.9), rather than `CondPanel` reaching for the generic `cond` patch to smuggle an
     * array through `Partial<AutomationRule['graph']['cond']>`. `CondPanel` computes the next
     * array itself (add/remove/edit a row) and dispatches the whole thing; the reducer only merges
     * it into `cond`, exactly like every other field there.
     */
    | { type: 'clauses'; clauses: AutomationClause[] }
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
        case 'clauses':
            // **A clause list SUPERSEDES `op`/`threshold`, so adding one has to clear the pair.**
            // §5.3 makes them v1-only: read at load, folded into `clauses` by `fold_v1_clauses`,
            // never written again. Merging `clauses` alone left them on the row, and
            // `skip_serializing_if = "Option::is_none"` re-wrote them on the next save — a row
            // carrying two contradictory conditions, where THIS build runs the clause and an older
            // one ignores `clauses` entirely and runs `> 25`.
            //
            // Only when the resulting list is non-empty: removing the last clause from a v1 rule
            // must leave it the rule it was, not silently strip its only comparison.
            return withGraph(draft, {
                cond: action.clauses.length > 0
                    ? { ...rule.graph.cond, clauses: action.clauses, op: null, threshold: null }
                    : { ...rule.graph.cond, clauses: action.clauses },
            });
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
