/**
 * §10.21 — the ordered-pair matrix over all five steps.
 *
 * Total rather than sampled: nine ports, eighty-one ordered pairs, and exactly five are legal. A
 * test that checked "monitor connects to parse" and "parse does not connect to action" would pass on
 * a `canConnect` that had lost its type check entirely — the interesting refusals are the ones
 * nobody thinks to write down.
 *
 * **The fifth step is `timer`, and it has two shapes rather than one** (plan 032 §6.2, §6.3), which
 * is why `defaultWires` takes the shape as an argument and why this file asserts BOTH: in delay mode
 * the wait sits between the verdict and the send, and in schedule mode it *starts* the rule and
 * nothing else is wired at all.
 */
import {
    STEP_LABELS,
    STEP_ORDER,
    STEP_PORTS,
    allPorts,
    canAddStep,
    canConnect,
    defaultWires,
} from '../automationSteps';
import type { PortRef, StepKind } from '../automationSteps';
import {
    AU_NODE_H,
    AU_NODE_W,
    DEFAULT_LAYOUT,
    auWirePath,
    portAnchor,
    portSides,
    sideOf,
} from '../automationDraft';

const key = (p: PortRef) => `${p.step}.${p.port}`;

/** The four steps a rule had before the wait step existed — still a real shape, and the common one. */
const WITHOUT_TIMER: StepKind[] = STEP_ORDER.filter((s) => s !== 'timer');

/**
 * The wires SOME legal shape of a rule implies, and nothing else.
 *
 * `cond.false->action.in` used to be in here, and it passed every check: right direction, matching
 * `verdict` type, a free input. It is the one accepted pair that draws a rule TermFlow does not run
 * — delete the `yes` chip, draw the `no` one, and the canvas says the rule fires when the comparison
 * FAILS while the engine goes on firing when it succeeds. `wires` is session-only canvas state and
 * no behaviour derives from it, so the drawing was the only thing that changed.
 *
 * **Five rather than three, because the wait step adds two and removes none.** `cond.true->action.in`
 * stays legal: a rule with no wait step is still the ordinary rule, and refusing that pair would
 * un-draw every rule written before this milestone.
 */
const LEGAL = new Set([
    'monitor.out->parse.in',
    'parse.out->cond.in',
    'cond.true->timer.in',
    'cond.true->action.in',
    'timer.out->action.in',
]);

