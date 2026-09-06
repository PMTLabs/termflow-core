/**
 * The five steps, their typed ports, and the one function that decides whether a wire is legal
 * (plan 028 §6.3, plan 032 §6.2/§6.3/§9, mockup §03).
 *
 * **Canvas Mode's ports are undirected 4-compass geometry with no type system**, and the only
 * refusal it has rejects a null target — so `useWireDrag` is a pattern to copy, not code to reuse.
 * Everything here is arithmetic over names: no React, no DOM, no draft mutation, which is what makes
 * §10.21's ordered-pair matrix a cheap and total test rather than a sampling of the interesting
 * cases.
 *
 * **The five step KINDS are fixed; a rule having all five is not.** This file's arithmetic is over
 * the names — the order, the ports, which pairs may be wired — and none of it reads `rule.graph`.
 * That is what keeps it true while the DTO changes underneath it: plan 032 §3.1 made `monitor`,
 * `parse` and `cond` optional, so a schedule rule (§6.3) is `action` and a `timer` and nothing else.
 * The header used to say *"a rule is always monitor → parse → cond → action, and the DTO has a field
 * for each"*, which the DTO and every schedule-rule comment in this milestone contradict.
 *
 * **The one thing here that is NOT arithmetic over the names is `defaultWires`' second argument.**
 * The wait step has two modes and they imply different pictures — delay threads it between the
 * verdict and the send, schedule makes it the only wire on the canvas — so the shape is passed IN
 * rather than read off a rule. `automationDraft`'s `timerShapeOf` is the one place that reads the
 * DTO to answer it.
 *
 * What the canvas adds is *which of them the user has put on it yet* — a brand-new rule opens on an
 * empty canvas (mockup §03's third state) and the palette is how it gets built. `present` is
 * session-only presentation, not persistence: it is re-derived on every open. It used to be
 * re-derived as *all four original steps whatever the graph holds*; since task 29 a saved rule
 * draws **the steps it actually has**, so a schedule rule opens on its clock and its send and
 * nothing else. `automationDerive`'s *not in this rule* placeholder and `absent` node tone are
 * still reached — by a rule whose graph a MAKER other than this editor wrote, and by the test pane
 * — but no longer by every schedule rule on open.
 */

export type StepKind = 'monitor' | 'parse' | 'cond' | 'timer' | 'action';

/**
 * Left to right, and also the order the palette lists them and the problem list reports them.
 *
 * **`timer` sits fourth, between the comparison and the send**, which is where a DELAY sits — and
 * a schedule rule, where the wait is the first thing that happens, simply has no cards to its left.
 * A per-mode order would make the palette's list and the problem list's order depend on a field
 * inside one of the steps they are listing, and `automation_validation` already emits its problems
 * in this order (targets, monitor, parse, cond, timer, action) on both sides of the wire.
 */
export const STEP_ORDER: readonly StepKind[] = Object.freeze([
    'monitor',
    'parse',
    'cond',
    'timer',
    'action',
]);

/**
 * The rule's INPUT — the three steps that read a terminal, **and the group they travel as** (§3.1).
 *
 * `eval::InputSteps::of` answers `None` unless a graph holds all three, and its own doc says why:
 * *"a `monitor` with no `parse` has no pattern to look for, and a `cond` with no `parse` has nothing
 * to compare, so a rule holding a strict subset cannot be evaluated either"*. That is a fact about
 * the runtime, so the editor mirrors it rather than inventing a second contract —
 * `ruleFromDraft` omits these three together or not at all, and nothing writes a strict subset.
 *
 * `timer` and `action` are deliberately not here: the wait reads nothing, and the send is the one
 * step every rule has.
 */
export const INPUT_STEPS: readonly StepKind[] = Object.freeze(['monitor', 'parse', 'cond']);

/**
 * Which of the wait step's two modes a rule is in — the DTO's own two spellings (§6.2, §6.3).
 *
 * A string rather than the DTO type, because nothing in this module reads a rule: the caller looks
 * at `graph.timer.mode` once (`automationDraft.timerShapeOf`) and hands the answer down.
 */
export type TimerShape = 'afterMatch' | 'dailyAt';

/**
 * **"Wait", never "Timer".** `AutomationCadence`'s `'timer'` already means the monitor's poll
 * interval, and a user reading two controls called Timer on one screen has no way to tell which is
 * which. The identifier stays `timer` — it is the DTO's own field name (§3.1) — and every string
 * a user reads says Wait.
 */
