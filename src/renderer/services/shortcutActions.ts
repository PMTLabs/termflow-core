/**
 * Single source of truth for the user-customizable keyboard shortcuts.
 * Consumed by InputHandler (registration/rebinding), CanvasMode (its own
 * capture-phase listener) and the Settings > Shortcuts UI (rendering +
 * reset-to-default). Kept free of React/Redux so findConflict can be tested
 * in isolation.
 *
 * NOT included here (see docs/041-keyboard-shortcuts-customization-design.md
 * §3): Ctrl+1-9 (systematic tab-jump loop, not one action) and Ctrl+Shift+V
 * (fixed secondary fallback for the same Paste action as Ctrl+V).
 */

/**
 * WHICH SURFACE owns an action's combo — and therefore who registers it.
 *
 *  - `'global'` — InputHandler claims it on `window` in the capture phase, so
 *    it fires anywhere in the app.
 *  - `'canvas'` — CanvasMode matches it in ITS own capture-phase listener,
 *    which exists only while the canvas tab is mounted and (for the bare-key
 *    ones) only while the canvas rather than a terminal holds the keyboard.
 *
 * The distinction is load-bearing, not cosmetic: the canvas actions include
 * BARE LETTERS. A bare `T` handed to InputHandler would fire on every `t`
 * typed into any terminal in the app. InputHandler therefore registers
 * `GLOBAL_SHORTCUT_ACTIONS` only — see `isGlobalAction`.
 */
export type ShortcutScope = 'global' | 'canvas';

export interface ShortcutAction {
  id: string;
  label: string;
  defaultCombo: string;
  /** Absent means `'global'` — the default every pre-canvas action had. */
  scope?: ShortcutScope;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: 'newTab', label: 'New Tab', defaultCombo: 'Ctrl+Shift+T' },
  { id: 'closeTab', label: 'Close Tab', defaultCombo: 'Ctrl+W' },
  { id: 'nextTab', label: 'Next Tab', defaultCombo: 'Ctrl+Tab' },
  { id: 'prevTab', label: 'Previous Tab', defaultCombo: 'Ctrl+Shift+Tab' },
  { id: 'splitHorizontal', label: 'Split Pane', defaultCombo: 'Ctrl+Shift+D' },
  { id: 'closePane', label: 'Close Pane', defaultCombo: 'Ctrl+Shift+W' },
  { id: 'toggleMaximizePane', label: 'Maximize Pane', defaultCombo: 'Ctrl+Shift+Enter' },
  { id: 'focusNextPane', label: 'Focus Next Pane', defaultCombo: 'Alt+]' },
  { id: 'focusPrevPane', label: 'Focus Previous Pane', defaultCombo: 'Alt+[' },
  { id: 'paste', label: 'Paste', defaultCombo: 'Ctrl+V' },
  { id: 'clearTerminal', label: 'Clear Terminal', defaultCombo: 'Ctrl+Shift+X' },
  { id: 'openSettings', label: 'Open Settings', defaultCombo: 'Ctrl+,' },
  /*
   * Snippets, without the right-click (plan/029). Global rather than canvas-scoped: it
   * targets `resolveKeyboardTerminalId`, which already answers "the terminal the keyboard
   * is talking to" on both the pane and the canvas overlay, so one registration serves
   * both surfaces.
   *
   * `Ctrl+Shift+S` is free app-wide — not in RESERVED_COMBOS, not held by any action above,
   * and, being a Ctrl+SHIFT chord, not a control code any shell reads (Ctrl+S alone is
   * XOFF and would freeze the terminal, which is exactly why the Shift is not optional).
   */
  { id: 'openSnippets', label: 'Open Snippets Menu', defaultCombo: 'Ctrl+Shift+S' },
  { id: 'toggleFullScreen', label: 'Toggle Fullscreen', defaultCombo: 'F11' },
  { id: 'toggleCanvasMode', label: 'Toggle Canvas Mode', defaultCombo: 'Ctrl+Shift+Alt+Space' },

  /* ---- Canvas mode ---------------------------------------------------------
   *
   * Bare keys are affordable here for the reason the canvas's own listener
   * documents: it gates every one of them on the canvas — not a terminal —
   * holding the keyboard. The two `Ctrl+` chords are the mirror, and are the
   * only canvas actions that fire INSIDE a live terminal.
   *
   * `T` / `Ctrl+T`: Tam's request, 2026-08-21. `Ctrl+T` is genuinely free
   * app-wide — InputHandler deliberately leaves it unregistered (see its
   * "Ctrl+T (new tab) intentionally NOT registered" note) — and the pair is
   * reachable one-handed from the left Ctrl.
   */
  { id: 'canvasOpenNodeTab', label: 'Open Node in Its Tab', defaultCombo: 'T', scope: 'canvas' },
  { id: 'canvasOpenNodeTabFromOverlay', label: 'Open Node in Its Tab (while editing)', defaultCombo: 'Ctrl+T', scope: 'canvas' },
  { id: 'canvasEnlargeNode', label: 'Enlarge Node', defaultCombo: 'E', scope: 'canvas' },
  { id: 'canvasLeaveTerminal', label: 'Leave Terminal / Shrink Overlay', defaultCombo: 'Ctrl+Shift+E', scope: 'canvas' },

  /**
   * `A` / `L`: Tam's request, 2026-08-24 — the toolbar's Arrange and List buttons had no
   * shortcut to name in their own tooltip. Bare, for the same reason `T`/`E` are: neither needs a
   * selection, and the canvas's own listener already gates every bare key on the canvas — not a
   * terminal — holding the keyboard.
   */
  { id: 'canvasArrange', label: 'Arrange', defaultCombo: 'A', scope: 'canvas' },
  { id: 'canvasToggleList', label: 'Toggle Terminal List', defaultCombo: 'L', scope: 'canvas' },
];