describe('canConnect — the ordered-pair matrix', () => {
    const ports = allPorts();

    it('has the nine ports the step table declares', () => {
        expect(ports.map(key)).toEqual([
            'monitor.out',
            'parse.in',
            'parse.out',
            'cond.in',
            'cond.true',
            'cond.false',
            // The wait step carries a verdict through: in delay mode the crossing arrives here and
            // leaves `delayMs` later, and in schedule mode the input is simply never wired — the
            // same "the empty port is the point" the `no` output has always made.
            'timer.in',
            'timer.out',
            'action.in',
        ]);
    });

    it('accepts exactly five of the eighty-one ordered pairs', () => {
        const accepted: string[] = [];
        for (const from of ports) {
            for (const to of ports) {
                if (canConnect({ wires: [] }, from, to) === null) {
                    accepted.push(`${key(from)}->${key(to)}`);
                }
            }
        }
        expect(accepted.sort()).toEqual([...LEGAL].sort());
        expect(ports.length * ports.length).toBe(81);
    });

    it('refuses each pair for the RIGHT reason', () => {
        // A refusal that always said the same thing would pass the matrix above. The reason is what
        // the user reads on a failed drop, and it is the difference between "learn the rule" and
        // "the app did nothing".
        const reason = (from: string, to: string) => {
            const parse = (s: string): PortRef => {
                const [step, port] = s.split('.') as [StepKind, string];
                return { step, port };
            };
            return canConnect({ wires: [] }, parse(from), parse(to))?.reason ?? '';
        };

        // Direction: an input cannot be a source.
        expect(reason('parse.in', 'cond.in')).toMatch(/output.*input/i);
        // Direction again, and this is the case the wire drag can actually reach: two outputs have
        // no orientation that works.
        expect(reason('monitor.out', 'parse.out')).toMatch(/output.*input/i);
        // Self.
        expect(reason('cond.true', 'cond.in')).toBe(`${STEP_LABELS.cond} cannot wire into itself.`);
        // Type.
        expect(reason('monitor.out', 'cond.in')).toBe(
            `${STEP_LABELS.monitor} sends matched lines, and ${STEP_LABELS.cond} expects a value.`,
        );
        expect(reason('parse.out', 'action.in')).toBe(
            `${STEP_LABELS.parse} sends a value, and ${STEP_LABELS.action} expects a yes or no.`,
        );
        // Shape. The one refusal that is not about direction, self or type: `cond.false` is a real
        // output of the right type into a free input, and wiring it would draw the opposite of what
        // the rule does. The reason names the port that DOES drive the step, not the one tried.
        expect(reason('cond.false', 'action.in')).toBe(
            `${STEP_LABELS.action} runs on ${STEP_LABELS.cond}'s yes output. The canvas draws the `
            + 'rule, and a wire the rule would not follow is a picture of something else.',
        );
        // Shape again, on the new kind: `cond.false` into the wait is the same wrong picture one
        // card earlier, and the reason names the `yes` output that DOES drive it.
        expect(reason('cond.false', 'timer.in')).toBe(
            `${STEP_LABELS.timer} runs on ${STEP_LABELS.cond}'s yes output. The canvas draws the `
            + 'rule, and a wire the rule would not follow is a picture of something else.',
        );
        // Type, on the new kind: the wait carries a verdict, so a value cannot enter it and the
        // lines a monitor prints cannot either.
        expect(reason('parse.out', 'timer.in')).toBe(
            `${STEP_LABELS.parse} sends a value, and ${STEP_LABELS.timer} expects a yes or no.`,
        );
        // Direction, on the new kind: the wait's own input is not a source.
        expect(reason('timer.in', 'action.in')).toMatch(/output.*input/i);
    });

    it('refuses a second wire into an input, BEFORE it asks about shape', () => {
        // The order is the message: a user dragging onto a port that is already wired should be
        // told to remove that wire, not lectured about which output drives the step.
        const taken = { wires: [{ from: { step: 'cond' as StepKind, port: 'true' }, to: { step: 'action' as StepKind, port: 'in' } }] };
        expect(canConnect(taken, { step: 'cond', port: 'false' }, { step: 'action', port: 'in' })?.reason)
            .toBe(`${STEP_LABELS.action} already has an input. Remove that wire first.`);
        // And the same pair on an EMPTY canvas is refused for the other reason, so neither check is
        // shadowing the other.
        expect(canConnect({ wires: [] }, { step: 'cond', port: 'false' }, { step: 'action', port: 'in' })?.reason)
            .toContain('yes output');
    });

    it('refuses a port that does not exist', () => {
        expect(canConnect({ wires: [] }, { step: 'monitor', port: 'nope' }, { step: 'parse', port: 'in' }))
            .toEqual({ reason: 'That is not a connection point.' });
    });
});

