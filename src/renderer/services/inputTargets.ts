/**
 * Decide whether a keystroke is aimed at an editable element that is NOT part of a
 * terminal — i.e. a normal `<input>`/`<textarea>`/`<select>`/contenteditable.
 *
 * Such targets must keep native editing shortcuts (paste/copy/cut/undo/select-all),
 * so the global shortcut handler bails out for them instead of claiming the key.
 * The terminal's own xterm helper textarea lives under `.xterm`/`.terminal-display`
 * and is intentionally excluded so terminal paste still routes through the handler.
 *
 * Kept dependency-free and pure so it is cheaply unit-testable.
 */
export function isEditableNonTerminalTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  // Terminal owns its own input handling — never treat its textarea as a plain field.
  if (el.closest('.xterm') || el.closest('.terminal-display')) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}