/** An action fires app-wide (InputHandler's map) rather than on one surface. */
export function isGlobalAction(action: ShortcutAction): boolean {
  return (action.scope ?? 'global') === 'global';
}

/**
 * May this action be bound to a combo with NO modifier at all?
 *
 * The Settings recorder otherwise demands a modifier or a function key, and that rule is right
 * for everything InputHandler registers: a global bare `T` would `preventDefault` every `t`
 * typed anywhere in the app.
 *
 * It is wrong for a canvas action, and wrong in the way that matters — `canvasOpenNodeTab` and
 * `canvasEnlargeNode` SHIP with bare defaults. Applying the global rule to them would leave two
 * rows the user can see, whose current value is a bare letter, and which can never be re-recorded
 * to another bare letter. That is the same trap the recorder's own Space comment records having
 * fallen into once already.
 *
 * What makes the bare key safe here is not this function but the canvas's gate: its listener runs
 * only while `CanvasMode` is mounted AND no terminal holds the keyboard. Nothing else in the app
 * has that property, which is why this is keyed on scope rather than offered as an opt-out flag.
 */
export function allowsModifierlessCombo(actionId: string): boolean {
  const action = SHORTCUT_ACTIONS.find(a => a.id === actionId);
  return !!action && !isGlobalAction(action);
}

/**
 * The actions InputHandler may register. Everything else belongs to a surface
 * that listens for itself.
 *
 * Exported as its own list rather than left as an inline `.filter` at each of
 * InputHandler's two registration paths: a gate written out at the call site
 * is one a new call site can forget, and the failure here is silent and
 * app-wide (a bare letter swallowed from every terminal).
 */
export const GLOBAL_SHORTCUT_ACTIONS: ShortcutAction[] = SHORTCUT_ACTIONS.filter(isGlobalAction);

/** The canvas-scoped actions, in registry order — what Settings groups under its own heading. */
export const CANVAS_SHORTCUT_ACTIONS: ShortcutAction[] = SHORTCUT_ACTIONS.filter(a => !isGlobalAction(a));

/**
 * The canvas keys that are FIXED — real shortcuts, listed for the user, not yet rebindable.
 *
 * Tam, 2026-08-21: *"There are many shortcuts still are missing... such as the view all,
 * Shift 1/2. Can you put that into the shortcuts screen? just list out but not allow to change
 * for now"*. Making them assignable is `docs/backlog/008`.
 *
 * **This table is the single source for two jobs that were previously written out twice**: what
 * Settings displays, and which combos `RESERVED_COMBOS` protects. Kept together deliberately —
 * a hand-maintained reserve list beside a hand-maintained display list drifts in the direction
 * that is worst: a key shown to the user as "Next Node" that a customizable action is free to
 * bind over, silently, and only on the canvas.
 *
 * `display` is what the user presses; `reserve` is every canonical spelling that has to be
 * blocked. The two differ more often than they look:
 *
 *  - one row can own several keys (`Delete` and `Backspace` are one command);
 *  - `+` cannot appear raw in a combo string, so the zoom-in row reserves `Ctrl+Plus`;
 *  - **Shift+digit has no single spelling.** The recorder builds combos from `event.key`, so
 *    Shift+1 records as `shift+!` on a US layout and `shift+1` on an AZERTY. Both US spellings
 *    are reserved and other layouts stay exposed — see `RESERVED_COMBOS`'s own note.
 */
