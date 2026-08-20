/**
 * Which terminal a globally-dispatched piece of text belongs to.
 *
 * `InputHandler` owns shortcuts at the window's CAPTURE phase, so the actions it fires —
 * paste, "clear terminal" — arrive with no DOM target to route by. They have to ask the store
 * "which terminal currently has the keyboard", and the answer used to be a walk of
 * `panes.paneTree` for `panes.activePaneId`.
 *
 * **That walk cannot see Canvas Mode.** The canvas is a TAB (`design/010` D1a), not an overlay
 * over the terminal tab. Virtual tabs are never seeded into `panes.treesByTabId`, and
 * `setActiveTabId` mirrors `paneTree` from that map — so while the canvas is open BOTH
 * `paneTree` and `activePaneId` are `null` and the walk resolves nothing at all
 * (`InputHandler: Could not determine target terminal for paste`).
 *
 * The keystroke is not merely unhandled, it is consumed: `handleKeyEvent` calls
 * `preventDefault()`/`stopPropagation()` as soon as a combo matches a registered shortcut, well
 * before the handler body discovers it has no target. So the paste never happens AND the keys
 * never reach the PTY as a fallback.
 *
 * Canvas nodes hold live terminals and accept typing, so the keyboard is genuinely somewhere;
 * it just is not in the pane tree.
 *
 * **The gate lives here, not in the callers.** Both callers previously carried their own copy
 * of the pane-tree walk, and a third caller added later would have copied it again — including
 * the assumption that broke. One entry point means a new action gets the canvas case for free
 * rather than having to remember it.
 *
 * Returns a renderer LEAF terminal id (`tb-*` / `tm-*`), the id space both the pane tree and
 * the canvas node model are keyed by — never a `pc-*` process id.
 */
import { canvasIsShowing } from './runningActivity';
import { findLeaf } from '../store/slices/paneTreeOps';
import type { PaneNode } from '../store/slices/panesSlice';

/** The slice of the store this needs. Structural, so `store.getState()` satisfies it directly
 *  without this module importing the store or the root type. */
export interface KeyboardTerminalState {
  panes: { activePaneId: string | null; paneTree: PaneNode | null };
  canvas: { focusedId: string | null };
  tabs: {
    activeTabId: string | null;
    tabs: readonly { id: string; shellType?: string | null }[];
  };
}

export function resolveKeyboardTerminalId(state: KeyboardTerminalState): string | null {
  // `canvas.focusedId` is "the node receiving keystrokes" (`canvasSlice`), which is exactly the
  // question being asked. It is still gated on the canvas being ON SCREEN: `focusedId` is
  // cleared when `CanvasMode` unmounts, but reading it unconditionally would make this depend
  // on that cleanup rather than on what the user can see, and `overlayId` right beside it
  // deliberately does NOT get cleared (`plan/020` §4).
  //
  // No fall-through when the canvas is up with nothing focused: the keyboard is then in no
  // terminal at all, and dropping back to the pane tree would deliver the clipboard to a
  // background terminal the user cannot even see.
  if (canvasIsShowing(state.tabs.tabs, state.tabs.activeTabId)) {
    return state.canvas.focusedId;
  }
  const { activePaneId, paneTree } = state.panes;
  if (!activePaneId || !paneTree) return null;
  return findLeaf(paneTree, activePaneId)?.terminalId ?? null;
}
