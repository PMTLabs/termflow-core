/**
 * Gesture decisions for the canvas, kept out of the component so they can be tested.
 *
 * `CanvasViewport` owns the pointer/keyboard WIRING — capture phase, pointer capture, the
 * `.space-pan` class. What it must not also own is the rules, because the rules are where the
 * mistakes are and the wiring is what makes them expensive to reach.
 */

/** The parts of a KeyboardEvent this decision reads. Narrowed so a test does not need a DOM. */
export interface SpacePanKey {
  key: string;
  code: string;
  repeat: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
}

const EDITABLE = /^(INPUT|TEXTAREA|SELECT)$/;

/**
 * Should this keypress arm the hand tool?
 *
 * Hold Space and drag from anywhere, the way Photoshop does. Without it a node covers its own
 * patch of canvas — pressing on one selects it, so there is nothing left to drag once the
 * workspace is dense enough that nodes cover the background.
 *
 * Two refusals, and both are about not stealing a key that already means something:
 *
 *  - **A focused node owns Space.** It has a live terminal taking keystrokes, and there Space
 *    is a space. Panning instead would swallow the keypress and move the canvas — from the
 *    user's side, a shell that dropped a character.
 *  - **An editable target owns Space**, so a rename box keeps its spaces.
 *
 * `repeat` is refused because the OS auto-repeats a held key ~30 times a second, and each one
 * would re-enter a state that is already entered — a stream of no-op state writes underneath a
 * live drag.
 */
export function shouldArmSpacePan(e: SpacePanKey, focusedNodeId: string | null): boolean {
  // `code` is layout-independent and `key` is what jsdom and some remote-desktop stacks
  // actually populate; accepting either costs nothing and neither alone is reliable.
  if (e.code !== 'Space' && e.key !== ' ') return false;
  if (focusedNodeId) return false;
  if (e.repeat) return false;
  const t = e.target;
  if (t && (t.isContentEditable || EDITABLE.test(t.tagName ?? ''))) return false;
  return true;
}

/** Does this keypress release the hand tool?
 *
 *  Deliberately NOT `shouldArmSpacePan`'s negation. Release has to be permissive: a keyup that
 *  arrives while a node happens to be focused, or repeated, still means the user let go. The
 *  asymmetry is the point — refusing to disarm strands the canvas in hand mode with no key
 *  held, which is far worse than an extra disarm. */
export function shouldDisarmSpacePan(e: Pick<SpacePanKey, 'key' | 'code'>): boolean {
  return e.code === 'Space' || e.key === ' ';
}