export const STEP_LABELS: Record<StepKind, string> = {
    monitor: 'Watch output',
    parse: 'Read a value',
    cond: 'Compare it',
    timer: 'Wait',
    action: 'Send to terminal',
};

/** The line under the title in the inspector head — *Step 2 · find text, pull a number out*. */
export const STEP_SUBTITLES: Record<StepKind, string> = {
    monitor: 'which terminals, and what to read',
    parse: 'find text, pull a number out',
    cond: 'decide yes or no',
    timer: 'hold, or fire on the clock',
    action: 'what happens when it fires',
};

/** What travels on a wire. Three types, and only equal types connect. */
export type PortType = 'lines' | 'value' | 'verdict';

/** How a type is named in a refusal, so the message says what the user is looking at. */
const TYPE_NOUNS: Record<PortType, string> = {
    lines: 'matched lines',
    value: 'a value',
    verdict: 'a yes or no',
};

export interface PortSpec {
    id: string;
    dir: 'in' | 'out';
    type: PortType;
    /** The dot's own label on the node — `yes` / `no` on the compare step's two outputs. */
    label: string;
}

/**
 * The static port table. `cond` has **two** outputs and the mockup draws both, wired or not: seeing
 * the unused `no` port is how a user learns that nothing happens on the other path.
 *
 * **Declared `as const` so the port IDS survive as literal types**, which is what lets `OutPortKey`
 * below be derived from this table instead of typed out beside it. `STEP_PORTS` itself keeps the
 * wide `Record<StepKind, readonly PortSpec[]>` annotation, so every reader is unaffected.
 */
const PORTS = {
    monitor: Object.freeze([{ id: 'out', dir: 'out', type: 'lines', label: 'lines' }] as const),
    parse: Object.freeze([
        { id: 'in', dir: 'in', type: 'lines', label: 'lines' },
        { id: 'out', dir: 'out', type: 'value', label: 'value' },
    ] as const),
    cond: Object.freeze([
        { id: 'in', dir: 'in', type: 'value', label: 'value' },
        { id: 'true', dir: 'out', type: 'verdict', label: 'yes' },
        { id: 'false', dir: 'out', type: 'verdict', label: 'no' },
    ] as const),
    /**
     * **Both ports carry a verdict, and both exist in both modes.** In delay mode the crossing
     * arrives on `in` and leaves on `out` `delayMs` later; in schedule mode nothing arrives at all
     * and `in` is simply never wired — the same deliberate empty port `cond`'s `no` output has
     * always been. A mode-dependent port table would make `allPorts()`, `portAnchor` and
     * `portSides` all take a mode they otherwise have no use for, to hide a dot rather than to
     * change what a wire may do.
     *
     * **The two LABELS differ, because they are not the same thing arriving and leaving.** Both
     * used to read `verdict`, so the card said verdict → verdict and named nothing that happens in
     * between. What arrives is the comparison's yes; what leaves is the wait being over, on a rule
     * that has no comparison at all in schedule mode — so the outgoing dot says `go`.
     */
    timer: Object.freeze([
        { id: 'in', dir: 'in', type: 'verdict', label: 'verdict' },
        { id: 'out', dir: 'out', type: 'verdict', label: 'go' },
    ] as const),
    action: Object.freeze([{ id: 'in', dir: 'in', type: 'verdict', label: 'verdict' }] as const),
} as const;

export const STEP_PORTS: Record<StepKind, readonly PortSpec[]> = PORTS;

/**
 * The map key of every port a wire can LEAVE — `'monitor.out' | 'parse.out' | 'cond.true' |
 * 'cond.false' | 'timer.out'`, derived from `PORTS` rather than written out.
 *
 * A wire chip is keyed by its source port, and `AuWires` draws a bare `·` for a key with no entry.
 * That map was a `Record<string, string>` built from four hardcoded keys, so `timer.out` had none
 * and the Wait → Send wire — the ONLY wire on a schedule rule's canvas — rendered as a dot beside
 * four wires reading `lines` / `value` / `yes/no` / `verdict`. The same index-signature class task
 * 23 fixed at `FIELD_STEPS`, fixed the same way: a `Record<OutPortKey, …>` fails `tsc` on a missing
 * key, so the NEXT port cannot be forgotten silently.
 *
 * `action` contributes nothing — it has no output — and `` `action.${never}` `` is `never`, so the
 * union simply does not mention it.
 */
