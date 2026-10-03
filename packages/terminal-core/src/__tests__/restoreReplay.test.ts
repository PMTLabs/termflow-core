/**
 * wrapRestoreReplay against the REAL xterm.js parser.
 *
 * The rest of this package's tests run on a fake xterm (jsdom cannot host the real renderer), which
 * cannot say where a cursor ends up. This one needs exactly that, and only the parser: it loads the
 * real `@xterm/xterm` bundle by PATH, which the jest `moduleNameMapper` (it maps the bare package
 * name to the fake) does not touch, and never calls `open()`, so no DOM or canvas is involved.
 *
 * The oracle is the user-visible defect. ConPTY believes the shell's prompt is on row `anchor` and
 * repaints it there with an absolute position on the first keystroke; typed text must land on the
 * row below the "session restored" divider, never over the restored history.
 */
import * as path from 'path';
import { wrapRestoreReplay } from '../restoreReplay';

interface RealTerminal {
  buffer: {
    active: {
      baseY: number;
      cursorX: number;
      cursorY: number;
      length: number;
      getLine(n: number): { isWrapped: boolean; translateToString(trim?: boolean): string } | undefined;
    };
  };
  write(data: string, cb?: () => void): void;
  dispose(): void;
}
type RealTerminalCtor = new (opts: Record<string, unknown>) => RealTerminal;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Terminal } = require(
  path.resolve(__dirname, '../../../../node_modules/@xterm/xterm/lib/xterm.js'),
) as { Terminal: RealTerminalCtor };

/** The backend's divider (`REPLAY_SEPARATOR`): the replay always ends with it. */
const DIVIDER = '\r\n\x1b[2m──── session restored ──── \x1b[0m\r\n\r\n';
const history = (n: number) => Array.from({ length: n }, (_, i) => `old-line-${String(i + 1).padStart(3, '0')}`).join('\r\n');

function write(term: RealTerminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** Every buffer line (scrollback + screen), trimmed. */
function allLines(term: RealTerminal): string[] {
  const b = term.buffer.active;
  return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '');
}

/** The buffer as the lines that were WRITTEN: wrapped rows are joined back (untrimmed until joined). */
function logicalLines(term: RealTerminal): string[] {
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    const text = line?.translateToString(false) ?? '';
    if (line?.isWrapped && out.length > 0) out[out.length - 1] += text;
    else out.push(text);
  }
  return out.map((l) => l.trimEnd());
}

/** The divider exactly as the user sees it (the backend's `REPLAY_SEPARATOR` text, without styling). */
const DIVIDER_TEXT = '──── session restored ────';

interface Outcome {
  lines: string[];
  /** The same buffer with wrapped rows joined back into the lines that were written. */
  logical: string[];
  /** Viewport row (1-based) the typed text is on. */
  typedViewportRow: number;
  /** Absolute buffer index of the typed row and of the divider. */
  typedAbs: number;
  dividerAbs: number;
  cursorAfterReplay: { row: number; col: number };
}

/**
 * Replay `histLines` of history into a `rows`x`cols` terminal anchored on `anchor`, then act as
 * ConPTY/PSReadLine: a prompt repaint at an ABSOLUTE position on the anchor row, with typed text.
 */
async function restoreAndType(rows: number, cols: number, histLines: number, anchor: number): Promise<Outcome> {
  const term = new Terminal({ rows, cols, scrollback: 5000, allowProposedApi: true });
  try {
    await write(term, wrapRestoreReplay(history(histLines) + DIVIDER, anchor, rows));
    const b = term.buffer.active;
    const cursorAfterReplay = { row: b.cursorY + 1, col: b.cursorX + 1 };
    const target = Math.min(Math.max(anchor, 1), rows);
    // PSReadLine's repaint: absolute row, then the prompt and what was typed.
    await write(term, `\x1b[${target};1HPS> typed-text`);
    const lines = allLines(term);
    const typedAbs = lines.findIndex((l) => l.includes('PS> typed-text'));
    return {
      lines,
      logical: logicalLines(term),
      typedViewportRow: typedAbs - term.buffer.active.baseY + 1,
      typedAbs,
      // The divider's rule characters, not its words: on a narrow pane the text wraps mid-phrase.
      dividerAbs: lines.findIndex((l) => l.includes('────')),
      cursorAfterReplay,
    };
  } finally {
    term.dispose();
  }
}

/** The history lines present, in buffer order. */
const survivors = (lines: string[]) => lines.filter((l) => l.startsWith('old-line-'));

