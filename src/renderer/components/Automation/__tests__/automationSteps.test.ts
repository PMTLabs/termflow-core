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
    canRemoveStep,
    defaultWires,
} from '../automationSteps';
import type { PortRef, StepKind } from '../automationSteps';

const key = (p: PortRef) => `${p.step}.${p.port}`;

const LEGAL = new Set([
    'monitor.out->parse.in',
    'parse.out->cond.in',
    'cond.true->action.in',
    'cond.false->action.in',
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

    it('accepts exactly four of the forty-nine ordered pairs', () => {
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
    });

    it('refuses a second wire into an input, but allows an output to fan out', () => {
        const taken = { wires: [{ from: { step: 'cond' as StepKind, port: 'true' }, to: { step: 'action' as StepKind, port: 'in' } }] };
        expect(canConnect(taken, { step: 'cond', port: 'false' }, { step: 'action', port: 'in' })?.reason)
            .toBe(`${STEP_LABELS.action} already has an input. Remove that wire first.`);
        // The same output driving a second input is not refused — a rule with two actions is a
        // shape this table has no opinion about, and refusing it would be a rule about today's
        // step list rather than about wiring.
        expect(canConnect(taken, { step: 'cond', port: 'true' }, { step: 'parse', port: 'in' })).not.toBeNull();
    });

    it('refuses a port that does not exist', () => {
        expect(canConnect({ wires: [] }, { step: 'monitor', port: 'nope' }, { step: 'parse', port: 'in' }))
            .toEqual({ reason: 'That is not a connection point.' });
    });
});

describe('canAddStep / canRemoveStep', () => {
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

    it('refuses removing a step something else depends on', () => {
        expect(canRemoveStep(['monitor', 'parse'], 'monitor')?.reason).toContain(STEP_LABELS.parse);
        expect(canRemoveStep(['monitor', 'parse'], 'parse')).toBeNull();
        expect(canRemoveStep(STEP_ORDER, 'action')).toBeNull();
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