describe('canAddStep', () => {
    it('refuses a second copy of a step, naming it', () => {
        expect(canAddStep(['monitor'], 'monitor')?.reason).toContain(STEP_LABELS.monitor);
        expect(canAddStep(['monitor'], 'monitor')?.reason).toContain('already has');
    });

    it('refuses a step whose predecessor is not there yet, and names the predecessor', () => {
        // Mockup §03: "a Read a value when nothing is watching yet ... refused with the reason,
        // rather than silently doing nothing."
        expect(canAddStep([], 'parse')?.reason).toContain(STEP_LABELS.monitor);
        expect(canAddStep(['monitor'], 'cond')?.reason).toContain(STEP_LABELS.parse);
        expect(canAddStep(['monitor', 'parse'], 'action')?.reason).toContain(STEP_LABELS.cond);
    });

    it('accepts each step exactly when the chain reaches it', () => {
        const built: StepKind[] = [];
        for (const step of STEP_ORDER) {
            expect(canAddStep(built, step)).toBeNull();
            built.push(step);
        }
        // And the whole chain accepts nothing more.
        for (const step of STEP_ORDER) expect(canAddStep(built, step)).not.toBeNull();
    });

    /**
     * **The wait step is legal on an EMPTY canvas, and that is what makes a schedule rule
     * authorable** (plan 032 §6.3). It reads nothing, so there is nothing for it to wait on — every
     * other step needs the one that feeds it.
     */
    it('accepts the wait step with nothing else on the canvas', () => {
        expect(canAddStep([], 'timer')).toBeNull();
    });

    /**
     * And the step after it. `Send to terminal` used to name exactly one predecessor, so a schedule
     * rule — a wait and a send, and nothing else (mockup §03) — could not be built at all: the
     * palette demanded a `Compare it` the rule is not allowed to have.
     */
    it('accepts the send after EITHER of the two steps that can drive it', () => {
        expect(canAddStep(['timer'], 'action')).toBeNull();
        expect(canAddStep(['monitor', 'parse', 'cond'], 'action')).toBeNull();
        // With neither, it is still refused — and the refusal names both.
        const refusal = canAddStep(['monitor', 'parse'], 'action');
        expect(refusal?.reason).toContain(STEP_LABELS.cond);
        expect(refusal?.reason).toContain(STEP_LABELS.timer);
    });

    /**
     * **R3 — the palette must not offer an add that validation will block with no way back.**
     *
     * Task 29 makes `monitor`/`parse`/`cond` addable to a saved rule that lacks them, and that
     * creates this trap: there is no remove gesture and no undo, so an add whose only remedy is a
     * control that does not exist strands the user with the draft or with discarding every other
     * edit they made.
     *
     * **The set, derived by reading both validators** (`automationValidation.ts`'s `timerProblems`
     * / `patternProblems` / the `cond.incomplete` clause, and `automation_validation.rs`'s
     * `timer_problems` / `pattern_problems` / the `Finds::Reading` clause, which agree):
     *
     * | add       | delay (`afterMatch`)          | schedule (`dailyAt`)                        |
     * |-----------|-------------------------------|---------------------------------------------|
     * | `monitor` | nothing                       | **`timer.scheduleWithMonitor`** — REFUSED    |
     * | `parse`   | `parse.empty`                 | `parse.empty`                                |
     * | `cond`    | nothing (`blankDraft`'s cond is `kind: 'text'`, so `cond.incomplete` — a `number` rule with no clauses — does not apply) |
     *
     * Only `monitor` on a schedule rule is refused, and the difference is not the severity but the
     * REMEDY. `parse.empty` is cleared by typing in the card that was just added. There is no field
     * anywhere that clears `timer.scheduleWithMonitor`: its own message offers *"remove the schedule,
     * or remove the Watch output step"*, and the editor has neither control. The one thing the user
     * CAN do is change the Wait step's mode, so the refusal says that.
     *
     * Mutation M-c: delete the refusal branch → the schedule row dies, the delay rows stay green.
     */
    describe('R3 — an add with no way back', () => {
        const scheduleCanvas: StepKind[] = ['timer', 'action'];

        it('refuses a Watch output step on a schedule rule, and says what the user CAN change', () => {
            const refusal = canAddStep(scheduleCanvas, 'monitor', 'dailyAt');
            expect(refusal).not.toBeNull();
            expect(refusal?.reason).toContain(STEP_LABELS.monitor);
            // "Wait", never "Timer" — `Cadence::Timer` is already the monitor's poll interval.
            expect(refusal?.reason).toContain(STEP_LABELS.timer);
            expect(refusal?.reason).not.toMatch(/remove/i);
        });

        it('permits every add whose problem the new card itself can clear', () => {
            // Delay mode: the same canvas, the same adds, nothing refused — the set is empty here.
            expect(canAddStep(scheduleCanvas, 'monitor', 'afterMatch')).toBeNull();
            expect(canAddStep(['monitor', 'timer', 'action'], 'parse', 'afterMatch')).toBeNull();
            expect(canAddStep(['monitor', 'timer', 'action'], 'parse', 'dailyAt')).toBeNull();
            expect(canAddStep(['monitor', 'parse', 'timer', 'action'], 'cond', 'afterMatch')).toBeNull();
            expect(canAddStep(['monitor', 'parse', 'timer', 'action'], 'cond', 'dailyAt')).toBeNull();
        });

        /**
         * The shape defaults to `afterMatch`, which is what a canvas with no wait step at all
         * answers (`timerShapeOf`) — so every caller that predates the argument keeps its behaviour
         * and no ordinary rule is newly refused.
         */
        it('defaults to the delay shape, so a rule with no wait step is unaffected', () => {
            expect(canAddStep([], 'monitor')).toEqual(canAddStep([], 'monitor', 'afterMatch'));
            expect(canAddStep([], 'monitor')).toBeNull();
        });
    });
});

