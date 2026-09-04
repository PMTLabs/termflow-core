/**
 * §10.21 — the ordered-pair matrix over all four steps.
 *
 * Total rather than sampled: seven ports, forty-nine ordered pairs, and exactly four are legal. A
 * test that checked "monitor connects to parse" and "parse does not connect to action" would pass on
 * a `canConnect` that had lost its type check entirely — the interesting refusals are the ones
 * nobody thinks to write down.
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
import { AU_NODE_H, AU_NODE_W, portAnchor } from '../automationDraft';

const key = (p: PortRef) => `${p.step}.${p.port}`;

/**
 * The three wires a rule IMPLIES, and nothing else.
 *
 * `cond.false->action.in` used to be in here, and it passed every check: right direction, matching
 * `verdict` type, a free input. It is the one accepted pair that draws a rule TermFlow does not run
 * — delete the `yes` chip, draw the `no` one, and the canvas says the rule fires when the comparison
 * FAILS while the engine goes on firing when it succeeds. `wires` is session-only canvas state and
 * no behaviour derives from it, so the drawing was the only thing that changed.
 */
const LEGAL = new Set([
    'monitor.out->parse.in',
    'parse.out->cond.in',
    'cond.true->action.in',
]);

describe('canConnect — the ordered-pair matrix', () => {
    const ports = allPorts();

    it('has the seven ports the step table declares', () => {
        expect(ports.map(key)).toEqual([
            'monitor.out',
            'parse.in',
            'parse.out',
            'cond.in',
            'cond.true',
            'cond.false',
            'action.in',
        ]);
    });

    it('accepts exactly three of the forty-nine ordered pairs', () => {
        const accepted: string[] = [];
        for (const from of ports) {
            for (const to of ports) {
                if (canConnect({ wires: [] }, from, to) === null) {
                    accepted.push(`${key(from)}->${key(to)}`);
                }
            }
        }
        expect(accepted.sort()).toEqual([...LEGAL].sort());
        expect(ports.length * ports.length).toBe(49);
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
});

describe('defaultWires', () => {
    it('wires the chain and leaves the `no` branch empty', () => {
        // The unused `no` port is how a user learns nothing happens on the other path — mockup §03
        // draws it deliberately, so wiring it would be a design change, not a convenience.
        const wires = defaultWires(STEP_ORDER);
        expect(wires.map((w) => `${key(w.from)}->${key(w.to)}`)).toEqual([
            'monitor.out->parse.in',
            'parse.out->cond.in',
            'cond.true->action.in',
        ]);
        expect(wires.some((w) => w.from.port === 'false')).toBe(false);
    });

    it('produces only wires `canConnect` would accept, at every stage of building', () => {
        // The two are separate functions and could disagree; this is what stops the canvas drawing
        // a wire the user could not have made.
        const built: StepKind[] = [];
        for (const step of STEP_ORDER) {
            built.push(step);
            const wires = defaultWires(built);
            for (let i = 0; i < wires.length; i += 1) {
                expect(canConnect({ wires: wires.slice(0, i) }, wires[i].from, wires[i].to)).toBeNull();
            }
        }
    });

    it('wires nothing for a gap in the chain', () => {
        expect(defaultWires(['monitor', 'cond'])).toEqual([]);
        expect(defaultWires([])).toEqual([]);
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
 * The side is the whole meaning of the chain. `AuNode`'s header says the graph "always reads left to
 * right", which is why Canvas Mode's four-compass `portPoint` is deliberately NOT reused here.
 */
describe('portAnchor', () => {
    const pos = { x: 100, y: 40 };

    it('puts inputs on the left edge and outputs on the right', () => {
        expect(portAnchor('parse', 'in', pos).x).toBe(pos.x);
        expect(portAnchor('parse', 'out', pos).x).toBe(pos.x + AU_NODE_W);
        // Both of `cond`'s verdicts leave from the right, not one per side.
        expect(portAnchor('cond', 'true', pos).x).toBe(pos.x + AU_NODE_W);
        expect(portAnchor('cond', 'false', pos).x).toBe(pos.x + AU_NODE_W);
        expect(portAnchor('cond', 'in', pos).x).toBe(pos.x);
    });

    it('spreads one side evenly, so yes and no are told apart by position', () => {
        // A third and two thirds down the card — the split the header promises.
        expect(portAnchor('cond', 'true', pos).y).toBe(pos.y + (AU_NODE_H * 1) / 3);
        expect(portAnchor('cond', 'false', pos).y).toBe(pos.y + (AU_NODE_H * 2) / 3);
        expect(portAnchor('cond', 'true', pos).y).not.toBe(portAnchor('cond', 'false', pos).y);
        // A lone port on its side sits at the midpoint, not at the top.
        expect(portAnchor('monitor', 'out', pos).y).toBe(pos.y + AU_NODE_H / 2);
    });

    it('falls back to the card origin for a port the step does not have', () => {
        expect(portAnchor('monitor', 'in', pos)).toEqual(pos);
    });
});
