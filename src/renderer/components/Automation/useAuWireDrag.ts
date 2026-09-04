/**
 * Dragging a wire between two ports.
 *
 * The gesture may start at **either** end, and the orientation is decided at the drop, by which end
 * is the output. That is why `canConnect`'s direction refusal is reachable rather than theoretical:
 * dragging one output onto another has no orientation that works, and the user is told that rather
 * than watching nothing happen.
 *
 * Starting at an INPUT is not a rewire, though it was once described here as one. A complete rule
 * has every input already wired (`defaultWires`), so the drop meets the arity refusal — *"…already
 * has an input. Remove that wire first."* — which is the affordance, in that order: remove the chip,
 * then drag.
 *
 * The refusal is never swallowed. Mockup §03: *"the drop is refused with the reason, rather than
 * silently doing nothing."*
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutomationDraft, NodePos } from './automationDraft';
import { portAnchor } from './automationDraft';
import type { PortRef, Wire } from './automationSteps';
import { STEP_PORTS, canConnect, portSpec } from './automationSteps';

export interface AuWireDragOptions {
    toWorld: (clientX: number, clientY: number) => NodePos;
    draft: AutomationDraft;
    onConnect: (wire: Wire) => void;
    onRefuse: (reason: string) => void;
}

export interface AuWireDrag {
    /** The anchor the wire is being pulled from, and the pointer, both in world units. */
    line: { from: NodePos; to: NodePos } | null;
    /** `${step}.${port}` for every port this drag could legally land on, for the drop highlight. */
    legal: ReadonlySet<string>;
    begin: (port: PortRef, e: { clientX: number; clientY: number }) => void;
    drop: (port: PortRef) => void;
}

export function useAuWireDrag({ toWorld, draft, onConnect, onRefuse }: AuWireDragOptions): AuWireDrag {
    const [from, setFrom] = useState<PortRef | null>(null);
    const [pointer, setPointer] = useState<NodePos | null>(null);
    // The anchor, readable synchronously from an event handler that must not run effects inside a
    // state updater. Assigned during render, the way `latest` below is.
    const fromRef = useRef<PortRef | null>(null);
    fromRef.current = from;
    const latest = useRef({ toWorld, draft, onConnect, onRefuse });
    latest.current = { toWorld, draft, onConnect, onRefuse };

    const begin = useCallback((port: PortRef, e: { clientX: number; clientY: number }) => {
        // The ref first, so a drop arriving before React has re-rendered still sees the anchor.
        fromRef.current = port;
        setFrom(port);
        setPointer(latest.current.toWorld(e.clientX, e.clientY));
    }, []);

    const drop = useCallback((port: PortRef) => {
        // The held anchor comes from a REF, not from inside a `setFrom` updater. A state updater must
        // be pure: React invokes it twice under StrictMode, so connecting (and toasting a refusal)
        // from inside one fires the effect twice for one drop — two wires, or two toasts, from one
        // gesture, and only in development, which is where it would be dismissed as noise.
        const held = fromRef.current;
        fromRef.current = null;
        setFrom(null);
        setPointer(null);
        if (!held) return;

        const a = portSpec(held);
        const b = portSpec(port);
        // Orient by which end is the output. When BOTH are outputs (or both inputs) there is no
        // orientation, and `canConnect` says so in words — the case this ordering exists to let
        // through to it rather than silently swallow.
        const ordered = a && a.dir === 'out' ? { from: held, to: port }
            : b && b.dir === 'out' ? { from: port, to: held }
                : { from: held, to: port };
        const refusal = canConnect(latest.current.draft, ordered.from, ordered.to);
        if (refusal) latest.current.onRefuse(refusal.reason);
        else latest.current.onConnect(ordered);
    }, []);

    useEffect(() => {
        const move = (e: PointerEvent) => {
            // A BUTTON THAT IS NO LONGER DOWN ended this gesture, whatever the browser told us.
            // Releasing outside the window means `pointerup` is never delivered — the browser only
            // reports events over its own surface and nothing here captures the pointer — so the
            // first move back inside arrives with `buttons === 0` and the card, wire or ghost is
            // still glued to the cursor with nothing held down.
            if (e.buttons === 0 && fromRef.current !== null) {
                up();
                return;
            }
            setPointer((held) => (held === null ? held : latest.current.toWorld(e.clientX, e.clientY)));
        };
        // A pointerup anywhere that is not a port ends the gesture. The port's own handler runs
        // first (it is the target), so `from` is already null by the time this sees it.
        const up = () => {
            fromRef.current = null;
            setFrom(null);
            setPointer(null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
        };
    }, []);

    // The drop highlight asks the REAL refusal function about every port on the canvas, rather than
    // re-deriving "what could match" from the port table. One implementation, so what lights up and
    // what a drop accepts cannot drift apart.
    const legal = new Set<string>();
    if (from) {
        const a = portSpec(from);
        for (const step of draft.present) {
            for (const spec of STEP_PORTS[step]) {
                const target: PortRef = { step, port: spec.id };
                const ordered = a && a.dir === 'out' ? { from, to: target }
                    : spec.dir === 'out' ? { from: target, to: from }
                        : { from, to: target };
                if (!canConnect(draft, ordered.from, ordered.to)) {
                    legal.add(`${step}.${spec.id}`);
                }
            }
        }
    }

    const line = from && pointer
        ? { from: portAnchor(from.step, from.port, draft.layout[from.step]), to: pointer }
        : null;

    return { line, legal, begin, drop };
}
