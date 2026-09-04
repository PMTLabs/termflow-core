/**
 * The four steps, their typed ports, and the one function that decides whether a wire is legal
 * (plan 028 §6.3, mockup §03).
 *
 * **Canvas Mode's ports are undirected 4-compass geometry with no type system**, and the only
 * refusal it has rejects a null target — so `useWireDrag` is a pattern to copy, not code to reuse.
 * Everything here is arithmetic over names: no React, no DOM, no draft mutation, which is what makes
 * §10.21's ordered-pair matrix a cheap and total test rather than a sampling of the interesting
 * cases.
 *
 * The four steps are **fixed**: a rule is always monitor → parse → cond → action, and the DTO has a
 * field for each (§7.7). What the canvas adds is *which of them the user has put on it yet* — a
 * brand-new rule opens on an empty canvas (mockup §03's third state) and the palette is how it gets
 * built. That is presentation, not persistence: nothing about the layout round-trips, because the
 * `graph` blob has no place to put it and inventing one would be a schema field nothing reads.
 */

export type StepKind = 'monitor' | 'parse' | 'cond' | 'action';

/** Left to right, and also the order the palette lists them and the problem list reports them. */
export const STEP_ORDER: readonly StepKind[] = Object.freeze(['monitor', 'parse', 'cond', 'action']);

export const STEP_LABELS: Record<StepKind, string> = {
    monitor: 'Watch output',
    parse: 'Read a value',
    cond: 'Compare it',
    action: 'Send to terminal',
};

/** The line under the title in the inspector head — *Step 2 · find text, pull a number out*. */
export const STEP_SUBTITLES: Record<StepKind, string> = {
    monitor: 'which terminals, and what to read',
    parse: 'find text, pull a number out',
    cond: 'decide yes or no',
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
 */
export const STEP_PORTS: Record<StepKind, readonly PortSpec[]> = {
    monitor: Object.freeze([{ id: 'out', dir: 'out', type: 'lines', label: 'lines' }]),
    parse: Object.freeze([
        { id: 'in', dir: 'in', type: 'lines', label: 'lines' },
        { id: 'out', dir: 'out', type: 'value', label: 'value' },
    ]),
    cond: Object.freeze([
        { id: 'in', dir: 'in', type: 'value', label: 'value' },
        { id: 'true', dir: 'out', type: 'verdict', label: 'yes' },
        { id: 'false', dir: 'out', type: 'verdict', label: 'no' },
    ]),
    action: Object.freeze([{ id: 'in', dir: 'in', type: 'verdict', label: 'verdict' }]),
};

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

    return null;
}

/** Which step must already be on the canvas before this one makes sense. */
const REQUIRES: Partial<Record<StepKind, StepKind>> = {
    parse: 'monitor',
    cond: 'parse',
    action: 'cond',
};

/**
 * Whether a palette drop may add this step, and why not when it may not (mockup §03: *"the drop is
 * refused with the reason, rather than silently doing nothing"*).
 */
export function canAddStep(present: readonly StepKind[], kind: StepKind): Refusal | null {
    if (present.includes(kind)) {
        return {
            reason: `This rule already has a ${STEP_LABELS[kind]} step. Each step appears once.`,
        };
    }
    const needs = REQUIRES[kind];
    if (needs && !present.includes(needs)) {
        return {
            reason: `Add ${STEP_LABELS[needs]} first — ${STEP_LABELS[kind]} has nothing to work on until it is there.`,
        };
    }
    return null;
}

/**
 * Whether a step may be REMOVED, and why not.
 *
 * The mirror of `canAddStep`: removing the step something else depends on would leave the canvas in
 * a shape the palette refuses to build, which is a state no gesture should be able to reach.
 */
export function canRemoveStep(present: readonly StepKind[], kind: StepKind): Refusal | null {
    const dependent = (Object.keys(REQUIRES) as StepKind[]).find(
        (k) => REQUIRES[k] === kind && present.includes(k),
    );
    if (dependent) {
        return {
            reason: `${STEP_LABELS[dependent]} depends on ${STEP_LABELS[kind]}. Remove that first.`,
        };
    }
    return null;
}

/**
 * The wires implied by a set of steps — the chain, plus the `yes` branch into the action.
 *
 * Derived rather than stored for the same reason the paraphrase is: a saved rule's graph has four
 * steps and one meaning, so a wire list that could disagree with it would be a second source of
 * truth for the thing the canvas exists to draw. The `no` branch is deliberately left unwired; the
 * empty port is the point.
 */
export function defaultWires(present: readonly StepKind[]): Wire[] {
    const out: Wire[] = [];
    const has = (k: StepKind) => present.includes(k);
    if (has('monitor') && has('parse')) {
        out.push({ from: { step: 'monitor', port: 'out' }, to: { step: 'parse', port: 'in' } });
    }
    if (has('parse') && has('cond')) {
        out.push({ from: { step: 'parse', port: 'out' }, to: { step: 'cond', port: 'in' } });
    }
    if (has('cond') && has('action')) {
        out.push({ from: { step: 'cond', port: 'true' }, to: { step: 'action', port: 'in' } });
    }
    return out;
}