describe('defaultWires', () => {
    const drawn = (wires: ReturnType<typeof defaultWires>) =>
        wires.map((w) => `${key(w.from)}->${key(w.to)}`);

    it('wires the chain and leaves the `no` branch empty', () => {
        // The unused `no` port is how a user learns nothing happens on the other path — mockup §03
        // draws it deliberately, so wiring it would be a design change, not a convenience.
        const wires = defaultWires(WITHOUT_TIMER);
        expect(drawn(wires)).toEqual([
            'monitor.out->parse.in',
            'parse.out->cond.in',
            'cond.true->action.in',
        ]);
        expect(wires.some((w) => w.from.port === 'false')).toBe(false);
    });

    /**
     * **Delay mode inserts the wait between the verdict and the send** (§6.2) — the crossing
     * arrives, is held, and leaves. The verdict no longer reaches the action directly, because it
     * no longer does: the send it triggers is the one the wait releases.
     */
    it('threads the wait between the verdict and the send in delay mode', () => {
        expect(drawn(defaultWires(STEP_ORDER, 'afterMatch'))).toEqual([
            'monitor.out->parse.in',
            'parse.out->cond.in',
            'cond.true->timer.in',
            'timer.out->action.in',
        ]);
    });

    /**
     * **Schedule mode wires ONE wire, whatever else is on the canvas** (§6.3).
     *
     * This is the row a mode-blind `defaultWires` fails. A schedule rule's walk skips the screen
     * read for the whole rule, so a monitor to read to compare chain drawn beside the clock would
     * be a picture of three steps the engine does not run — the very thing `canConnect`'s shape
     * check exists to prevent, one layer up. Passing all five kinds in is deliberate: the
     * interesting case is the rule that HAS a monitor (which `timer.scheduleWithMonitor` blocks),
     * not the tidy two-card one, because only the former can tell the two modes apart.
     */
    it('wires only the wait into the send in schedule mode, and nothing else', () => {
        expect(drawn(defaultWires(STEP_ORDER, 'dailyAt'))).toEqual(['timer.out->action.in']);
        expect(drawn(defaultWires(['timer', 'action'], 'dailyAt'))).toEqual(['timer.out->action.in']);
    });

    it('produces only wires `canConnect` would accept, at every stage of building', () => {
        // The two are separate functions and could disagree; this is what stops the canvas drawing
        // a wire the user could not have made. Swept over BOTH shapes, because they draw different
        // wires and `canConnect` has one answer for both.
        for (const shape of ['afterMatch', 'dailyAt'] as const) {
            const built: StepKind[] = [];
            for (const step of STEP_ORDER) {
                built.push(step);
                const wires = defaultWires(built, shape);
                for (let i = 0; i < wires.length; i += 1) {
                    expect(canConnect({ wires: wires.slice(0, i) }, wires[i].from, wires[i].to)).toBeNull();
                }
            }
        }
    });

    it('wires nothing for a gap in the chain', () => {
        expect(defaultWires(['monitor', 'cond'])).toEqual([]);
        expect(defaultWires([])).toEqual([]);
        // A wait with nothing to release into is a gap too.
        expect(defaultWires(['cond', 'timer'], 'dailyAt')).toEqual([]);
    });
});

