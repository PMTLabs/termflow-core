/**
 * The right-click menu on a card of the editor's canvas — one item, and it is *Delete*.
 *
 * **`CanvasMenu` is borrowed, not copied.** Its own header says it is "deliberately not trying to
 * be" a generic menu component, and that is a statement about its ITEMS, not its shell: what it
 * owns is the portal out of a transformed ancestor, the rAF before it starts listening for the
 * click that dismisses it, and the `onClose` ref that survives a re-render on every frame of a pan.
 * All three are exactly as true on this canvas, and a second implementation of them here would be
 * three chances to get the same subtleties wrong — the flickering menu in particular, which looks
 * like nothing in the code.
 *
 * What it does NOT bring is a z-index that works here: `pane-context-menu` sits at 1000 and this
 * editor is a 9990 modal, so `.au-nodemenu` lifts it in `AutomationEditor.css` alongside
 * `.au-selmenu`, which had to solve the same problem for the same reason.
 *
 * **The item names what will actually go.** `removalGroup` answers with the three reading steps
 * when any one of them is aimed at, so an item reading *Delete “Read a value”* over a gesture that
 * removes three cards would be the menu lying about its own effect. The label is computed from
 * that same list, never from the step the pointer happened to land on.
 */
import React from 'react';
import { CanvasMenu, CanvasMenuItem } from '../Canvas/CanvasMenu';
import type { StepKind } from './automationSteps';
import { STEP_LABELS } from './automationSteps';

export interface AuNodeMenuProps {
    /** The cards this delete will take — `removalGroup`'s answer, never re-derived here. */
    group: readonly StepKind[];
    x: number;
    y: number;
    onClose: () => void;
    onDelete: () => void;
}

/**
 * *Watch output, Read a value and Compare it* — an Oxford-less English list.
 *
 * Exported for the toast, which reports the same set after the fact and must not word it a second
 * way: the menu promising three cards and the toast naming two is the drift a duplicated join
 * produces the day the group changes size.
 */
export function listSteps(steps: readonly StepKind[]): string {
    const names = steps.map((step) => STEP_LABELS[step]);
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const AuNodeMenu: React.FC<AuNodeMenuProps> = ({ group, x, y, onClose, onDelete }) => (
    <CanvasMenu x={x} y={y} onClose={onClose} className="au-nodemenu">
        <CanvasMenuItem
            icon="🗑"
            danger
            onClick={() => {
                onDelete();
                onClose();
            }}
        >
            {group.length > 1 ? `Delete ${listSteps(group)}` : `Delete “${listSteps(group)}”`}
        </CanvasMenuItem>
    </CanvasMenu>
);