type OutPortIds<K extends StepKind> = Extract<(typeof PORTS)[K][number], { dir: 'out' }>['id'];
export type OutPortKey = { [K in StepKind]: `${K}.${OutPortIds<K>}` }[StepKind];

export interface PortRef {
    step: StepKind;
    port: string;
}

export interface Wire {
    from: PortRef;
    to: PortRef;
}

/** Why a drop was refused, in the words the toast shows. */
export interface Refusal {
    reason: string;
}

export function portSpec(ref: PortRef): PortSpec | null {
    return STEP_PORTS[ref.step]?.find((p) => p.id === ref.port) ?? null;
}

export function samePort(a: PortRef, b: PortRef): boolean {
    return a.step === b.step && a.port === b.port;
}

/** Every port on every step, in a stable order — the matrix §10.21 sweeps. */
export function allPorts(): PortRef[] {
    return STEP_ORDER.flatMap((step) => STEP_PORTS[step].map((p) => ({ step, port: p.id })));
}

/**
 * Whether `from → to` may be wired, and why not when it may not.
 *
 * Checked in this order, and the order is the message: **direction**, then **self**, then **type**,
 * then **arity**. A user dragging backwards from an input should be told about direction, not about
 * a type mismatch that is a consequence of it.
 */
export function canConnect(
    draft: { wires: Wire[] },
    from: PortRef,
    to: PortRef,
): Refusal | null {
    const a = portSpec(from);
    const b = portSpec(to);
    if (!a || !b) return { reason: 'That is not a connection point.' };

    if (a.dir !== 'out' || b.dir !== 'in') {
        return { reason: 'Wires run from an output on the right of a step to an input on the left of the next one.' };
    }

    if (from.step === to.step) {
        return { reason: `${STEP_LABELS[from.step]} cannot wire into itself.` };
    }

    if (a.type !== b.type) {
        return {
            reason:
                `${STEP_LABELS[from.step]} sends ${TYPE_NOUNS[a.type]}, and `
                + `${STEP_LABELS[to.step]} expects ${TYPE_NOUNS[b.type]}.`,
        };
    }

    // An input takes ONE wire. Outputs may fan out — `cond` legitimately drives two actions once
    // there is more than one, and refusing that would be a rule about today's step list.
    if (draft.wires.some((w) => samePort(w.to, to))) {
        return {
            reason: `${STEP_LABELS[to.step]} already has an input. Remove that wire first.`,
        };
    }

    // **A wire is a DRAWING of the rule, and a saved rule has exactly one shape.** `wires` is canvas
    // state: nothing in the graph, the store or the engine derives behaviour from it. Every check
    // above passes `cond.false → action.in` — same type, right direction, free input — so a user
    // could delete the `yes` wire, draw the `no` one, and be looking at a picture of a rule that
    // fires when the comparison FAILS while the engine goes on firing when it succeeds. The canvas
    // would be drawing the exact opposite of what runs, which is the one thing `AuWires`' own header
    // promises it cannot do.
    const canonical = canonicalWires();
    if (!canonical.some((w) => samePort(w.from, from) && samePort(w.to, to))) {
        // Name the port that DOES drive it, not the one that was tried — a refusal that only says
        // no leaves the user guessing which of two outputs was meant.
        const wanted = canonical.find((w) => samePort(w.to, to));
        return {
            reason: wanted
                ? `${STEP_LABELS[to.step]} runs on ${STEP_LABELS[wanted.from.step]}'s `
                    + `${portSpec(wanted.from)?.label ?? wanted.from.port} output. The canvas draws `
                    + 'the rule, and a wire the rule would not follow is a picture of something else.'
                : `Nothing drives ${STEP_LABELS[to.step]} in this rule.`,
        };
    }

    return null;
}

/**
 * Which step must already be on the canvas before this one makes sense — **any ONE of them**.
 *
 * A list rather than a single kind, because `action` has two drivers and always did in principle:
 * the verdict from `Compare it` on a watching rule, and the wait itself on a schedule rule, which
 * has no comparison and is not allowed one (§6.3). Named as one predecessor, the palette demanded a
 * `Compare it` that a schedule rule must not carry, so *"a wait and a send"* — the whole of mockup
 * §03's rule — could not be built at all.
 *
 * **`timer` is deliberately absent**, and that is what makes a schedule rule reachable: it reads
 * nothing, so there is nothing for it to be downstream of. It is the only step besides `monitor`
 * that may open an empty canvas.
 */
