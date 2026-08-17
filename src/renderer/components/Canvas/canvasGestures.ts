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

/** Which fit a keypress is asking for, or `null` when it is not asking for one. */
export type FitTarget = 'all' | 'group';

/** The parts of a KeyboardEvent the fit shortcuts read. Wider than `SpacePanKey` only because
 *  these are modified keys and Space is not. */
export interface FitKey {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
}

/**
 * <kbd>Shift</kbd>+<kbd>1</kbd> frames the whole workspace; <kbd>Shift</kbd>+<kbd>2</kbd> frames
 * the group you are working in (`plan/013` Task 23, design 010 §5).
 *
 * **Matched on `code` OR `key`, for the same reason `shouldArmSpacePan` is.** With Shift held,
 * `event.key` is not `'1'` — on a US layout it is `'!'`, and on an AZERTY it *is* `'1'` because
 * the digit is the shifted glyph there. `code` is layout-independent and covers the first case;
 * `key` covers the second and is also what jsdom populates. Neither alone is reliable.
 *
 * This is also why these cannot be ordinary `InputHandler` shortcuts: that path canonicalises
 * `event.key`, so registering `Shift+1` would build the combo `Shift+!` at match time and never
 * fire. A local listener is the correct home rather than a workaround — `CanvasMode` is mounted
 * exactly while the canvas is on screen, which is the gate these shortcuts need anyway.
 *
 * The refusals mirror the hand tool's: an editable target keeps its own keys, so typing `!` into
 * the sidebar search does not fly the viewport. **The focused-node refusal is NOT here** — it
 * belongs to the caller, which knows `focusedId`; folding it in would mean passing it through a
 * function that has no other use for it.
 */
export function fitShortcut(e: FitKey): FitTarget | null {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
  const t = e.target;
  if (t && (t.isContentEditable || EDITABLE.test(t.tagName ?? ''))) return null;
  if (e.code === 'Digit1' || e.key === '!' || e.key === '1') return 'all';
  if (e.code === 'Digit2' || e.key === '@' || e.key === '2') return 'group';
  return null;
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