describe('the port table', () => {
    it('gives the compare step two outputs, labelled yes and no', () => {
        expect(STEP_PORTS.cond.filter((p) => p.dir === 'out').map((p) => p.label)).toEqual(['yes', 'no']);
    });

    it('gives every step exactly one input except the first', () => {
        for (const step of STEP_ORDER) {
            const inputs = STEP_PORTS[step].filter((p) => p.dir === 'in');
            expect(inputs).toHaveLength(step === 'monitor' ? 0 : 1);
        }
    });
});

/**
 * Where the dots actually sit. `portAnchor` had no test of any kind, so a version that ignored
 * `dir` — anchoring every port on the same edge — was invisible: the wires would all start and end
 * in the same place and every other geometry assertion would still hold.
 *
 * The side used to be decided by the port's DIRECTION and is now decided by where the cards are
 * (`portSides`), so `portAnchor` takes it as an argument. It is required rather than defaulted: a
 * default would let a caller that forgot it anchor the line to the old fixed edge while the dot the
 * user sees moved, which is the one failure this whole mechanism exists to prevent.
 */
describe('portAnchor', () => {
    const pos = { x: 100, y: 40 };

    it('anchors to the edge it is told, not to the one its direction implies', () => {
        // The classic reading order, asked for explicitly.
        expect(portAnchor('parse', 'in', pos, 'l').x).toBe(pos.x);
        expect(portAnchor('parse', 'out', pos, 'r').x).toBe(pos.x + AU_NODE_W);
        // Both of `cond`'s verdicts leave from the SAME edge, not one per side.
        expect(portAnchor('cond', 'true', pos, 'r').x).toBe(pos.x + AU_NODE_W);
        expect(portAnchor('cond', 'false', pos, 'r').x).toBe(pos.x + AU_NODE_W);

        // And the flip: an input on the right, an output on the left. Without this the argument
        // could be ignored entirely and every assertion above would still pass.
        expect(portAnchor('parse', 'in', pos, 'r').x).toBe(pos.x + AU_NODE_W);
        expect(portAnchor('parse', 'out', pos, 'l').x).toBe(pos.x);
    });

    it('spreads one side evenly, so yes and no are told apart by position', () => {
        // A third and two thirds down the card — the split the header promises.
        expect(portAnchor('cond', 'true', pos, 'r').y).toBe(pos.y + (AU_NODE_H * 1) / 3);
        expect(portAnchor('cond', 'false', pos, 'r').y).toBe(pos.y + (AU_NODE_H * 2) / 3);
        expect(portAnchor('cond', 'true', pos, 'r').y).not.toBe(portAnchor('cond', 'false', pos, 'r').y);
        // A lone port on its side sits at the midpoint, not at the top.
        expect(portAnchor('monitor', 'out', pos).y).toBe(pos.y + AU_NODE_H / 2);
    });

    it('falls back to the card origin for a port the step does not have', () => {
        expect(portAnchor('monitor', 'in', pos)).toEqual(pos);
    });
});

/**
 * **Which edge a port uses, once the cards can be anywhere.**
 *
 * A port sits on the edge FACING its peer — one rule for inputs and outputs alike. Dragging a card
 * past the one it is wired to used to leave the wire running out of the right edge, back across both
 * cards and into a left edge from the far side, because the side was fixed by the port's direction.
 */
