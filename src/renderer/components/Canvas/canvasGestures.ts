/**
 * Gesture decisions for the canvas, kept out of the component so they can be tested.
 *
 * `CanvasViewport` owns the pointer/keyboard WIRING — capture phase, pointer capture, the
 * `.space-pan` class. What it must not also own is the rules, because the rules are where the
 * mistakes are and the wiring is what makes them expensive to reach.
 */
import { matchesCombo } from '../../services/shortcutActions';

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

/**
 * Who owns a wheel over the canvas.
 *
 * `'zoom'` — the canvas zooms about the cursor. `'pan'` — the canvas scrolls. Both mean the
 * canvas TAKES the event: `preventDefault`, `stopPropagation`, change the viewport.
 * `'passthrough'` — leave the event completely alone so it reaches the terminal underneath.
 *
 * The refusals are about a wheel that already means something to the terminal, and the
 * `stopPropagation` on the accept path is about the opposite mistake:
 *
 *  - **Ctrl/Cmd+wheel is font zoom** inside a terminal (design 010 §4.1), and has been since
 *    long before the canvas existed. Which terminals still get it depends on the mode — see
 *    `CanvasWheelMode`.
 *  - **An open overlay owns the wheel.** The overlay is that terminal at 1:1 and the thing the
 *    user is reading, so a wheel there is a scrollback scroll. Zooming as well made one gesture
 *    do two things — scroll the terminal AND move the world behind it.
 *  - **When the canvas does take it, the terminals must not also see it.** A terminal in
 *    mouse-tracking mode (vim, codex, any ratatui app) forwards a wheel to the PTY as a mouse
 *    escape sequence, the app redraws, and that redraw is real output — so a plain zoom made
 *    the terminal's content change and rang the unseen bell, the chime and a toast. Reported
 *    from live testing, 2026-08-16.
 */
export type WheelAction = 'zoom' | 'pan' | 'passthrough';

/**
 * Which gesture the wheel is, on the canvas — the user's `canvasWheelMode` setting.
 *
 * `'zoom'` is what the canvas shipped with and stays the default: the wheel zooms, and
 * Ctrl/Cmd+wheel is handed straight to the terminal under the pointer so its font zoom keeps
 * working exactly as it does in a pane.
 *
 * `'scroll'` is Tam's request, 2026-08-17, and is the mapping every document-shaped canvas uses:
 * the wheel scrolls the workspace and Ctrl/Cmd+wheel zooms it. The terminal keeps the chord in
 * the one place his message singles out — *"when on editing terminal, it zoom in/out the text
 * which is correct now"* — so font zoom follows the KEYBOARD here rather than the pointer. That
 * is the difference between the two modes worth stating: in `'zoom'` the chord belongs to
 * whatever terminal you are pointing at, in `'scroll'` only to the one you are typing into.
 *
 * Owned here rather than in the settings slice because this is the module that acts on it; the
 * slice imports the type so there is one list of the modes rather than two that can drift.
 */
export type CanvasWheelMode = 'zoom' | 'scroll';

/**
 * Everything the decision needs besides the event.
 *
 * An object rather than positional arguments, for the reason `CanvasSelection` is one: it grew
 * from a lone `overlayId` to three values, two of which are the same shape as each other, and a
 * caller that transposed them would compile and fail as a wheel that zoomed the wrong thing.
 */
export interface WheelContext {
  /** The full-screen overlay's terminal, or null. */
  overlayId: string | null;
  mode: CanvasWheelMode;
  /** Is the pointer over the terminal that currently holds the KEYBOARD? Only consulted in
   *  `'scroll'` mode, where it is what keeps font zoom reachable while you edit. */
  onFocusedTerminal: boolean;
}

export function wheelAction(
  e: { ctrlKey: boolean; metaKey: boolean },
  ctx: WheelContext,
): WheelAction {
  // First, and in both modes: the overlay is a terminal at 1:1, and every wheel in it is its own.
  if (ctx.overlayId) return 'passthrough';
  const zoomChord = e.ctrlKey || e.metaKey;
  if (ctx.mode === 'scroll') {
    if (zoomChord) return ctx.onFocusedTerminal ? 'passthrough' : 'zoom';
    return 'pan';
  }
  return zoomChord ? 'passthrough' : 'zoom';
}

/**
 * A wheel notch expressed in CSS pixels, whatever unit the device reported it in.
 *
 * `deltaMode` is the part that is easy to miss and impossible to see in a diff: a mouse on
 * Firefox reports LINES (`deltaY` of 3, meaning three lines), and a raw `deltaY` used as pixels
 * would pan three pixels per notch — a control that looks broken rather than wrong. The pixel
 * values are the conventional ones a browser uses for its own scrolling.
 */
