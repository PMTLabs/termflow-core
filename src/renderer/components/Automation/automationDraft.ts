/**
 * The one draft the whole editor is derived from (plan 028 §6.2).
 *
 * `useReducer(draftReducer, …)` over a single value. **Nothing derived is stored**: problems, faces,
 * the palette summary, the header's blocked reason and every inspector panel are computed in render
 * by `automationValidation` and `automationDerive`, memoised on the draft alone.
 *
 * ## What round-trips, and what does not
 *
 * `rule` is the wire DTO — it comes back from the store the same shape it went out in. `present` and
 * `wires` are **session-only canvas state**, re-derived on every open from the steps the rule HAS:
 * they carry no user choice, so the canvas is a *drawing of* the rule. What a save writes is not
 * quite `rule` as it stands, though — see `ruleFromDraft` for the one group of steps the canvas gets
 * to omit.
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
import type {
    AutomationClause,
    AutomationCondStep,
    AutomationMonitorStep,
    AutomationParseStep,
    AutomationRule,
    AutomationTimerMode,
} from '../../types/electron';
import type { StepKind, TimerShape, Wire } from './automationSteps';
import { INPUT_STEPS, STEP_ORDER, STEP_PORTS, defaultWires, samePort } from './automationSteps';
import { applyPreset, setFind, setLiteral } from './automationPresets';
// The gallery's own starting point, used here as the `'template'` opening's dirty BASELINE — the
// state the gallery was showing before a card was clicked. Same direction `AutomationMenuSection`
// already imports it in; `automationTemplates` imports nothing back, so there is no cycle.
import { blankDraft } from '../Settings/Automations/automationTemplates';

export interface NodePos {
    x: number;
    y: number;
}

/** A finished rule is a handful of cards on a ~900×260 world (§6.5) — hence no minimap. */
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
    // Fourth, where a DELAY sits — between the verdict and the send (§6.2). A schedule rule has no
    // cards to its left, so it opens with a wide empty gutter and its two cards on the right; that
    // is a fit-to-content question for the viewport, which `AuCanvas` already answers from
    // `draft.present`, not a reason to give one kind two default positions.
    timer: { x: AU_GAP_X * 3, y: 0 },
    action: { x: AU_GAP_X * 4, y: 0 },
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

/**
 * Which of the wait step's two modes this rule is in — **the one place the DTO is read for it**.
 *
 * `automationSteps` is arithmetic over names and does not read a rule; it takes the answer as an
 * argument (`defaultWires`' `shape`). This is the function that produces it, so a second reading of
 * `graph.timer.mode` cannot drift from the first. A rule with no wait step answers `'afterMatch'`,
 * which is the shape whose wires a rule without one is a subset of — the four-step chain.
 */
export function timerShapeOf(rule: AutomationRule): TimerShape {
    const mode = rule.graph.timer?.mode;
    return mode && 'dailyAt' in mode ? 'dailyAt' : 'afterMatch';
}

/**
 * The wait a newly added step holds until the user says otherwise (mockup §02's own scenario).
 *
 * Delay mode, because that is the mode with a predecessor: dropping the card at the end of a
 * finished rule and having it fire on a clock instead would silently stop the rule watching
 * anything (§6.3, and `timer.scheduleWithMonitor`). Thirty seconds is the brief's own example and
 * is comfortably inside `MIN_DELAY_MS`..`MAX_DELAY_MS`, so the card is not born blocked.
 */
export const DEFAULT_TIMER_MODE: AutomationTimerMode = { afterMatch: { delayMs: 30_000 } };

/**
 * What *At a time of day* starts from — mockup §03's own rule, 09:00 on weekdays.
 *
 * A default that picks days matters more than the hour does: an empty mask is `timer.noDays`, so a
 * mask-less default would block the rule the instant the radio moved, which is a control punishing
 * the user for using it. Bits 0–6 are Mon..Sun (§3.1).
 */