describe('portSides', () => {
    // The four-step shape. This block is about GEOMETRY — which edge a dot sits on once the cards
    // move — and the chain it needs is one where every card has exactly one peer. A wait step in
    // the middle would make `action`'s peer the wait rather than the compare, and every assertion
    // below about dragging `action` past `cond` would be about two cards that are no longer wired
    // to each other. `portSides` never reads a step's KIND, so nothing here is weaker for it.
    const wires = defaultWires(WITHOUT_TIMER);

    it('reads left to right for the default arrangement', () => {
        const sides = portSides(wires, DEFAULT_LAYOUT);
        expect(sideOf(sides, 'monitor', 'out')).toBe('r');
        expect(sideOf(sides, 'parse', 'in')).toBe('l');
        expect(sideOf(sides, 'cond', 'true')).toBe('r');
        expect(sideOf(sides, 'action', 'in')).toBe('r' === 'r' ? 'l' : 'l');
    });

    it('swaps BOTH ends when a card is dragged past its peer', () => {
        // `action` moved to the far left, so the cond → action wire now runs right to left.
        const moved = { ...DEFAULT_LAYOUT, action: { x: -900, y: 0 } };
        const sides = portSides(wires, moved);

        expect(sideOf(sides, 'action', 'in')).toBe('r');
        expect(sideOf(sides, 'cond', 'true')).toBe('l');
        // `cond.false` carries no wire of its own, and moves anyway: the flip is a property of the
        // CARD, so every port on it turns together. That is the whole reason an input and an output
        // can never share an edge.
        expect(sideOf(sides, 'cond', 'false')).toBe('l');
        expect(sideOf(sides, 'cond', 'in')).toBe('r');

        // Untouched pairs keep reading left to right, so this is a per-wire decision and not a
        // global flip of the whole canvas.
        expect(sideOf(sides, 'monitor', 'out')).toBe('r');
        expect(sideOf(sides, 'parse', 'in')).toBe('l');
    });

    /**
     * **The deadband, and the bug that produced it.**
     *
     * Cards stacked vertically are never quite aligned. An earlier version fell back only on an
     * EXACT tie, so two cards one above the other whose centres differed by ten pixels were read as
     * "my peer is to the left", both ports jumped to the far edges, and the wire looped around the
     * outside of both cards. Seen on a live build, at a 10px offset.
     *
     * The offset cases are the point — an exact-tie assertion alone passes the broken version, which
     * is exactly how it shipped.
     */
    it.each([0, 10, -10, AU_NODE_W - 1, -(AU_NODE_W - 1)])(
        'keeps the reading order when a card sits above with only %spx of horizontal drift',
        (dx) => {
            const stacked = {
                ...DEFAULT_LAYOUT,
                action: { x: DEFAULT_LAYOUT.cond.x + dx, y: 400 },
            };
            const sides = portSides(wires, stacked);
            expect(sideOf(sides, 'action', 'in')).toBe('l');
            expect(sideOf(sides, 'cond', 'true')).toBe('r');
        },
    );

    it('swaps the card whose flow reversed, and only that card', () => {
        // Exactly on the deadband, so the boundary is pinned rather than assumed.
        const clear = { ...DEFAULT_LAYOUT, action: { x: DEFAULT_LAYOUT.cond.x - AU_NODE_W, y: 400 } };
        const sides = portSides(wires, clear);

        // `action` now sits left of its only peer, so it turns to face it.
        expect(sideOf(sides, 'action', 'in')).toBe('r');

        // `cond` does NOT turn, and that is the interesting half: its source (`parse`) is 360 to its
        // left while its target is only 244 to its left, so the flow through it still runs left to
        // right on balance. No arrangement of a chain gives every card what it wants; the rule picks
        // one coherent answer per card instead of a locally optimal one per port.
        expect(sideOf(sides, 'cond', 'in')).toBe('l');
        expect(sideOf(sides, 'cond', 'true')).toBe('r');
    });

    /**
     * **A card's input and output are never on the same edge.** Asked for directly, after a build in
     * which `Compare it` showed its `value` input and its `no` output both on its right-hand side.
     *
     * Stated as an invariant over several arrangements rather than as one example, because the
     * failure was not a wrong side — each port was individually facing its nearest peer, quite
     * correctly. It only became wrong when read as a card.
     */
    it.each([
        ['the default row', DEFAULT_LAYOUT],
        ['the action dragged far left', { ...DEFAULT_LAYOUT, action: { x: -900, y: 0 } }],
        ['two rows, wrapping', {
            ...DEFAULT_LAYOUT,
            cond: { x: 360, y: 400 },
            action: { x: 0, y: 400 },
        }],
        ['everything stacked in one column', {
            monitor: { x: 0, y: 0 },
            parse: { x: 8, y: 300 },
            cond: { x: -6, y: 600 },
            action: { x: 3, y: 900 },
        }],
    ])('never puts an input and an output on the same edge — %s', (_name, layout) => {
        const sides = portSides(wires, layout);
        for (const step of STEP_ORDER) {
            const ins = STEP_PORTS[step].filter((p) => p.dir === 'in');
            const outs = STEP_PORTS[step].filter((p) => p.dir === 'out');
            if (ins.length === 0 || outs.length === 0) continue;
            const inSides = new Set(ins.map((p) => sideOf(sides, step, p.id)));
            const outSides = new Set(outs.map((p) => sideOf(sides, step, p.id)));
            // Every input agrees with every other, likewise the outputs, and the two disagree.
            expect(inSides.size).toBe(1);
            expect(outSides.size).toBe(1);
            expect([...inSides][0]).not.toBe([...outSides][0]);
        }
    });

    /**
     * A port that carries several wires is placed by the MEAN of its peers, not by whichever wire
     * happens to come first — otherwise the dot would jump when an unrelated card moved.
     *
     * Built by hand rather than from `defaultWires`, which gives every port exactly one peer today.
     * `portSides` is pure geometry over whatever wires it is handed, so an arrangement the editor
     * cannot currently produce is still a fair question to ask it — and it is the arrangement a
     * second wire into `action` would create the day one is added.
     */
    it('places a multi-wire port by the mean of its peers, not by the first wire', () => {
        const layout = {
            ...DEFAULT_LAYOUT,
            action: { x: 0, y: 0 },
            parse: { x: -2000, y: 0 },
            cond: { x: 400, y: 0 },
        };
        const both = [
            { from: { step: 'parse' as const, port: 'out' }, to: { step: 'action' as const, port: 'in' } },
            { from: { step: 'cond' as const, port: 'true' }, to: { step: 'action' as const, port: 'in' } },
        ];

        // Mean of the two peers is well to the LEFT of `action`, so its input faces left — even
        // though the FIRST wire listed comes from further left still and the second from the right.
        expect(sideOf(portSides(both, layout), 'action', 'in')).toBe('l');

        // Move the far peer in, and the same two wires now put the same port on the other edge.
        const closer = { ...layout, parse: { x: 300, y: 0 } };
        expect(sideOf(portSides(both, closer), 'action', 'in')).toBe('r');
    });

    it('leaves an unwired port on its reading-order default', () => {
        const sides = portSides([], DEFAULT_LAYOUT);
        expect(sideOf(sides, 'parse', 'in')).toBe('l');
        expect(sideOf(sides, 'parse', 'out')).toBe('r');
    });
});

/**
 * The curve's handles must point OUT of the edge each anchor sits on, or a swapped wire leaves the
 * card sideways and crosses back over itself. With both sides fixed this was `+reach` and `-reach`,
 * which is the same thing right up until a wire stops running left to right.
 */
describe('auWirePath', () => {
    const from = { x: 100, y: 0 };
    const to = { x: 400, y: 0 };

    it('pushes each handle away from its own edge', () => {
        const forward = auWirePath(from, to, 'r', 'l');
        expect(forward).toContain('C 250 0, 250 0');

        // Swapped: the source leaves leftwards and the target is entered from its right.
        const back = auWirePath(from, to, 'l', 'r');
        expect(back).toContain('C -50 0, 550 0');
    });
});