export const WHEEL_LINE_PX = 16;
export const WHEEL_PAGE_PX = 320;

export interface WheelScroll {
  deltaX: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages (`WheelEvent.DOM_DELTA_*`). */
  deltaMode: number;
  shiftKey: boolean;
}

/**
 * How far a wheel scrolls the canvas, in the SCREEN pixels `panBy` takes.
 *
 * The signs are straight through, and that is the claim worth a test: a wheel DOWN shows you
 * what was below, which is the view moving down — `panBy` owns the inversion into world space,
 * exactly as it does for the arrow keys.
 *
 * **Shift+wheel is horizontal**, the convention every browser and editor shares. Applied only
 * when the device reported no horizontal delta of its own: a trackpad and a tilt wheel send a
 * real `deltaX`, and swapping THAT onto the x axis would turn a diagonal trackpad swipe into a
 * horizontal one and throw the vertical component away.
 */
export function wheelPanDelta(e: WheelScroll): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.shiftKey && dx === 0) return { dx: dy, dy: 0 };
  return { dx, dy };
}

/**
 * How far the pointer must travel before a press on a connection port counts as a DRAG
 * rather than a click (`plan/013` Task 18 + Tam's item 4).
 *
 * A port press means two different things now — drag to an existing node to wire them, or
 * click to create a new terminal already connected — so something has to tell them apart, and
 * the only thing that can is movement.
 *
 * 4px, and the value matters in both directions. Too small and an ordinary click is a
 * one-pixel drag that connects nothing and silently swallows the gesture: a pointer is never
 * perfectly still, a trackpad tap least of all. Too large and the start of a real drag feels
 * dead, and — worse — a short drag onto an adjacent node would register as a click and open a
 * menu the user never asked for.
 */
export const DRAG_SLOP = 4;

/** Squared distance, so no `Math.sqrt` runs on every `pointermove`. */
export function exceedsDragSlop(dxScreen: number, dyScreen: number): boolean {
  return dxScreen * dxScreen + dyScreen * dyScreen > DRAG_SLOP * DRAG_SLOP;
}

/** Which fit a keypress is asking for, or `null` when it is not asking for one. */
export type FitTarget = 'all' | 'group';

/** The parts of a KeyboardEvent the canvas's keyboard rules read. Wider than `SpacePanKey` only
 *  because these are modified keys and Space is not. */
export interface CanvasKey {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
}

/** Is this key landing somewhere that owns its own typing? Shared by every rule below that
 *  runs while the CANVAS has the keyboard, so a rename box and the sidebar search keep their
 *  letters. Deliberately NOT used by `leaveTerminalShortcut` — see its own note. */
const inEditable = (t: CanvasKey['target']): boolean =>
  !!t && (!!t.isContentEditable || EDITABLE.test(t.tagName ?? ''));

/**
 * The four canvas combos currently in effect, from Settings > Shortcuts.
 *
 * Named fields rather than positional arguments, for exactly the reason
 * `CanvasSelection` is an object: these are four adjacent `string`s, two pairs
 * of which mean near-opposite things on the same surface. A caller that
 * transposed `enlarge` and `openTab` would compile, type-check, and fail only
 * as the wrong key doing the wrong thing.
 *
 * **Matched on `event.key`, never `event.code`** — see `matchesCombo`. The old
 * rules here accepted `code === 'KeyE'` as a layout-independent fallback, and
 * that fallback becomes actively wrong once the key is user-assignable: the
 * Settings recorder builds its combo from `event.key`, so a `code` match would
 * fire for a physical key position the user never recorded. Live matching and
 * recording now read the same field, which is what makes a rebind mean what
 * the user saw when they pressed it. CapsLock is still covered — `key` reports
 * `'E'` and `canonicalizeCombo` lowercases both sides.
 */