export const DEFAULT_SCHEDULE_MODE: AutomationTimerMode = {
    dailyAt: { minuteOfDay: 9 * 60, days: 0b0001_1111 },
};

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
    /** Which steps are on the canvas: the ones a template or an existing rule HAS; none for a blank. */
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
 * - `'saved'` — an existing rule, opened from the list. Every step the rule HAS is drawn, because it
 *   is already a complete rule, and clean, because what is on screen is what is stored.
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
    // `'template'` are complete rules and draw **the steps their graph actually holds**.
    //
    // That last arm used to draw all four original steps whatever the graph held, on the premise —
    // written out beside `canAddStep` — that *"a rule's graph carries all four steps whatever is
    // drawn"*. §3.1 made it false: `monitor`, `parse` and `cond` are `Option` now and a schedule
    // rule (§6.3) genuinely has none of them. Two symptoms were reported separately from one cause.
    // A saved schedule rule opened with three cards standing for steps it does not have, whose
    // panels render nothing; and it could never have them ADDED back, because `canAddStep` refused
    // each one as *"This rule already has a Watch step"* while `graph.monitor` was absent. The user
    // was stuck with the shape they first saved.
    //
    // **`'blank'` and `'seeded'` stay opening-driven, and must.** `blankDraft()` materialises all
    // four steps as a SCAFFOLD, so deriving from the graph there would draw four cards on a canvas
    // whose whole point is that it is empty. The two new-rule openings are saying something the
    // graph cannot.
    //
    // `action` is drawn unconditionally because §3.1 keeps it required — there is no absence to
    // detect — and the wait is drawn on the same rule as the other three now, rather than as the
    // exception it used to be: a rule that has one gets its card, a rule that does not can be
    // offered one by the palette.
    const present: StepKind[] = opening === 'blank'
        ? []
        : opening === 'seeded'
            ? ['monitor']
            : STEP_ORDER.filter((s) => s === 'action' || rule.graph[s] != null);
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
        wires: defaultWires(present, timerShapeOf(resolved)),
        layout,
        // `'blank'` alone opens with nothing selected: it is the only opening with nothing on the
        // canvas to select. `'seeded'` selects the step it drew, which is what puts the pinned
        // terminal in front of the user instead of one palette drag away from being noticed.
        selected: opening === 'blank' ? null : 'monitor',
        saved: baselineFor(opening, resolved, layout, present),
    };
}

/**
 * The graph as a save would WRITE it — the group omission C1 turns on, in one place.
 *
 * Applied to the draft's own rule by `ruleFromDraft` and to the dirty check's BASELINE by
 * `baselineFor`, from the same `present`. One side only is what `comparable`'s own header forbids:
 * a blank canvas omits the three input steps on the way out, so a baseline that kept them made
 * every untouched blank rule read dirty the instant it opened — a *Leave without saving?* prompt
 * over a dialog about nothing, which is the exact defect `'blank'`'s baseline exists to prevent.
 */