const REQUIRES: Partial<Record<StepKind, readonly StepKind[]>> = {
    parse: ['monitor'],
    cond: ['parse'],
    action: ['cond', 'timer'],
};

/**
 * Whether a palette drop may add this step, and why not when it may not (mockup §03: *"the drop is
 * refused with the reason, rather than silently doing nothing"*).
 *
 * **`shape` is the wait's mode, and it is here because of what task 29 made possible.** Once
 * `draftFromRule` draws only the steps a rule HAS, a saved schedule rule can be offered a
 * `Watch output` step — and there is no remove gesture and no undo, so an add whose only remedy is
 * a control that does not exist strands the user with the draft or with discarding every other edit
 * they made. The invariant is *the palette must not offer an add that validation will block with no
 * way back*, and exactly one add fails it:
 *
 * - `monitor` on a `dailyAt` rule raises `timer.scheduleWithMonitor`, whose own message offers
 *   *"remove the schedule, or remove the Watch output step"* — and no field anywhere clears it.
 * - `parse` raises `parse.empty`, which the card that was just revealed clears the moment the user
 *   types in it. `cond` raises nothing at all (`blankDraft()`'s cond is `kind: 'text'`, and
 *   `cond.incomplete` is a `number` rule's problem). Neither is a trap, and neither is refused.
 *
 * Both validators were read for that, not one: they agree here, but §8's two exhaustiveness lists
 * deliberately no longer do, so assuming would have been guessing.
 *
 * **A refusal, not a `ProblemCode`.** This is a palette affordance, not a property of a saved rule;
 * the rule it prevents is already `timer.scheduleWithMonitor`, and restating it as a twenty-second
 * tri-surface code (TS + Rust + the shared fixture) would be two names for one fact.
 *
 * Defaults to `'afterMatch'`, which is what `timerShapeOf` answers for a rule with no wait step at
 * all — so every canvas that has none behaves exactly as before.
 */
export function canAddStep(
    present: readonly StepKind[],
    kind: StepKind,
    shape: TimerShape = 'afterMatch',
): Refusal | null {
    if (present.includes(kind)) {
        return {
            reason: `This rule already has a ${STEP_LABELS[kind]} step. Each step appears once.`,
        };
    }
    const needs = REQUIRES[kind];
    if (needs && !needs.some((n) => present.includes(n))) {
        // Every alternative is named. A refusal that mentioned only the first would send a user
        // building a schedule rule off to add a `Compare it` the rule may not have.
        const names = needs.map((n) => STEP_LABELS[n]).join(' or ');
        const tail = needs.length === 1 ? 'it is there' : 'one of them is there';
        return {
            reason: `Add ${names} first — ${STEP_LABELS[kind]} has nothing to work on until ${tail}.`,
        };
    }
    if (kind === 'monitor' && shape === 'dailyAt') {
        // **Actionable, and it names a control that exists.** `timer.scheduleWithMonitor`'s own
        // wording — *"remove the Watch output step"* — is the sentence C1 stranded users with. The
        // one thing the user can actually do is switch the wait's mode, which `TimerPanel`'s
        // *What kind of wait* radio does, so that is what this says. "Wait", never "Timer".
        return {
            reason: `This rule fires on the clock, so a ${STEP_LABELS.monitor} step would never run. `
                + `Change the ${STEP_LABELS.timer} step from a time of day to a delay first.`,
        };
    }
    return null;
}

/**
 * **There is still no `canRemoveStep`, and the reason it used to give has expired.**
 *
 * There was one — a mirror of `canAddStep`, with a test, and no caller. What justified deleting it
 * was the sentence *"`present` is session-only canvas state, and a rule's graph carries all four
 * steps whatever is drawn"*. **That second clause is no longer true.** §3.1 made `monitor`, `parse`
 * and `cond` optional, task 29 made `draftFromRule` derive `present` from the graph, and
 * `ruleFromDraft` omits the three input steps as a group when the canvas draws none — so `present`
 * now DOES mean something the saved rule agrees with, which is precisely the condition the old note
 * said a remove would need. A false comment that justifies real behaviour is how C1 got here, so it
 * is corrected rather than left standing.
 *
 * Remove is still absent, on the remaining half of the argument, which is untouched: taking a card
 * off the canvas has to decide what happens to the DATA behind it. Hiding *Send to terminal* while
 * leaving the message, the Enter and the send-to intact means the rule goes on typing into terminals
 * with nothing on screen to say so — and `action` is not optional on the DTO, so there is no shape
 * for its absence to write. For the three that are optional the question is answerable but not
 * answered here: it is a gesture with a data consequence, and it needs designing rather than
 * enabling.
 *
 * `addStep` is coherent because it moves the other way: it REVEALS a step and materialises whatever
 * the panel needs to bind to, and everything it reveals is blank and blocking until the user fills
 * it in.
 */