export interface CanvasCombos {
  /** Bare, on the canvas: enlarge the selected node into the overlay. */
  enlarge: string;
  /** Bare, on the canvas: leave for the selected node's own tab. */
  openTab: string;
  /** A chord INSIDE a live terminal: hand the keyboard back to the canvas. */
  leaveTerminal: string;
  /** A chord INSIDE a live terminal: leave for this node's own tab. */
  openTabFromOverlay: string;
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
export function fitShortcut(e: CanvasKey): FitTarget | null {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
  if (inEditable(e.target)) return null;
  if (e.code === 'Digit1' || e.key === '!' || e.key === '1') return 'all';
  if (e.code === 'Digit2' || e.key === '@' || e.key === '2') return 'group';
  return null;
}

/**
 * <kbd>E</kbd> by default — enlarge the selected node into the full-screen overlay (Tam's item 2).
 *
 * Bare, with no modifier, which it can only afford to be because the caller gates it on the
 * canvas holding the keyboard: the moment a node is focused, `E` is a letter someone is typing
 * into a shell. That gate is the caller's (it knows `focusedId`), exactly as it is for
 * `fitShortcut`.
 *
 * The editable refusal stays, so a rename box and the sidebar search keep their letters — and it
 * matters more now, not less: a rebound bare key is still a bare key.
 */
export function openOverlayShortcut(e: CanvasKey, combo: string): boolean {
  if (inEditable(e.target)) return false;
  return matchesCombo(e, combo);
}

/**
 * <kbd>T</kbd> by default — leave the canvas for the selected node's OWN TAB (Tam, 2026-08-21).
 *
 * The keyboard half of the `⧉` button already in every node header, and it goes through the same
 * `openAsTab` callback rather than repeating what that does: the two would otherwise be a pair of
 * "leave for the tab" implementations that could drift on which of tab/pane they restore.
 *
 * Bare and canvas-only for the same reason `openOverlayShortcut` is, with the same editable
 * refusal and the same caller-owned `focusedId` gate. Its sibling for use INSIDE a terminal is
 * `openTabFromOverlayShortcut`.
 */
export function openTabShortcut(e: CanvasKey, combo: string): boolean {
  if (inEditable(e.target)) return false;
  return matchesCombo(e, combo);
}

/**
 * <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> by default — give the keyboard
 * back to the canvas: close the overlay if one is open, and release the terminal (Tam's items 1
 * and 2).
 *
 * **This is one of the two rules that must fire INSIDE a terminal, so it must not test for an
 * editable target.** xterm's keyboard sink is a real `<textarea>`, so while a terminal holds the
 * keyboard `event.target` is one — the guard every canvas-side rule here needs would refuse this
 * shortcut in precisely the state it exists for. Adding it "for consistency" is the change that
 * breaks it.
 *
 * **It replaces Esc, which is why it exists at all.** Esc used to close the overlay, and that
 * made the key unusable in the terminal the overlay is showing — vim, less, fzf and every menu
 * in codex want it. So Esc now goes to the PTY and the way out is a chord no TUI binds.
 *
 * Ctrl and Cmd are both accepted on every platform without branching on `navigator.platform`:
 * `matchesCombo` folds Meta into Ctrl, exactly as InputHandler does for every other shortcut in
 * the app. Ctrl+E ALONE stays untouched, which matters: that is readline's end-of-line.
 */
export function leaveTerminalShortcut(e: CanvasKey, combo: string): boolean {
  return matchesCombo(e, combo);
}

/**
 * <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>T</kbd> by default — leave for this node's own tab from
 * INSIDE the enlarged terminal (Tam, 2026-08-21).
 *
 * The chord exists because the bare key must not: Tam's requirement is that while a node is being
 * edited, a lone <kbd>T</kbd> is a `t` the shell receives. Only a modified key can mean anything
 * else there, which is why this is the one canvas action with a different default from its
 * canvas-side twin rather than the same key reused.
 *
 * No editable refusal, for the same reason `leaveTerminalShortcut` has none.
 */
export function openTabFromOverlayShortcut(e: CanvasKey, combo: string): boolean {
  return matchesCombo(e, combo);
}

/** A unit step, in the direction the VIEW moves — <kbd>→</kbd> shows you what was off the right
 *  edge. The world therefore translates the other way; `panBy` owns that inversion. */
export interface PanDir {
  dx: number;
  dy: number;
}

/**
 * How far one arrow press slides the canvas, in SCREEN pixels (Tam's item 3).
 *
 * Screen pixels, not world units, so a press moves the same visible distance at every zoom —
 * a world-unit step would crawl when zoomed out and fling you off the workspace when zoomed in.
 * It is also what makes the minimap's arrows a genuinely different scale rather than a second
 * copy of this one: that step is measured in MINIMAP pixels, so it is constant relative to the
 * whole workspace instead of to the screen. See `minimapPanStep`.
 */
export const PAN_STEP_PX = 96;

/**
 * Arrow keys pan the canvas.
 *
 * Bare arrows only. <kbd>Alt</kbd>+<kbd>Shift</kbd>+arrow is pane resize and plain
 * <kbd>Alt</kbd>+arrow is word movement in the shell (see `shortcutActions`'s reserved list), so
 * taking a modified arrow here would shadow a binding the rest of the app already owns.
 */
export function panShortcut(e: CanvasKey): PanDir | null {
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
  if (inEditable(e.target)) return null;
  if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') return { dx: -1, dy: 0 };
  if (e.code === 'ArrowRight' || e.key === 'ArrowRight') return { dx: 1, dy: 0 };
  if (e.code === 'ArrowUp' || e.key === 'ArrowUp') return { dx: 0, dy: -1 };
  if (e.code === 'ArrowDown' || e.key === 'ArrowDown') return { dx: 0, dy: 1 };
  return null;
}

/** Which way <kbd>Tab</kbd> steps through the terminals. */
export type StepDir = 1 | -1;

/**
 * <kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> walk the terminals in reading order.
 *
 * **Tab inside a terminal is still a Tab**, which is the only reason this can be Tab at all: the
 * caller gates it on the canvas holding the keyboard, so shell completion is untouched. Modified
 * Tabs are refused because <kbd>Ctrl</kbd>+<kbd>Tab</kbd> and
 * <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> switch app tabs (`shortcutActions`) and would
 * otherwise mean two things at once on this one surface.
 *
 * One more refusal lives in the WIRING and cannot live here: Tab is how a keyboard user reaches
 * the sidebar search, the toolbar and the minimap. When the press lands on any of those, it must
 * keep moving focus — see `FOCUSABLE_CHROME` in `CanvasMode`. That check needs the DOM.
 */
export function stepShortcut(e: CanvasKey): StepDir | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (inEditable(e.target)) return null;
  if (e.code !== 'Tab' && e.key !== 'Tab') return null;
  return e.shiftKey ? -1 : 1;
}