export interface CanvasFixedShortcut {
  label: string;
  /** What the user presses, for display. Never parsed. */
  display: string;
  /** Every canonical spelling to block, so nothing customizable can shadow this. */
  reserve: string[];
}

export const CANVAS_FIXED_SHORTCUTS: CanvasFixedShortcut[] = [
  { label: 'View All', display: 'Shift+1', reserve: ['Shift+1', 'Shift+!'] },
  { label: 'Fit Current Group', display: 'Shift+2', reserve: ['Shift+2', 'Shift+@'] },
  { label: 'Next / Previous Node', display: 'Tab  /  Shift+Tab', reserve: ['Tab', 'Shift+Tab'] },
  { label: 'Pan the Canvas', display: '↑  ↓  ←  →', reserve: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] },
  { label: 'Pan by Dragging', display: 'Hold Space + drag', reserve: ['Space'] },
  { label: 'Zoom In / Out', display: 'Ctrl+=  /  Ctrl+-', reserve: ['Ctrl+=', 'Ctrl+Plus', 'Ctrl+-'] },
  { label: 'Reset Zoom', display: 'Ctrl+0', reserve: ['Ctrl+0'] },
  { label: 'Remove Selected Connection', display: 'Delete  /  Backspace', reserve: ['Delete', 'Backspace'] },
];

/**
 * Map a KeyboardEvent's `key` to the token a combo string uses for it.
 *
 * Two keys cannot appear raw in a `+`-delimited, whitespace-trimmed combo
 * string, and both lose their identity silently rather than failing loudly:
 *
 *  - `'+'` IS the delimiter, so "Ctrl++" splits into an empty trailing segment.
 *  - `' '` is trimmed to `''` and then dropped by `.filter(Boolean)`, so
 *    "Ctrl+Shift+Alt+ " canonicalizes to "control+alt+shift+" — a registered
 *    Space shortcut can never match a real Space keypress.
 *
 * Both the live matching path (InputHandler) and the recording UI (Settings)
 * go through here, so the two can no longer disagree about what a keypress is
 * called. They previously each carried their own copy of the `'+'` case, and
 * the recorder's copy landed one review round after the matcher's.
 */
export function comboKeyToken(key: string): string {
  if (key === '+') return 'Plus';
  if (key === ' ') return 'Space';
  return key;
}

/**
 * Single source of truth for combo normalization — parses a `+`-delimited
 * combo string into modifier flags plus a main key, then reconstructs a
 * canonical string, rather than a chain of sequential string replacements
 * (that approach produced three separate bugs across two review rounds: a
 * missed arrow-key strip, Cmd/Meta not unifying with Ctrl the way
 * InputHandler.handleKeyEvent does, and modifier-order sensitivity).
 *
 * InputHandler.normalizeKey delegates to this exact function, and
 * handleKeyEvent's live combo-matching builds a raw string and canonicalizes
 * it the same way — so there is exactly one normalization implementation in
 * the whole app, not two hand-synchronized ones.
 */
export function canonicalizeCombo(combo: string): string {
  const rawParts = combo.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);

  let ctrl = false;
  let alt = false;
  let shift = false;
  let mainKey = '';

  for (const part of rawParts) {
    if (part === 'ctrl' || part === 'control' || part === 'cmd' || part === 'meta') { ctrl = true; continue; }
    if (part === 'alt') { alt = true; continue; }
    if (part === 'shift') { shift = true; continue; }
    mainKey = part;
  }

  mainKey = mainKey.replace(/^arrow/, '');

  const modifiers: string[] = [];
  if (ctrl) modifiers.push('control');
  if (alt) modifiers.push('alt');
  if (shift) modifiers.push('shift');

  return [...modifiers, mainKey].join('+');
}

/** The parts of a KeyboardEvent a combo is built from. Narrowed so a caller does not need a DOM. */
export interface ComboEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * The canonical combo string for a LIVE keypress.
 *
 * Lifted out of `InputHandler.handleKeyEvent`, which built this inline, so the
 * canvas can ask the same question of the same event without becoming a third
 * implementation. This file's whole claim is that there is exactly one
 * normalization path in the app; a second live-matching path would have ended
 * that quietly, and the three bugs the header note lists were all drift
 * between two copies of this logic.
 *
 * Ctrl and Meta both become `control`, so a `Ctrl+`-defaulted action answers
 * Cmd on macOS without a second registration — the behaviour every existing
 * shortcut already has.
 */