describe('wrapRestoreReplay on the real xterm parser', () => {
  // [rows, cols, history lines, anchor row, what the case exercises]
  const cases: Array<[number, number, number, number, string]> = [
    [24, 80, 100, 24, 'long history, anchor on the last row (the typical restore at the spawn size)'],
    [40, 120, 100, 24, 'long history, pane taller than the spawn size (anchor above the last row)'],
    [40, 120, 100, 30, 'long history, anchor mid-pane'],
    [24, 80, 3, 6, 'short history: the replay is shorter than the anchor row'],
    [40, 120, 3, 6, 'short history in a tall pane'],
    [24, 80, 20, 24, 'history that ends exactly on the anchor row'],
    [24, 80, 100, 1, 'above-the-fold fallback: anchor on row 1'],
    [24, 80, 3, 1, 'above-the-fold fallback with a short history'],
    [10, 80, 100, 24, 'anchor taller than the pane: clamped to the last row'],
    [10, 80, 100, 99, 'anchor far beyond the pane'],
    [24, 80, 100, 0, 'a nonsense anchor clamps to row 1'],
    [2, 20, 50, 2, 'a two-row terminal'],
    [24, 20, 12, 24, 'a narrow pane: every history line is shorter than the width'],
  ];

  test.each(cases)('rows=%i cols=%i history=%i anchor=%i: %s', async (rows, cols, hist, anchor) => {
    const target = Math.min(Math.max(anchor, 1), rows);
    const out = await restoreAndType(rows, cols, hist, anchor);

    // The cursor is where ConPTY believes the prompt is, at column 1, BEFORE anything is typed.
    expect(out.cursorAfterReplay).toEqual({ row: target, col: 1 });
    // The repaint lands on that row of the viewport...
    expect(out.typedViewportRow).toBe(target);
    // ...BELOW the divider, so it can never sit over restored content.
    expect(out.dividerAbs).toBeGreaterThanOrEqual(0);
    expect(out.typedAbs).toBeGreaterThan(out.dividerAbs);
    // The divider itself is intact, once, with its whole text (a pane narrower than it wraps it).
    expect(out.logical.filter((l) => l.includes('session restored'))).toEqual([DIVIDER_TEXT]);
    // Nothing the user had is lost or reordered: every history line is still there, oldest first.
    const kept = survivors(out.lines);
    expect(kept).toEqual(Array.from({ length: hist }, (_, i) => `old-line-${String(i + 1).padStart(3, '0')}`));
  });

  test('the scroll region is released: later output scrolls the whole pane, not rows 1..anchor', async () => {
    // ConPTY/the shell keep writing after the restore. If the replay's scroll region were left in
    // place, the cursor could never get below the anchor row and the rest of the pane would be dead.
    const rows = 24;
    for (const anchor of [1, 6, 12]) {
      const term = new Terminal({ rows, cols: 80, scrollback: 5000, allowProposedApi: true });
      try {
        await write(term, wrapRestoreReplay(history(40) + DIVIDER, anchor, rows));
        const output = Array.from({ length: 60 }, (_, i) => `out-${String(i + 1).padStart(2, '0')}`);
        await write(term, output.map((l) => `${l}\r\n`).join(''));
        const b = term.buffer.active;
        expect(b.cursorY).toBe(rows - 1);
        const lines = allLines(term);
        expect(lines.filter((l) => l.startsWith('out-'))).toEqual(output);
        expect(survivors(lines)).toHaveLength(40);
      } finally {
        term.dispose();
      }
    }
  });

  test('the typed row holds the prompt alone (no old text bleeds into it)', async () => {
    for (const anchor of [1, 6, 24]) {
      const out = await restoreAndType(24, 80, 40, anchor);
      expect(out.lines[out.typedAbs]).toBe('PS> typed-text');
    }
  });

  test('WITHOUT the wrapper the same restore puts the typed text over the history (the defect)', async () => {
    // Calibration: the oracle really can fail. A plain replay leaves the cursor on the last row of the
    // viewport; ConPTY's frame says the prompt is on row 1, so the repaint at row 1 lands on old content.
    const rows = 24;
    const term = new Terminal({ rows, cols: 80, scrollback: 5000, allowProposedApi: true });
    try {
      await write(term, history(100) + DIVIDER);
      await write(term, '\x1b[1;1HPS> typed-text');
      const b = term.buffer.active;
      const top = b.getLine(b.baseY)?.translateToString(true) ?? '';
      expect(top).toContain('PS> typed-text');
      // ...and what used to be on that row (a history line) is gone.
      expect(allLines(term).filter((l) => l.startsWith('old-line-')).length).toBeLessThan(100);
    } finally {
      term.dispose();
    }
  });
});

describe('wrapRestoreReplay (pure)', () => {
  test('wraps the replay in a scroll region ending on the anchor and parks the cursor there', () => {
    expect(wrapRestoreReplay('R', 24, 50)).toBe('\x1b[1;24r\x1b[1;1HR\x1b[r\x1b[24;1H');
  });

  test('clamps the anchor into the pane', () => {
    expect(wrapRestoreReplay('R', 99, 10)).toBe('\x1b[1;10r\x1b[1;1HR\x1b[r\x1b[10;1H');
    expect(wrapRestoreReplay('R', 0, 10)).toBe('\x1b[1;2r\x1b[1;1HR\x1b[r\x1b[1;1H');
    expect(wrapRestoreReplay('R', -5, 10)).toBe('\x1b[1;2r\x1b[1;1HR\x1b[r\x1b[1;1H');
    expect(wrapRestoreReplay('R', 7.9, 10)).toBe('\x1b[1;7r\x1b[1;1HR\x1b[r\x1b[7;1H');
    expect(wrapRestoreReplay('R', NaN, 10)).toBe('\x1b[1;2r\x1b[1;1HR\x1b[r\x1b[1;1H');
  });

  test('never asks for a one-row region (xterm ignores it): the region is at least two rows', () => {
    expect(wrapRestoreReplay('R', 1, 24)).toBe('\x1b[1;2r\x1b[1;1HR\x1b[r\x1b[1;1H');
  });

  test('a terminal too short to hold a region gets the replay unchanged', () => {
    expect(wrapRestoreReplay('R', 1, 1)).toBe('R');
    expect(wrapRestoreReplay('R', 1, 0)).toBe('R');
    expect(wrapRestoreReplay('R', 1, NaN)).toBe('R');
  });
});
