import { collectWrappedLine, wrappedBufferRange, findPathLinks } from '../TerminalEngine';

// Minimal fake of xterm's IBuffer surface used by collectWrappedLine. Each entry is
// one buffer ROW; `isWrapped: true` means the row continues the previous row's
// logical line (real xterm semantics).
function fakeBuffer(rows: Array<{ text: string; isWrapped?: boolean }>) {
  return {
    getLine(n: number) {
      const entry = rows[n];
      if (!entry) return undefined;
      return {
        isWrapped: entry.isWrapped ?? false,
        translateToString: (trim?: boolean) =>
          trim ? entry.text.replace(/\s+$/, '') : entry.text,
      };
    },
  };
}

describe('collectWrappedLine', () => {
  it('returns the single row unchanged when nothing is wrapped', () => {
    const buf = fakeBuffer([{ text: 'see /usr/lib/foo.so here   ' }]);
    const info = collectWrappedLine(buf, 0)!;
    expect(info.firstRow).toBe(0);
    expect(info.text).toBe('see /usr/lib/foo.so here');
    expect(info.rowStarts).toEqual([0]);
  });

  it('joins a path that wraps onto the next row (queried at the FIRST row)', () => {
    // 40-col terminal: the path breaks mid-way; row 1 is the wrapped continuation.
    const buf = fakeBuffer([
      { text: 'error at D:\\sources\\work\\rephlo\\docs\\pla' }, // 40 cols
      { text: 'n\\312-plan.md:42 more', isWrapped: true },
    ]);
    const info = collectWrappedLine(buf, 0)!;
    expect(info.firstRow).toBe(0);
    expect(info.text).toBe('error at D:\\sources\\work\\rephlo\\docs\\plan\\312-plan.md:42 more');
    expect(info.rowStarts).toEqual([0, 40]);

    const [m] = findPathLinks(info.text);
    expect(m.path).toBe('D:\\sources\\work\\rephlo\\docs\\plan\\312-plan.md');
    expect(m.line).toBe(42);
  });

  it('finds the logical-line start when queried at a CONTINUATION row', () => {
    const buf = fakeBuffer([
      { text: 'unrelated previous line' },
      { text: 'open C:\\Users\\me\\projects\\app\\src\\comp' },
      { text: 'onents\\Button.tsx now', isWrapped: true },
    ]);
    // Query row 2 (the continuation) — must walk back to row 1.
    const info = collectWrappedLine(buf, 2)!;
    expect(info.firstRow).toBe(1);
    expect(info.text).toBe('open C:\\Users\\me\\projects\\app\\src\\components\\Button.tsx now');
  });

  it('preserves interior trailing spaces on non-final rows (only the last row is trimmed)', () => {
    const buf = fakeBuffer([
      { text: 'a b ' }, // interior row: its trailing space is a REAL char of the line
      { text: 'c d  ', isWrapped: true },
    ]);
    const info = collectWrappedLine(buf, 0)!;
    expect(info.text).toBe('a b c d');
    expect(info.rowStarts).toEqual([0, 4]);
  });

  it('spans three wrapped rows', () => {
    const buf = fakeBuffer([
      { text: '/very/long/' },
      { text: 'deep/path/', isWrapped: true },
      { text: 'file.txt', isWrapped: true },
    ]);
    const info = collectWrappedLine(buf, 1)!;
    expect(info.firstRow).toBe(0);
    expect(info.text).toBe('/very/long/deep/path/file.txt');
    expect(info.rowStarts).toEqual([0, 11, 21]);
  });

  it('does NOT join a following row that is not wrapped', () => {
    const buf = fakeBuffer([
      { text: 'first line /a/b.txt' },
      { text: 'second line /c/d.txt' }, // isWrapped: false — independent line
    ]);
    const info = collectWrappedLine(buf, 0)!;
    expect(info.text).toBe('first line /a/b.txt');
  });

  it('returns null for a missing row', () => {
    const buf = fakeBuffer([]);
    expect(collectWrappedLine(buf, 5)).toBeNull();
  });

  it('bails out (null) when the wrapped line exceeds the row cap', () => {
    const rows: Array<{ text: string; isWrapped?: boolean }> = [{ text: 'x'.repeat(80) }];
    for (let i = 0; i < 200; i++) rows.push({ text: 'y'.repeat(80), isWrapped: true });
    const buf = fakeBuffer(rows);
    expect(collectWrappedLine(buf, 100)).toBeNull();
  });
});

describe('wrappedBufferRange', () => {
  it('maps a single-row match exactly like the old provider did', () => {
    // Old behavior: start.x = start + 1, end.x = end (inclusive last cell), y fixed.
    const info = { firstRow: 7, text: 'see /usr/lib/foo.so here', rowStarts: [0] };
    const [m] = findPathLinks(info.text);
    const range = wrappedBufferRange(info, m.start, m.end);
    expect(range).toEqual({
      start: { x: m.start + 1, y: 8 },
      end: { x: m.end, y: 8 },
    });
  });

  it('maps a match spanning two rows to a two-row buffer range', () => {
    // 40-col rows: match starts at global 9 (row 0) and ends on row 1.
    const info = {
      firstRow: 3,
      text: 'error at D:\\sources\\work\\rephlo\\docs\\plan\\312-plan.md more',
      rowStarts: [0, 40],
    };
    const [m] = findPathLinks(info.text);
    expect(m.start).toBe(9);
    expect(m.end).toBe(53); // exclusive
    const range = wrappedBufferRange(info, m.start, m.end);
    expect(range.start).toEqual({ x: 10, y: 4 }); // global 9 → row 0, col 10 (1-based)
    expect(range.end).toEqual({ x: 13, y: 5 }); // global 52 (inclusive) → row 1, col 13
  });

  it('maps a match that lies entirely on a continuation row', () => {
    const info = {
      firstRow: 0,
      text: 'x'.repeat(40) + ' /tmp/a.txt tail',
      rowStarts: [0, 40],
    };
    const [m] = findPathLinks(info.text);
    const range = wrappedBufferRange(info, m.start, m.end);
    expect(range.start.y).toBe(2);
    expect(range.end.y).toBe(2);
    expect(range.start.x).toBe(m.start - 40 + 1);
  });
});