function graphAsWritten(
    graph: AutomationRule['graph'],
    present: readonly StepKind[],
): AutomationRule['graph'] {
    if (INPUT_STEPS.some((s) => present.includes(s))) return graph;
    // The KEYS go, not `undefined` values: §3.1's own note says the backend omits an absent step
    // rather than sending `null`, so an absent step must not decode as a present-but-empty one.
    const { monitor: _m, parse: _p, cond: _c, ...rest } = graph;
    return rest;
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
    present: readonly StepKind[],
): AutomationRule {
    const base = opening === 'template'
        ? { ...blankDraft(), graph: { ...blankDraft().graph, layout } }
        : opening === 'seeded'
            ? { ...resolved, targetIds: [] }
            : resolved;
    // Both sides through the same omission — see `graphAsWritten`.
    return { ...base, graph: graphAsWritten(base.graph, present) };
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
 * The canvas ARRANGEMENT is part of it, and so — for the three INPUT steps, as a group — is which
 * cards are drawn. How they are wired still is not: `wires` is re-derived on every open from the
 * steps the rule has and carries no user choice, while a card's position is a choice, and one the
 * user expects to survive — which is exactly what makes it dirty-able and therefore what makes the
 * unsaved-changes prompt honest.
 *
 * Injected HERE rather than mirrored into `draft.rule` on every drag, so `draft.layout` stays the
 * single owner of the arrangement and the two cannot disagree.
 *
 * **`monitor`, `parse` and `cond` are omitted when the canvas draws none of them — as a GROUP,
 * never one at a time (C1).** `blankDraft()` scaffolds all three into the graph and there is no
 * remove gesture, so a user who dragged *Wait* and *Send to terminal* onto an empty canvas and
 * picked *At a time of day* produced a rule carrying a monitor: `timer.scheduleWithMonitor` blocked
 * it, the header refused to enable it, `set_enabled_checked` refused it independently, and the
 * blocking message told them to *"remove the Watch output step"* — a control that does not exist.
 * The milestone's headline feature could not be authored in the product at all.
 *
 * **Per step it would open a worse hole than it closes**, which is why the group is the unit.
 * *Watch → Wait → Send* would then write a monitor with no parse and no cond, and NOTHING reports
 * that: `patternProblems` returns nothing for an absent parse and `clauseProblems` nothing for an
 * absent cond, both deliberately, and there is no `ProblemCode` for *"this rule can never run"*.
 * The rule would save, enable, count as live and never evaluate — where today the scaffold's blank
 * `find` at least blocks it visibly with `parse.empty`. All-or-nothing is also
 * `eval::InputSteps::of`'s own contract, so this follows the runtime's rule rather than inventing a
 * second one: any canvas keeping one input step keeps all three, and `parse.empty` goes on catching
 * the partial cases.
 *
 * `action` is never omitted — §3.1 keeps it required on the DTO — and `timer` needs no rule here,
 * because `addStep` materialises it into the graph exactly when the canvas reveals it.
 *
 * **`op`/`threshold` are dropped from the row that carries clauses, and only from that row.** §5.3
 * makes the pair v1-only — read at load, folded into `clauses` by `fold_v1_clauses`, never written
 * again — and leaving it on a clause-carrying row writes two contradictory conditions, where THIS
 * build runs the clause and an older one ignores `clauses` entirely and runs `> 25`.
 *
 * Asked HERE rather than in the reducer's `clauses` case, which is where it was: a gate in the
 * caller is one every later path opts out of, and this one was already defeated by the shortest
 * sequence there is. *+ Add a comparison* nulled the pair on the way in, *Remove comparison 1* left
 * the list empty, and the rule was then blocked and saved with its only comparison gone. Asked of
 * the row being WRITTEN, an empty list simply never reaches the clearing.
 *
 * **Only when the pair is actually there.** Writing `op: null` unconditionally would ADD two keys
 * to every v2 rule, whose stored `cond` omits them (`skip_serializing_if = "Option::is_none"`) —
 * and `isDirty` compares this against the rule as it came off the wire, so every clause rule would
 * have opened reading dirty. The same both-sides rule `comparable` and `draftFromRule` follow.
 */
export function ruleFromDraft(draft: AutomationDraft): AutomationRule {
    const graph = { ...draft.rule.graph, layout: draft.layout };
    const cond = graph.cond;
    if (cond && (cond.clauses ?? []).length > 0 && (cond.op != null || cond.threshold != null)) {
        graph.cond = { ...cond, op: null, threshold: null };
    }
    return { ...draft.rule, graph: graphAsWritten(graph, draft.present) };
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
    // draft's own object carries insertion order. Two orders of the same positions are the same
    // arrangement, and `JSON.stringify` cannot know that.
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
    | { type: 'monitor'; patch: Partial<AutomationMonitorStep> }
    | { type: 'preset'; preset: AutomationParseStep['preset'] }
    | { type: 'literal'; literal: string }
    | { type: 'find'; find: string }
    | { type: 'keep'; keep: AutomationParseStep['keep'] }
    | { type: 'cond'; patch: Partial<AutomationCondStep> }
    /**
     * The whole clause list, replaced — the same shape `targets` already uses for `targetIds`
     * (plan 032 §5.9), rather than `CondPanel` reaching for the generic `cond` patch to smuggle an
     * array through `Partial<AutomationRule['graph']['cond']>`. `CondPanel` computes the next
     * array itself (add/remove/edit a row) and dispatches the whole thing; the reducer only merges
     * it into `cond`, exactly like every other field there.
     */
    | { type: 'clauses'; clauses: AutomationClause[] }
    /**
     * The whole mode, replaced — never a patch.
     *
     * `AutomationTimerMode` is externally tagged (`{afterMatch:…}` / `{dailyAt:…}`) and Rust's
     * `TimerMode` is an enum, so a value carrying both keys is not a mode with a stale field in it:
     * it is a blob `serde_json` refuses. A `Partial<…>` here would make that shape expressible, and
     * expressible-but-refused is the shape that saves clean and comes back broken.
     */
    | { type: 'timer'; mode: AutomationTimerMode }
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

/**
 * How far below a card the next row of cards begins — the vertical twin of `AU_GAP_X`'s reasoning.
 *
 * Only `freeSlot` uses it, and only when a default slot is already occupied. Big enough that the two
 * cards read as two rows rather than as a near-miss; `AU_NODE_H` alone would leave their borders
 * touching.
 */
const AU_GAP_Y = 48;

/** Do two cards' boxes overlap at all? `AU_NODE_W` × `AU_NODE_H`, axis-aligned. */
const overlaps = (a: NodePos, b: NodePos): boolean =>
    Math.abs(a.x - b.x) < AU_NODE_W && Math.abs(a.y - b.y) < AU_NODE_H;

/**
 * Where to draw a card the palette has just added — **its default slot, unless something is
 * standing in it**.
 *
 * `addStep` used to place nothing at all, so a new card simply took `DEFAULT_LAYOUT`'s position
 * whatever was already there. A template does not show it: a template carries no persisted
 * `graph.layout`, so every card is at its default and the wait's column is empty. It takes a rule
 * whose arrangement was SAVED with a card in that slot — a layout persisted before `timer` was
 * inserted at the fourth position, where `action` sat at `AU_GAP_X * 3`, or, needing no upgrade at
 * all, any card the user dragged there and saved.
 *
 * **Pushed DOWN rather than along**, because the column carries meaning: the wait belongs between
 * the comparison and the send, and a card shunted right of the send would be drawn in the wrong
 * place to avoid being drawn in the same place. A row below is unambiguous, obviously deliberate,
 * and one drag from wherever the user wants it.
 *
 * Only the cards on the CANVAS are avoided. `layout` carries a position for every kind, drawn or
 * not, so testing against all of them would dodge cards that are not there.
 */
function freeSlot(
    layout: Record<StepKind, NodePos>,
    drawn: readonly StepKind[],
    step: StepKind,
): NodePos {
    let pos = layout[step] ?? DEFAULT_LAYOUT[step];
    const others = drawn.filter((s) => s !== step).map((s) => layout[s]).filter(Boolean);
    // Bounded by the number of cards: each pass clears at least the lowest card it collided with,
    // so it cannot run longer than there are cards to clear.
    for (let guard = 0; guard <= others.length; guard += 1) {
        const hit = others.filter((p) => overlaps(pos, p));
        if (hit.length === 0) break;
        pos = { x: pos.x, y: Math.max(...hit.map((p) => p.y)) + AU_NODE_H + AU_GAP_Y };
    }
    return pos;
}

/**
 * The rule with the graph fields a newly revealed card needs — see `addStep`'s own note.
 *
 * Returns the rule UNCHANGED when there is nothing to fill in, so `addStep` on a complete rule is
 * still presentation-only and cannot make an unedited draft read dirty.
 */
function materialise(rule: AutomationRule, step: StepKind): AutomationRule {
    if (step === 'timer') {
        return rule.graph.timer == null
            ? { ...rule, graph: { ...rule.graph, timer: { mode: DEFAULT_TIMER_MODE } } }
            : rule;
    }
    if (step === 'action' || INPUT_STEPS.every((s) => rule.graph[s] != null)) return rule;
    const blank = blankDraft().graph;
    return {
        ...rule,
        graph: {
            ...rule.graph,
            monitor: rule.graph.monitor ?? blank.monitor,
            parse: rule.graph.parse ?? blank.parse,
            cond: rule.graph.cond ?? blank.cond,
        },
    };
}

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
        // **A patch to a step the rule does not have is a no-op, never a materialisation.** Plan
        // 032 §3.1 lets a schedule rule carry no monitor/parse/cond at all, and these six actions
        // come from panels that are only mounted for a step the rule HAS. Filling the gap in from
        // a default here would mint the step behind the user's back — and for `parse` that default
        // is an EMPTY pattern, which matches everything. Authoring a step that is absent belongs to
        // the palette (tasks 23-25), which adds it explicitly.
        case 'monitor':
            return rule.graph.monitor
                ? withGraph(draft, { monitor: { ...rule.graph.monitor, ...action.patch } })
                : draft;
        case 'preset':
            return rule.graph.parse
                ? withGraph(draft, { parse: applyPreset(rule.graph.parse, action.preset) })
                : draft;
        case 'literal':
            return rule.graph.parse
                ? withGraph(draft, { parse: setLiteral(rule.graph.parse, action.literal) })
                : draft;
        case 'find':
            return rule.graph.parse
                ? withGraph(draft, { parse: setFind(rule.graph.parse, action.find) })
                : draft;
        case 'keep':
            return rule.graph.parse
                ? withGraph(draft, { parse: { ...rule.graph.parse, keep: action.keep } })
                : draft;
        case 'cond':
            return rule.graph.cond
                ? withGraph(draft, { cond: { ...rule.graph.cond, ...action.patch } })
                : draft;
        case 'clauses':
            // **The clause list, and nothing else.** A clause list supersedes `op`/`threshold`
            // (§5.3), but clearing the pair HERE is a gate in the caller: it fires on the way in,
            // so `+ Add a comparison` followed by `Remove comparison 1` left a v1 rule with an
            // empty list AND no pair — blocked, and saved with its only comparison gone. The
            // clearing belongs to `ruleFromDraft`, which asks the question of the row actually
            // being written rather than of a keystroke on the way to it.
            if (!rule.graph.cond) return draft;
            return withGraph(draft, { cond: { ...rule.graph.cond, clauses: action.clauses } });
        case 'timer': {
            // The same no-op discipline the five patches above follow: `TimerPanel` is mounted only
            // for a rule that HAS the step, and filling one in from a default here would mint a
            // wait behind the user's back. The palette's `addStep` is what adds one.
            if (!rule.graph.timer) return draft;
            const next = { ...rule, graph: { ...rule.graph, timer: { mode: action.mode } } };
            // **The wires follow the mode**, and this is the only place they can: the two modes draw
            // different pictures (§6.2 threads the wait between the verdict and the send, §6.3 makes
            // it the only wire), and `wires` is re-derived on open and on `addStep` and nowhere else.
            // Without this, switching to a schedule left the canvas drawing the delay's chain over a
            // rule that no longer reads anything.
            return { ...draft, rule: next, wires: defaultWires(draft.present, timerShapeOf(next)) };
        }
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
            // **An add MATERIALISES whatever it reveals.** Revealing a card over nothing gives the
            // panel no step to bind to and the save nothing to write — which was already the
            // reasoning for the wait step, and is a fact about ABSENCE rather than about timers.
            // Task 29 made it general: `draftFromRule` now draws only the steps a rule has, so
            // `monitor`, `parse` and `cond` can be absent when the palette offers them too.
            //
            // **The three input steps materialise as a GROUP**, the same all-or-nothing contract
            // `ruleFromDraft` writes them under and `eval::InputSteps::of` reads them under. Filling
            // in only the revealed card would put a monitor with no parse into the graph, and
            // nothing reports that shape: `reload` admits it (it has something to watch),
            // `InputSteps::of` then answers `None`, and `evaluate_pair` declines it on every tick
            // for the life of the rule, silently.
            //
            // Shapes come from `blankDraft()`, never from a second set of defaults written here —
            // two answers to *"what does an empty Watch step look like"* would drift.
            const next = materialise(rule, action.step);
            return {
                ...draft,
                rule: next,
                present,
                wires: defaultWires(present, timerShapeOf(next)),
                // Clear of the cards already on the canvas — see `freeSlot`. A drag supplies its own
                // position and the editor dispatches `moveStep` straight after this, so this is the
                // answer for the CLICK path and the starting point for the drag one.
                layout: { ...draft.layout, [action.step]: freeSlot(draft.layout, present, action.step) },
                selected: action.step,
            };
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
