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
import { canAddStep } from './automationSteps';

export interface AuPaletteDragOptions {
    present: readonly StepKind[];
    /** Screen → world, and `null` when the pointer is not over the canvas at all. */
    toWorld: (clientX: number, clientY: number) => NodePos | null;
    onAdd: (step: StepKind, pos: NodePos) => void;
    onRefuse: (reason: string) => void;
}

export interface AuPaletteDrag {
    /** The step under the cursor, and where the ghost is drawn, in SCREEN coordinates. */
    ghost: { step: StepKind; x: number; y: number } | null;
    begin: (step: StepKind, e: { clientX: number; clientY: number }) => void;
}

export function useAuPaletteDrag({
    present,
    toWorld,
    onAdd,
    onRefuse,
}: AuPaletteDragOptions): AuPaletteDrag {
    const [ghost, setGhost] = useState<{ step: StepKind; x: number; y: number } | null>(null);
    const latest = useRef({ present, toWorld, onAdd, onRefuse });
    latest.current = { present, toWorld, onAdd, onRefuse };

    const begin = useCallback((step: StepKind, e: { clientX: number; clientY: number }) => {
        setGhost({ step, x: e.clientX, y: e.clientY });
    }, []);

    useEffect(() => {
        const move = (e: PointerEvent) => {
            setGhost((held) => (held ? { ...held, x: e.clientX, y: e.clientY } : held));
        };
        const up = (e: PointerEvent) => {
            setGhost((held) => {
                if (!held) return null;
                const { present: on, toWorld: convert, onAdd: add, onRefuse: refuse } = latest.current;
                const world = convert(e.clientX, e.clientY);
                // Dropped outside the canvas: not a refusal, just not a drop. Saying "that step
                // cannot go there" for a gesture the user abandoned would be noise.
                if (!world) return null;
                const refusal = canAddStep(on, held.step);
                if (refusal) refuse(refusal.reason);
                else add(held.step, { x: world.x - AU_NODE_W / 2, y: world.y - AU_NODE_H / 2 });
                return null;
            });
        };
        // Named, not inline: `removeEventListener` compares by identity, so an inline arrow here is
        // a listener that outlives its component and holds the whole closure with it.
        const cancel = () => setGhost(null);
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
