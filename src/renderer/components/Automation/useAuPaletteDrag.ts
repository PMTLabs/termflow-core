/**
 * Dragging a step out of the palette and onto the canvas.
 *
 * Pointer events, not HTML5 drag-and-drop: the app already has a `dragstart` story for tabs and
 * panes, and a second one competing on the same window is how `elementFromPoint` starts returning
 * the wrong layer (`interactive-layer-shadows-drop-targets`). This gesture is entirely local — it
 * begins on a palette item, ends on the canvas, and touches nothing in between.
 *
 * A refusal is reported, never swallowed (mockup §03).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodePos } from './automationDraft';
import { AU_NODE_H, AU_NODE_W } from './automationDraft';
import type { StepKind } from './automationSteps';

export interface AuPaletteDragOptions {
    /** Screen → world, and `null` when the pointer is not over the canvas at all. */
    toWorld: (clientX: number, clientY: number) => NodePos | null;
    /**
     * **The one entry point that decides whether a step may be added**, shared with the palette's
     * keyboard/click path.
     *
     * This hook used to ask `canAddStep` itself, which made the DRAG the only gated route: the same
     * palette item is also a button, and clicking it dispatched straight into the reducer — so
     * clicking *Compare it* on an empty canvas added it with nothing to compare, in a shape the drag
     * refuses. `gate-in-the-caller-lets-new-callers-opt-out`: a gate that lives in one caller is a
     * gate the next caller opts out of by existing.
     */
    onAdd: (step: StepKind, pos: NodePos) => void;
}

export interface AuPaletteDrag {
    /** The step under the cursor, and where the ghost is drawn, in SCREEN coordinates. */
    ghost: { step: StepKind; x: number; y: number } | null;
    begin: (step: StepKind, e: { clientX: number; clientY: number }) => void;
}

export function useAuPaletteDrag({ toWorld, onAdd }: AuPaletteDragOptions): AuPaletteDrag {
    const [ghost, setGhost] = useState<{ step: StepKind; x: number; y: number } | null>(null);
    // What is held, readable synchronously from an event handler that must not run effects inside a
    // state updater. Assigned during render AND at `begin`, so a `pointerup` arriving before React
    // has re-rendered still sees the gesture.
    const heldRef = useRef<{ step: StepKind; x: number; y: number } | null>(null);
    heldRef.current = ghost;
    const latest = useRef({ toWorld, onAdd });
    latest.current = { toWorld, onAdd };

    const begin = useCallback((step: StepKind, e: { clientX: number; clientY: number }) => {
        heldRef.current = { step, x: e.clientX, y: e.clientY };
        setGhost(heldRef.current);
    }, []);

    useEffect(() => {
        const move = (e: PointerEvent) => {
            // A BUTTON THAT IS NO LONGER DOWN ended this gesture, whatever the browser told us.
            // Releasing outside the window means `pointerup` is never delivered — the browser only
            // reports events over its own surface and nothing here captures the pointer — so the
            // first move back inside arrives with `buttons === 0` and the card, wire or ghost is
            // still glued to the cursor with nothing held down.
            if (e.buttons === 0) {
                heldRef.current = null;
                setGhost(null);
                return;
            }
            setGhost((held) => (held ? { ...held, x: e.clientX, y: e.clientY } : held));
        };
        const up = (e: PointerEvent) => {
            // The held step comes from a REF, not from inside a `setGhost` updater. A state updater
            // must be pure: React invokes it twice under StrictMode, so adding a step (and toasting
            // its refusal) from inside one fires it twice for one drop — two dispatches, or a toast
            // saying the step is already there, from one gesture, and only in development, which is
            // where it would be dismissed as noise.
            const held = heldRef.current;
            heldRef.current = null;
            setGhost(null);
            if (!held) return;
            const { toWorld: convert, onAdd: add } = latest.current;
            const world = convert(e.clientX, e.clientY);
            // Dropped outside the canvas: not a refusal, just not a drop. Saying "that step cannot
            // go there" for a gesture the user abandoned would be noise.
            if (!world) return;
            add(held.step, { x: world.x - AU_NODE_W / 2, y: world.y - AU_NODE_H / 2 });
        };
        // Named, not inline: `removeEventListener` compares by identity, so an inline arrow here is
        // a listener that outlives its component and holds the whole closure with it.
        const cancel = () => {
            heldRef.current = null;
            setGhost(null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', cancel);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', cancel);
        };
    }, []);

    return { ghost, begin };
}
