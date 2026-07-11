import type { Terminal } from '@xterm/xterm';
import { redactSecrets } from './redactSecrets';

// Popup state machine (backlog 011). 'passive': popup visible, all keys still
// reach the shell except Shift+Enter (accept), Down (focus), Esc (dismiss).
// 'focused': arrows navigate, Enter accepts, Esc returns to passive.
export type SuggestPopupState = 'closed' | 'passive' | 'focused';
export type SuggestAction = 'accept' | 'up' | 'down' | 'focus' | 'dismiss' | 'delete';

/** Pure key -> action decision so the two-state model is unit-testable. Callers
 *  must pre-filter: keydown only, popup not 'closed', no ctrl/alt/meta. */
export function decideSuggestKey(
  state: 'passive' | 'focused',
  key: string,
  shiftKey: boolean,
): SuggestAction | null {
  if (key === 'Escape') return 'dismiss';
  if (key === 'Enter' && shiftKey) return 'accept';
  if (state === 'passive') return key === 'ArrowDown' ? 'focus' : null;
  if (key === 'ArrowDown') return 'down';
  if (key === 'ArrowUp') return 'up';
  if (key === 'Enter') return 'accept';
  // Focused only: remove the selected entry from history (deliberate gesture on
  // an explicitly selected item; passive Shift+Delete still reaches the shell).
  if (key === 'Delete' && shiftKey) return 'delete';
  return null;
}

export interface CommandCaptureEvents {
  onCommandSubmitted?(command: string): void;
}

/** Command-boundary detection behind an interface so a future OSC 133 shell-
 *  integration tracker can replace the heuristic without engine changes. */
export interface CommandBoundaryTracker {
  noteUserKey(): void;
  submit(): void;
  cancel(): void;
  hasMark(): boolean;
  getCurrentInput(untilCursor?: boolean): string | null;
  charsBeforeCursor(cols: number): number;
  getMark(): { row: number; col: number } | null;
  restoreMark(mark: { row: number; col: number } | null): void;
}

const MAX_COMMAND_LENGTH = 500;
// A prompt line can soft-wrap; beyond this many rows assume the mark is stale.
// Sized so a MAX_COMMAND_LENGTH command still fits at a ~42-col split pane —
// staleness is primarily detected by the isWrapped guard, not this cap.
const MAX_WRAPPED_ROWS = 12;

/**
 * v1 heuristic: the cursor position at the FIRST keystroke after the previous
 * submit/cancel marks where prompt input begins. On submit, read the real buffer
 * from the mark to the cursor row — the shell's echo is the source of truth, so
 * tab-completion, up-arrow recall, and paste are all captured correctly.
 */
export class HeuristicCapture implements CommandBoundaryTracker {
  private mark: { row: number; col: number } | null = null;

  constructor(
    private readonly term: Terminal,
    private readonly events: CommandCaptureEvents = {},
    private readonly redact: (s: string) => string = redactSecrets,
  ) {}

  noteUserKey(): void {
    if (this.mark) return;
    const buf = this.term.buffer.active;
    this.mark = { row: buf.baseY + buf.cursorY, col: buf.cursorX };
  }

  cancel(): void {
    this.mark = null;
  }

  hasMark(): boolean {
    return this.mark !== null;
  }

  /** The current mark (for cross-remount persistence in the host's cache). */
  getMark(): { row: number; col: number } | null {
    return this.mark;
  }

  /** Restore a mark saved before an unmount — the cached Terminal's buffer
   *  survives a remount, so absolute row/col stay valid. */
  restoreMark(mark: { row: number; col: number } | null): void {
    this.mark = mark;
  }

  /**
   * Read the input between the mark and the cursor row.
   * `untilCursor` (live filtering): stop at the cursor column, so mid-line edits
   * match what the user is editing, not stale text right of the cursor.
   * Whole-line (default, used by submit): Enter runs the ENTIRE line regardless
   * of cursor position, so the capture must include text right of the cursor.
   */
  getCurrentInput(untilCursor = false): string | null {
    const mark = this.mark;
    if (!mark) return null;
    const buf = this.term.buffer.active;
    const cursorRow = buf.baseY + buf.cursorY;
    if (cursorRow < mark.row || cursorRow - mark.row > MAX_WRAPPED_ROWS) return null;
    // Whole-line (submit) mode must include soft-wrapped continuation rows BELOW
    // the cursor too: Home/Ctrl+A moves the cursor back to the first row while
    // the command still spans several — Enter runs ALL of it.
    let endRow = cursorRow;
    if (!untilCursor) {
      while (endRow - mark.row < MAX_WRAPPED_ROWS) {
        const next = buf.getLine(endRow + 1);
        if (!next || !next.isWrapped) break;
        endRow++;
      }
    }
    let text = '';
    for (let r = mark.row; r <= endRow; r++) {
      const line = buf.getLine(r);
      if (!line) return null;
      // Continuation rows must be soft-wrapped; a hard new line means the shell
      // moved on (fresh prompt, async output) and the mark is stale.
      if (r > mark.row && !line.isWrapped) return null;
      const isLast = r === endRow;
      const startCol = r === mark.row ? mark.col : 0;
      const endCol = isLast && untilCursor ? buf.cursorX : undefined;
      // Trim only the final row: trimming intermediate wrapped rows would eat
      // the space at the wrap point ("git clone " + "https://…").
      text += line.translateToString(isLast && !untilCursor, startCol, endCol);
    }
    return text;
  }

  /** Printable cells between the mark and the cursor — the number of DELs needed
   *  to erase the typed prefix regardless of where the cursor sits in the line. */
  charsBeforeCursor(cols: number): number {
    const mark = this.mark;
    if (!mark) return 0;
    const buf = this.term.buffer.active;
    const cursorRow = buf.baseY + buf.cursorY;
    if (cursorRow < mark.row) return 0;
    return Math.max(0, (cursorRow - mark.row) * cols + buf.cursorX - mark.col);
  }

  submit(): void {
    const raw = this.getCurrentInput();
    this.mark = null;
    if (raw === null) return;
    const cmd = raw.trim();
    if (!cmd || cmd.length > MAX_COMMAND_LENGTH) return;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(cmd)) return; // garbage guard
    this.events.onCommandSubmitted?.(this.redact(cmd));
  }
}