export function eventCombo(e: ComboEvent): string {
  const rawParts: string[] = [];
  if (e.ctrlKey || e.metaKey) rawParts.push('Ctrl');
  if (e.altKey) rawParts.push('Alt');
  if (e.shiftKey) rawParts.push('Shift');
  // Keys that cannot survive a '+'-delimited, whitespace-trimmed combo string
  // ('+' itself, and Space) become their word form here.
  rawParts.push(comboKeyToken(e.key));
  return canonicalizeCombo(rawParts.join('+'));
}

/**
 * Does this keypress BE this combo?
 *
 * Both sides go through `canonicalizeCombo`, so `'Ctrl+Shift+E'`,
 * `'shift+control+e'` and a real Cmd+Shift+E keypress are all one value.
 *
 * An empty/absent combo matches nothing. That matters: it is what an action
 * bound to `''` by corrupt settings resolves to, and silently matching every
 * keypress would be far worse than matching none.
 */
export function matchesCombo(e: ComboEvent, combo: string | undefined | null): boolean {
  if (!combo) return false;
  if (typeof e.key !== 'string') return false;
  return eventCombo(e) === canonicalizeCombo(combo);
}

/** The combo currently in effect for an action: its override if set, else its default. */
export function effectiveCombo(actionId: string, customKeybindings: Record<string, string> | null | undefined = {}): string | undefined {
  const action = SHORTCUT_ACTIONS.find(a => a.id === actionId);
  if (!action) return undefined;
  return (customKeybindings ?? {})[actionId] ?? action.defaultCombo;
}

/**
 * Combos permanently owned by non-customizable shortcuts in InputHandler —
 * Ctrl+1-9 (tab-jump), Ctrl+Shift+V (fixed secondary paste fallback), and the
 * 4 Alt+Shift+Arrow pane-resize bindings. A customizable action can never be
 * assigned one of these (see design doc §3 non-goals). Plain Alt+Arrow was
 * removed from this list when the pane-nav stub was deleted: those keys now
 * pass through to the terminal (word movement).
 */
const RESERVED_COMBOS = [
  'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9',
  'Ctrl+Shift+V',
  'Alt+Shift+ArrowLeft', 'Alt+Shift+ArrowRight', 'Alt+Shift+ArrowUp', 'Alt+Shift+ArrowDown',

  /* The canvas's FIXED navigation, DERIVED from the table Settings displays rather than
   * repeated here — see `CANVAS_FIXED_SHORTCUTS`.
   *
   * Without these, Settings would happily accept "Open Node in Its Tab = Tab" and the canvas
   * would silently lose Tab-stepping, or an arrow would both pan and leave for a tab. The
   * failure is invisible at bind time and only shows up as a canvas key that stopped working.
   * Deriving is what stops the displayed list and the protected list drifting apart: a row added
   * to that table is reserved the same day it becomes visible.
   *
   * The zoom chords are in there for the reason InputHandler already documents for not binding
   * them ("Ctrl/Cmd +/-/0 zoom is intentionally NOT bound here"): zoom is per-surface, owned by
   * each terminal pane, the canvas and the Settings screen. A customizable action landing on one
   * would shadow all three at once.
   *
   * KNOWN GAP, deliberately not half-fixed: Shift+1 / Shift+2 (fit all / fit group) cannot be
   * reserved reliably. The recorder builds combos from `event.key`, so pressing Shift+1 records
   * as `shift+!` on a US layout and `shift+1` on an AZERTY — there is no single spelling to
   * reserve. Both US spellings are listed; other layouts stay exposed. Fixing it properly means
   * teaching the recorder `event.code` for digits, which is its own change (docs/backlog/008).
   */
  ...CANVAS_FIXED_SHORTCUTS.flatMap(s => s.reserve),
].map(canonicalizeCombo);

export type ShortcutConflict =
  | { type: 'action'; actionId: string; label: string }
  | { type: 'reserved' };

/**
 * Returns the conflict for `combo` — either an OTHER action currently bound
 * to it, or a fixed/reserved binding — or null if there's no conflict. Never
 * compares against `actionId` itself.
 */
export function findConflict(actionId: string, combo: string, customKeybindings: Record<string, string> | null | undefined = {}): ShortcutConflict | null {
  const target = canonicalizeCombo(combo);

  if (RESERVED_COMBOS.includes(target)) {
    return { type: 'reserved' };
  }

  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === actionId) continue;
    const current = effectiveCombo(action.id, customKeybindings);
    if (current && canonicalizeCombo(current) === target) {
      return { type: 'action', actionId: action.id, label: action.label };
    }
  }
  return null;
}