/**
 * <kbd>Delete</kbd> / <kbd>Backspace</kbd> — remove the selected connection.
 *
 * Both keys, because which one "delete" means is a platform habit rather than a fact: a Mac
 * laptop's big key reports `Backspace`, and a full keyboard's dedicated key reports `Delete`.
 * Accepting one would leave half the users pressing a key that does nothing.
 *
 * **Bare only, and gated on something being selected by the caller.** Backspace is the single
 * most destructive key to take speculatively — a browser once navigated back on it — so this
 * resolves to an action only when there is a connection to remove, and the press is otherwise
 * left completely alone. It never applies to a selected NODE: closing a terminal is
 * `canvasClose`'s job and has its own confirmation.
 */
export function deleteShortcut(e: CanvasKey): boolean {
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (inEditable(e.target)) return false;
  return e.code === 'Delete' || e.key === 'Delete'
    || e.code === 'Backspace' || e.key === 'Backspace';
}

/** What a zoom keypress is asking the canvas for. */
export type ZoomIntent = 'in' | 'out' | 'reset';

/**
 * <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>+</kbd> / <kbd>−</kbd> / <kbd>0</kbd> zoom the CANVAS.
 *
 * **There is no conflict with the terminal's font zoom, which is why these keys are free.** The
 * engine binds the same set through xterm's `attachCustomKeyEventHandler`, which only ever runs
 * while xterm holds DOM focus — so it fires inside a focused terminal and nowhere else. Gated on
 * `focusedId` by the caller, the two surfaces divide the same chord exactly the way Tam asked
 * for: the canvas zooms the canvas, and a terminal you are editing zooms its text.
 *
 * The key set is copied from the engine's handler deliberately, down to the numpad codes. Two
 * surfaces answering the same idea with different key lists is a difference nobody can see until
 * one of them does not respond — and `=` matters most, since `+` is a shifted key on most
 * layouts and `Ctrl+=` is what people actually press.
 *
 * Shift is deliberately not tested for the same reason: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>=</kbd>
 * IS <kbd>Ctrl</kbd>+<kbd>+</kbd> on a US keyboard.
 */