/**
 * The wires implied by a set of steps and the wait's mode — the chain, plus the `yes` branch.
 *
 * Derived rather than stored for the same reason the paraphrase is: a saved rule's graph has one
 * meaning, so a wire list that could disagree with it would be a second source of truth for the
 * thing the canvas exists to draw. The `no` branch is deliberately left unwired; the empty port is
 * the point.
 *
 * **The mode is an argument because the two modes are two different rules** (§6.2, §6.3):
 *
 * - `afterMatch` — the wait is a DELAY. It goes between the verdict and the send, so the verdict no
 *   longer reaches the send directly: the send it triggers is the one the wait releases.
 * - `dailyAt` — the wait is the START. §6.3's walk skips the screen read *for the whole rule*, on
 *   every tick, so a monitor → read → compare chain drawn beside the clock would be a picture of
 *   three steps the engine does not run. One wire, and only one, whatever else is on the canvas.
 *   (That shape is itself a blocking problem — `timer.scheduleWithMonitor` — but the canvas has to
 *   draw the rule truthfully while the user is looking at the error, not instead of it.)
 *
 * The default is `afterMatch`: it is the mode a wait step is created in, and it is the only one of
 * the two whose wires a rule with no wait step at all is a subset of.
 */
export function defaultWires(
    present: readonly StepKind[],
    shape: TimerShape = 'afterMatch',
): Wire[] {
    const out: Wire[] = [];
    const has = (k: StepKind) => present.includes(k);

    if (has('timer') && shape === 'dailyAt') {
        if (has('action')) {
            out.push({ from: { step: 'timer', port: 'out' }, to: { step: 'action', port: 'in' } });
        }
        return out;
    }

    if (has('monitor') && has('parse')) {
        out.push({ from: { step: 'monitor', port: 'out' }, to: { step: 'parse', port: 'in' } });
    }
    if (has('parse') && has('cond')) {
        out.push({ from: { step: 'parse', port: 'out' }, to: { step: 'cond', port: 'in' } });
    }
    if (has('cond') && has('timer')) {
        out.push({ from: { step: 'cond', port: 'true' }, to: { step: 'timer', port: 'in' } });
    }
    if (has('timer') && has('action')) {
        out.push({ from: { step: 'timer', port: 'out' }, to: { step: 'action', port: 'in' } });
    } else if (has('cond') && has('action')) {
        out.push({ from: { step: 'cond', port: 'true' }, to: { step: 'action', port: 'in' } });
    }
    return out;
}

/**
 * Every wire SOME legal shape of a rule implies — the set `canConnect` accepts.
 *
 * A union rather than one call, because there are now three shapes and a user may be drawing any of
 * them: the four-step chain (every rule written before this milestone), the delayed one, and the
 * scheduled one. Derived from `defaultWires` rather than typed out, so the wire the canvas DRAWS and
 * the wire it will ACCEPT cannot be edited apart.
 *
 * **The four-step chain is listed first, and that decides one sentence.** `canConnect`'s shape
 * refusal names the port that does drive the step it was dropped on, by finding the first canonical
 * wire into it — and `action.in` has two, so the order picks which. `Compare it`'s `yes` output is
 * the right answer for a canvas with no wait step, which is the canvas most refusals happen on.
 *
 * **What this deliberately does not do is ask which shape is on screen.** `canConnect` sees the
 * wires, not the cards, so on a canvas that HAS a delay it would still accept `cond.true` →
 * `action.in` — a picture that skips the wait. Reaching that takes deleting the wait's own output
 * wire first, because an input takes one wire and the arity check above refuses the second; and the
 * alternative is threading the step list and the wait's mode through every caller of a function
 * whose whole point is that it is arithmetic over names.
 */
function canonicalWires(): Wire[] {
    return [
        ...defaultWires(STEP_ORDER.filter((s) => s !== 'timer')),
        ...defaultWires(STEP_ORDER, 'afterMatch'),
        ...defaultWires(STEP_ORDER, 'dailyAt'),
    ];
}
