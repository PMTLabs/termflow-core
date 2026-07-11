import type { Terminal } from '@xterm/xterm';
import { HeuristicCapture, decideSuggestKey } from '../commandCapture';

// Minimal fake exposing exactly what HeuristicCapture reads. Mutable so tests can
// simulate echo (line text) and cursor movement between calls.
function fakeTerm() {
  const lines: Record<number, { text: string; isWrapped: boolean }> = {};
  const active = {
    cursorX: 0,
    cursorY: 0,
    baseY: 0,
    viewportY: 0,
    type: 'normal',
    getLine: (r: number) =>
      lines[r] === undefined
        ? undefined
        : {
            isWrapped: lines[r].isWrapped,
            translateToString: (trim?: boolean, startCol?: number, endCol?: number) => {
              let t = lines[r].text.slice(startCol ?? 0, endCol);
              if (trim) t = t.replace(/\s+$/, '');
              return t;
            },
          },
  };
  return {
    term: { buffer: { active } } as unknown as Terminal,
    setLine: (row: number, text: string, isWrapped = false) => {
      lines[row] = { text, isWrapped };
    },
    setCursor: (x: number, y: number) => {
      active.cursorX = x;
      active.cursorY = y;
    },
    active,
  };
}

describe('HeuristicCapture', () => {
  it('captures the text typed after the prompt mark', () => {
    const f = fakeTerm();
    const cap = new HeuristicCapture(f.term);
    f.setLine(0, 'PS D:\\src> ');
    f.setCursor(11, 0); // cursor sits at prompt end
    cap.noteUserKey(); // first keystroke -> mark (row 0, col 11)
    f.setLine(0, 'PS D:\\src> dotnet build'); // shell echoed the typing
    f.setCursor(23, 0);
    expect(cap.getCurrentInput()).toBe('dotnet build');
  });

  it('submit trims, redacts, and emits; clears the mark', () => {
    const submitted: string[] = [];
    const f = fakeTerm();
    const cap = new HeuristicCapture(f.term, { onCommandSubmitted: (c) => submitted.push(c) });
    f.setCursor(4, 0);
    cap.noteUserKey();
    f.setLine(0, 'PS> export API_KEY=abc123  ');
    f.setCursor(26, 0);
    cap.submit();
    expect(submitted).toEqual(['export API_KEY=***']);
    expect(cap.hasMark()).toBe(false);
  });

  it('does not emit empty or oversized commands', () => {
    const submitted: string[] = [];
    const f = fakeTerm();
    const cap = new HeuristicCapture(f.term, { onCommandSubmitted: (c) => submitted.push(c) });
    f.setCursor(4, 0);
    cap.noteUserKey();
    f.setLine(0, 'PS> '); // user typed nothing visible
    cap.submit();
    f.setCursor(4, 0);
    cap.noteUserKey();
    f.setLine(0, 'PS> ' + 'x'.repeat(600));
    f.setCursor(4 + 600, 0);
    cap.submit();
    expect(submitted).toEqual([]);
  });

  it('joins wrapped rows between mark and cursor, preserving the wrap-point space', () => {
    const f = fakeTerm();
    const cap = new HeuristicCapture(f.term);
    f.setCursor(70, 0);
    cap.noteUserKey();
    f.setLine(0, ' '.repeat(70) + 'git clone '); // trailing space at the wrap point
    f.setLine(1, 'https://x.git', true); // wrapped continuation
    f.setCursor(13, 1);
    expect(cap.getCurrentInput()).toBe('git clone https://x.git');
  });

  it('rejects continuation rows that are NOT wrapped (stale mark)', () => {
    const f = fakeTerm();
    const cap = new HeuristicCapture(f.term);
    f.setCursor(4, 0);
    cap.noteUserKey();
    f.setLine(0, 'PS> ls');
    f.setLine(1, 'PS> ', false); // a hard new prompt line — not a continuation
    f.setCursor(4, 1);
    expect(cap.getCurrentInput()).toBeNull();
  });

  it('returns null when the cursor moved above the mark (screen cleared)', () => {
    const f = fakeTerm();
    const cap = new HeuristicCapture(f.term);
    f.setCursor(10, 5);
    cap.noteUserKey();
    f.setCursor(0, 0); // clear/redraw moved cursor above the mark
    expect(cap.getCurrentInput()).toBeNull();
  });

  it('noteUserKey does not move an existing mark; cancel clears it', () => {
    const f = fakeTerm();
    const cap = new HeuristicCapture(f.term);
    f.setLine(0, 'PS> ');
    f.setCursor(4, 0);
    cap.noteUserKey();
    f.setLine(0, 'PS> abc');
    f.setCursor(7, 0);
    cap.noteUserKey(); // second keystroke must NOT re-mark at col 7
    expect(cap.getCurrentInput()).toBe('abc');
    cap.cancel();
    expect(cap.hasMark()).toBe(false);
    expect(cap.getCurrentInput()).toBeNull();
  });

  it('getCurrentInput(untilCursor) stops at the cursor for live filtering', () => {
    const f = fakeTerm();
    const cap = new HeuristicCapture(f.term);
    f.setLine(0, 'PS> ');
    f.setCursor(4, 0);
    cap.noteUserKey();
    f.setLine(0, 'PS> git status');
    f.setCursor(8, 0); // cursor mid-line: "git |status" (col 8 = after "git ")
    expect(cap.getCurrentInput(true)).toBe('git ');
    // Whole-line read (submit path) still returns everything — Enter runs it all.
    expect(cap.getCurrentInput()).toBe('git status');
  });

  it('getMark/restoreMark round-trips across a capture instance swap', () => {
    const f = fakeTerm();
    const cap1 = new HeuristicCapture(f.term);
    f.setLine(0, 'PS> ');
    f.setCursor(4, 0);
    cap1.noteUserKey();
    const saved = cap1.getMark();
    expect(saved).toEqual({ row: 0, col: 4 });
    const cap2 = new HeuristicCapture(f.term); // fresh instance (remount)
    cap2.restoreMark(saved);
    f.setLine(0, 'PS> git clone https://x');
    f.setCursor(23, 0);
    expect(cap2.getCurrentInput()).toBe('git clone https://x');
  });

  it('charsBeforeCursor counts mark->cursor distance, not line length', () => {
    const f = fakeTerm();
    const cap = new HeuristicCapture(f.term);
    f.setLine(0, 'PS> ');
    f.setCursor(4, 0);
    cap.noteUserKey();
    f.setLine(0, 'PS> dotnet');
    f.setCursor(7, 0); // cursor moved LEFT inside the typed text ("dot|net")
    expect(cap.charsBeforeCursor(80)).toBe(3);
    // wrapped: mark at (0,70), cursor at (1,13) with 80 cols -> 80-70+13 = 23
    const g = fakeTerm();
    const cap2 = new HeuristicCapture(g.term);
    g.setCursor(70, 0);
    cap2.noteUserKey();
    g.setCursor(13, 1);
    expect(cap2.charsBeforeCursor(80)).toBe(23);
    // no mark -> 0
    cap2.cancel();
    expect(cap2.charsBeforeCursor(80)).toBe(0);
  });
});

describe('decideSuggestKey', () => {
  it.each([
    ['passive', 'Escape', false, 'dismiss'],
    ['passive', 'Enter', true, 'accept'], // Shift+Enter quick-accept
    ['passive', 'ArrowDown', false, 'focus'],
    ['passive', 'ArrowUp', false, null], // shell history stays usable
    ['passive', 'Enter', false, null], // plain Enter runs the command
    ['passive', 'a', false, null], // typing passes through
    ['focused', 'ArrowDown', false, 'down'],
    ['focused', 'ArrowUp', false, 'up'],
    ['focused', 'Enter', false, 'accept'],
    ['focused', 'Enter', true, 'accept'],
    ['focused', 'Escape', false, 'dismiss'],
    ['focused', 'a', false, null], // typing returns to passive (host handles)
    ['focused', 'Delete', true, 'delete'], // Shift+Delete removes the selected entry
    ['focused', 'Delete', false, null], // plain Delete still reaches the shell
    ['passive', 'Delete', true, null], // no deletion without an explicit selection
  ] as const)('%s + %s (shift=%s) -> %s', (state, key, shift, expected) => {
    expect(decideSuggestKey(state, key, shift)).toBe(expected);
  });
});
