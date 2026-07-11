/**
 * Single source of truth for the 11 user-customizable keyboard shortcuts.
 * Consumed by InputHandler (registration/rebinding) and the Settings >
 * Shortcuts UI (rendering + reset-to-default). Kept free of React/Redux so
 * findConflict can be tested in isolation.
 *
 * NOT included here (see docs/041-keyboard-shortcuts-customization-design.md
 * §3): Ctrl+1-9 (systematic tab-jump loop, not one action), the 4 pane-nav
 * shortcuts (handlePaneNavigation is currently a stub), and Ctrl+Shift+V
 * (fixed secondary fallback for the same Paste action as Ctrl+V).
 */

export interface ShortcutAction {
  id: string;
  label: string;
  defaultCombo: string;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: 'newTab', label: 'New Tab', defaultCombo: 'Ctrl+Shift+T' },
  { id: 'closeTab', label: 'Close Tab', defaultCombo: 'Ctrl+W' },
  { id: 'nextTab', label: 'Next Tab', defaultCombo: 'Ctrl+Tab' },
  { id: 'prevTab', label: 'Previous Tab', defaultCombo: 'Ctrl+Shift+Tab' },
  { id: 'splitHorizontal', label: 'Split Pane', defaultCombo: 'Ctrl+Shift+D' },
  { id: 'closePane', label: 'Close Pane', defaultCombo: 'Ctrl+Shift+W' },
  { id: 'toggleMaximizePane', label: 'Maximize Pane', defaultCombo: 'Ctrl+Shift+Enter' },
  { id: 'paste', label: 'Paste', defaultCombo: 'Ctrl+V' },
  { id: 'clearTerminal', label: 'Clear Terminal', defaultCombo: 'Ctrl+Shift+X' },
  { id: 'openSettings', label: 'Open Settings', defaultCombo: 'Ctrl+,' },
  { id: 'toggleFullScreen', label: 'Toggle Fullscreen', defaultCombo: 'F11' },
];

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

/** The combo currently in effect for an action: its override if set, else its default. */
export function effectiveCombo(actionId: string, customKeybindings: Record<string, string> | null | undefined = {}): string | undefined {
  const action = SHORTCUT_ACTIONS.find(a => a.id === actionId);
  if (!action) return undefined;
  return (customKeybindings ?? {})[actionId] ?? action.defaultCombo;
}

/**
 * Combos permanently owned by non-customizable shortcuts in InputHandler —
 * Ctrl+1-9 (tab-jump), Ctrl+Shift+V (fixed secondary paste fallback), and the
 * 4 Alt+Arrow pane-nav slots. A customizable action can never be assigned one
 * of these (see design doc §3 non-goals).
 */
const RESERVED_COMBOS = [
  'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9',
  'Ctrl+Shift+V',
  'Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+ArrowUp', 'Alt+ArrowDown',
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