export function zoomShortcut(e: CanvasKey): ZoomIntent | null {
  if (!e.ctrlKey && !e.metaKey) return null;
  if (e.altKey) return null;
  if (inEditable(e.target)) return null;
  if (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') return 'in';
  if (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract') return 'out';
  if (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') return 'reset';
  return null;
}

/* ---- The two resolvers -----------------------------------------------------
 *
 * The rules above answer "is this that key?". These answer "so what happens?", which is the
 * question the component used to answer inline — and the one item 1 was a wrong answer to: Esc
 * closed the overlay, which made Esc unusable in the terminal the overlay exists to show. That
 * was a RULE living in wiring, where nothing could reach it. Both resolvers below are pure, so
 * "Esc inside an open overlay is a passthrough" is now a fact with a test rather than a branch
 * inside an effect.
 *
 * They are split by which keyboard the press arrived on, which is also the gate each caller
 * applies: `canvasKeyAction` for keys the canvas owns, `terminalKeyAction` for keys pressed
 * while a terminal is holding them. Nothing is in both.
 */

/** What a key the CANVAS owns is asking for. Pan deltas come out already multiplied by
 *  `PAN_STEP_PX`, so no caller can apply the step twice or invent its own. */
export type CanvasAction =
  | { do: 'fit'; target: FitTarget }
  | { do: 'overlay' }
  | { do: 'open-tab' }
  | { do: 'pan'; dx: number; dy: number }
  | { do: 'step'; dir: StepDir }
  | { do: 'zoom'; intent: ZoomIntent }
  | { do: 'delete-edge' };

/**
 * What the canvas currently has selected.
 *
 * An object rather than two booleans, and that is a deliberate defence rather than taste: they
 * are adjacent, identically typed and mean opposite things, so a caller that swapped them would
 * compile, pass type-checking, and fail only as `E` opening an overlay on nothing while Delete
 * removed a connection nobody had selected. Named fields make the mistake unwritable.
 */
export interface CanvasSelection {
  node: boolean;
  edge: boolean;
}

export function canvasKeyAction(
  e: CanvasKey,
  sel: CanvasSelection,
  combos: CanvasCombos,
): CanvasAction | null {
  // Zoom first because it is the only rule here that REQUIRES a modifier; every other one
  // refuses Ctrl/Cmd, so the order below is a readability choice rather than a load-bearing one.
  const intent = zoomShortcut(e);
  if (intent) return { do: 'zoom', intent };
  const target = fitShortcut(e);
  if (target) return { do: 'fit', target };
  // Same shape as `E` below: with no connection selected the press resolves to nothing at all,
  // so Backspace keeps whatever meaning the rest of the app gives it.
  if (deleteShortcut(e)) return sel.edge ? { do: 'delete-edge' } : null;
  // `E` with nothing selected resolves to nothing AT ALL, rather than to an action the caller
  // then declines. That is what leaves the keypress untouched: an overlay opening on a terminal
  // the user never pointed at is worse than a key that did nothing.
  if (openOverlayShortcut(e, combos.enlarge)) return sel.node ? { do: 'overlay' } : null;
  // `T` takes the same shape, and for the sharper version of the same reason: this one LEAVES
  // THE CANVAS. A stray press resolving to an action would yank the user to a tab they never
  // chose, which is the most disorienting thing any key on this surface can do.
  if (openTabShortcut(e, combos.openTab)) return sel.node ? { do: 'open-tab' } : null;
  // Unlike `E`, stepping with nothing selected is meaningful — it starts at one end.
  const step = stepShortcut(e);
  if (step) return { do: 'step', dir: step };
  const dir = panShortcut(e);
  if (dir) return { do: 'pan', dx: dir.dx * PAN_STEP_PX, dy: dir.dy * PAN_STEP_PX };
  return null;
}

/**
 * What a key pressed INSIDE a focused terminal means to the canvas.
 *
 * `'passthrough'` is a real answer rather than the absence of one, and saying so is the point:
 * it is what Esc resolves to whenever an overlay is open, and the caller must then leave the
 * event completely alone — no `preventDefault`, no `stopPropagation` — so it reaches the PTY.
 */
export type TerminalAction = 'leave' | 'open-tab' | 'release-focus' | 'passthrough';

export function terminalKeyAction(
  e: CanvasKey,
  overlayOpen: boolean,
  combos: CanvasCombos,
): TerminalAction {
  if (leaveTerminalShortcut(e, combos.leaveTerminal)) return 'leave';
  // Ctrl+T by default. Answered here and NOT in `canvasKeyAction`, which is what makes Tam's
  // requirement hold from both sides: the bare key means "open the tab" only where the canvas
  // owns the keyboard, and a lone `t` typed into this terminal falls through to `passthrough`
  // below like any other letter.
  if (openTabFromOverlayShortcut(e, combos.openTabFromOverlay)) return 'open-tab';
  if (e.key !== 'Escape') return 'passthrough';
  // Esc keeps its other job. With no overlay open a node can still be holding the keyboard —
  // closing an overlay deliberately does not blur — and there Esc is what hands it back.
  return overlayOpen ? 'passthrough' : 'release-focus';
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
