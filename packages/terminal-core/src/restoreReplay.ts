/**
 * Placing a restored session's replay so the cursor frame matches ConPTY's.
 *
 * A restored terminal replays the previous session's scrollback (ending with a "session
 * restored" divider) and the new shell starts after it. ConPTY addresses the screen
 * ABSOLUTELY — PSReadLine repaints with `ESC[row;colH` — in its own idea of where its prompt
 * is, so the replay has to leave xterm's cursor on THAT row, whatever the pane's size:
 *
 *   - the backend tells us the row (`anchorRow`, 1-based): the row ConPTY was told to start the
 *     child on (a restore that inherits the cursor), or row 1 (a restore that cannot, which
 *     wants the whole replay scrolled out of the viewport);
 *   - the replay is written inside a scroll region whose bottom row is that row, so it scrolls
 *     INSIDE rows 1..row and never pushes the cursor below it, whichever of "shorter than the
 *     anchor", "exactly as tall" and "taller" it is. Lines scrolled off the top of a region that
 *     starts at row 1 go into scrollback, which is where the history belongs;
 *   - the region is then released and the cursor put on the anchor row, column 1. Nothing is
 *     erased: rows below the anchor were never written to, and the rows above it keep the replay.
 *
 * The result depends on neither the size the terminal was CREATED at nor the pane's size
 * (the pane's row count is only used to clamp), which is the point: the renderer spawns at
 * 80x24 and is resized to the fitted pane before it hydrates.
 *
 * xterm.js ignores a one-row scroll region (it needs bottom > top), so the region is never
 * narrower than two rows. Anchoring on row 1 therefore works in rows 1-2; the replay ends with
 * the divider and a blank line, so it leaves both rows blank with the whole replay (divider
 * included) in scrollback and the cursor on row 1: a row-1 prompt with history only above it.
 */

const ESC = '\x1b';

/**
 * Wrap `replay` (the persisted blob + divider) so that, once written to a terminal with `rows`
 * rows, the cursor sits at column 1 of row `anchorRow` (clamped into 1..rows).
 *
 * A terminal too short to hold a scroll region (fewer than two rows) gets the replay unchanged.
 */
export function wrapRestoreReplay(replay: string, anchorRow: number, rows: number): string {
  if (!Number.isFinite(rows) || rows < 2) return replay;
  const row = Number.isFinite(anchorRow) ? Math.trunc(anchorRow) : 1;
  const target = Math.min(Math.max(row, 1), rows);
  const bottom = Math.min(Math.max(target, 2), rows);
  return `${ESC}[1;${bottom}r${ESC}[1;1H${replay}${ESC}[r${ESC}[${target};1H`;
}
