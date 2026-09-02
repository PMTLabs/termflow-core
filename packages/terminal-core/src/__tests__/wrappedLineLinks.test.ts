import {
  collectWrappedLine,
  wrappedBufferRange,
  findPathLinks,
  findUrlLinks,
} from '../TerminalEngine';

/**
 * Is this code point drawn two cells wide? A deliberately coarse check over the CJK, Hangul,
 * fullwidth and emoji blocks — enough for fixtures, and it exists so a fixture can carry a wide
 * glyph WITHOUT every test spelling out cell widths by hand.
 *
 * Fixtures here must contain one: cell space and string space only disagree in the presence of a
 * wide glyph, so an all-ASCII fixture makes that whole class of defect structurally invisible,
 * and that is exactly how it shipped last time (`suspect-the-shared-fixture-first`).
 */
function isWide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0x1f300 && cp <= 0x1faff);
}

/**
 * One row's text as CELLS, padded out to `cols` with blanks.
 *
 * The padding is what makes the fixture honest: a real xterm buffer line always has `cols`
 * cells, and an untouched one reports `''` — which is precisely what guard G1 reads. A fixture
 * that stopped at the end of the text would answer "is this row full?" with `undefined` and let
 * a G1 test pass for the wrong reason.
 */
function toCells(text: string, cols: number): Array<{ getChars(): string; getWidth(): number }> {
  const out: Array<{ getChars(): string; getWidth(): number }> = [];
  for (const ch of text) {
    const wide = isWide(ch.codePointAt(0) ?? 0);
    out.push({ getChars: () => ch, getWidth: () => (wide ? 2 : 1) });
    if (wide) out.push({ getChars: () => '', getWidth: () => 0 });
  }
  while (out.length < cols) out.push({ getChars: () => '', getWidth: () => 1 });
  return out;
}

// Minimal fake of xterm's IBuffer surface used by collectWrappedLine. Each entry is
// one buffer ROW; `isWrapped: true` means the row continues the previous row's
// logical line (real xterm semantics). `cols` is the grid width the rows are padded to,
// so `getCell(cols - 1)` answers the same question it answers against real xterm.
function fakeBuffer(rows: Array<{ text: string; isWrapped?: boolean }>, cols = 40) {
  return {
    getLine(n: number) {
      const entry = rows[n];
      if (!entry) return undefined;
      const cells = toCells(entry.text, cols);
      return {
        isWrapped: entry.isWrapped ?? false,
        translateToString: (trim?: boolean) =>
          trim ? entry.text.replace(/\s+$/, '') : entry.text,
        getCell: (x: number) => cells[x],
      };
    },
  };
}

describe('collectWrappedLine', () => {
  it('returns the single row unchanged when nothing is wrapped', () => {
    const buf = fakeBuffer([{ text: 'see /usr/lib/foo.so here   ' }]);
    const info = collectWrappedLine(buf, 0, 40)!;
    expect(info.firstRow).toBe(0);
    expect(info.text).toBe('see /usr/lib/foo.so here');
    expect(info.rowStarts).toEqual([0]);
    expect(info.rowIndents).toEqual([0]);
  });

  it('joins a path that wraps onto the next row (queried at the FIRST row)', () => {
    // 40-col terminal: the path breaks mid-way; row 1 is the wrapped continuation.
    const buf = fakeBuffer([
      { text: 'error at D:\\sources\\work\\rephlo\\docs\\pla' }, // 40 cols
      { text: 'n\\312-plan.md:42 more', isWrapped: true },
    ]);
    const info = collectWrappedLine(buf, 0, 40)!;
    expect(info.firstRow).toBe(0);
    expect(info.text).toBe('error at D:\\sources\\work\\rephlo\\docs\\plan\\312-plan.md:42 more');
    expect(info.rowStarts).toEqual([0, 40]);
    // A SOFT wrap inserts nothing, so nothing is ever dropped from it.
    expect(info.rowIndents).toEqual([0, 0]);

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
    const info = collectWrappedLine(buf, 2, 40)!;
    expect(info.firstRow).toBe(1);
    expect(info.text).toBe('open C:\\Users\\me\\projects\\app\\src\\components\\Button.tsx now');
  });

  it('preserves interior trailing spaces on non-final rows (only the last row is trimmed)', () => {
    const buf = fakeBuffer([
      { text: 'a b ' }, // interior row: its trailing space is a REAL char of the line
      { text: 'c d  ', isWrapped: true },
    ]);
    const info = collectWrappedLine(buf, 0, 40)!;
    expect(info.text).toBe('a b c d');
    expect(info.rowStarts).toEqual([0, 4]);
  });

  it('spans three wrapped rows', () => {
    const buf = fakeBuffer([
      { text: '/very/long/' },
      { text: 'deep/path/', isWrapped: true },
      { text: 'file.txt', isWrapped: true },
    ]);
    const info = collectWrappedLine(buf, 1, 40)!;
    expect(info.firstRow).toBe(0);
    expect(info.text).toBe('/very/long/deep/path/file.txt');
    expect(info.rowStarts).toEqual([0, 11, 21]);
  });

  it('does NOT join a following row that is not wrapped', () => {
    const buf = fakeBuffer([
      { text: 'first line /a/b.txt' },
      { text: 'second line /c/d.txt' }, // isWrapped: false — independent line
    ]);
    const info = collectWrappedLine(buf, 0, 40)!;
    expect(info.text).toBe('first line /a/b.txt');
  });

  it('returns null for a missing row', () => {
    const buf = fakeBuffer([]);
    expect(collectWrappedLine(buf, 5, 40)).toBeNull();
  });

  it('bails out (null) when the wrapped line exceeds the row cap', () => {
    const rows: Array<{ text: string; isWrapped?: boolean }> = [{ text: 'x'.repeat(80) }];
    for (let i = 0; i < 200; i++) rows.push({ text: 'y'.repeat(80), isWrapped: true });
    const buf = fakeBuffer(rows, 80);
    expect(collectWrappedLine(buf, 100, 80)).toBeNull();
  });
});

/**
 * HARD wrap — the app emitted a newline and indented the continuation itself, so `isWrapped` is
 * FALSE and real leading whitespace was inserted (plan 027 §3).
 *
 * Every guard below has a case that fails if that ONE guard is deleted from `hardWrapIndent`.
 * That is the point of splitting them: a guard whose test still passes without it is vacuous
 * (`mutation-check-proved-my-guard-vacuous`), and each of these was checked by removing the
 * guard and watching only its own case go red.
 */
describe('collectWrappedLine joins a HARD-wrapped path', () => {
  // The real failing case, at its real width. Row 0 is exactly 100 cells — the wrap happened
  // because the text ran out of columns — and the app indented the remainder by four.
  const COLS = 100;
  const ROW0 = 'wrote C:\\Users\\tamtr\\.claude\\projects\\D--sources-work-rephlo\\memory\\codex-review-budget-is-not-a-con';
  const ROW1 = '    straint.md';
  const FULL = 'C:\\Users\\tamtr\\.claude\\projects\\D--sources-work-rephlo\\memory\\codex-review-budget-is-not-a-constraint.md';
  const hardBuf = () => fakeBuffer([{ text: ROW0 }, { text: ROW1 }], COLS);

  it('has a fixture that really is full-width and really is not soft-wrapped', () => {
    // The premise, asserted rather than assumed: if ROW0 stopped short of the grid the join
    // below would be testing G1's absence, and if row 1 were `isWrapped` it would be testing the
    // soft-wrap path that already worked.
    expect(ROW0).toHaveLength(COLS);
    expect(hardBuf().getLine(1)!.isWrapped).toBe(false);
  });

  it('drops the hanging indent and reports it in rowIndents', () => {
    const info = collectWrappedLine(hardBuf(), 0, COLS)!;
    expect(info.firstRow).toBe(0);
    expect(info.text).toBe('wrote ' + FULL);
    expect(info.rowStarts).toEqual([0, COLS]);
    expect(info.rowIndents).toEqual([0, 4]);
    // No inserted whitespace anywhere in the join — spec §4 item 5.
    expect(info.text).not.toMatch(/\s\s/);
  });

  it('yields the ONE full path from findPathLinks', () => {
    const info = collectWrappedLine(hardBuf(), 0, COLS)!;
    const matches = findPathLinks(info.text);
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe(FULL);
  });

  it('finds the whole path when queried at the CONTINUATION row (backward walk)', () => {
    const info = collectWrappedLine(hardBuf(), 1, COLS)!;
    expect(info.firstRow).toBe(0);
    expect(findPathLinks(info.text)[0].path).toBe(FULL);
  });

  it('joins a bare-relative path, the shape that has no PATH_RE match on row 0 at all', () => {
    /**
     * G3 ("row 0 already holds a match ending at the row end") is EXCLUDED, and this is why:
     * `docs/plan/027-canvas-sea` has no trailing `name.ext`, so `PATH_RE`'s last branch cannot
     * anchor and row 0 alone matches NOTHING. A guard set requiring G3 fixes the absolute forms
     * and leaves this one — the commonest shape in tool output — broken.
     */
    const row0 = 'edited docs/plan/027-canvas-sea';
    expect(findPathLinks(row0)).toHaveLength(0); // the premise, stated as an assertion
    const buf = fakeBuffer([{ text: row0 }, { text: '  rch-and-wrapped-paths.md' }], row0.length);
    const info = collectWrappedLine(buf, 0, row0.length)!;
    expect(findPathLinks(info.text)[0].path).toBe('docs/plan/027-canvas-search-and-wrapped-paths.md');
    expect(info.rowIndents).toEqual([0, 2]);
  });

  it('maps a hard wrap that carries a wide glyph on the first row', () => {
    // 你好 is two characters and FOUR cells, so the row is full at 21 cells while its text is
    // only 19 characters long. Every fixture here has to be able to tell those apart — G1 asks
    // about the CELL at cols-1, and a fixture measured in characters would answer the wrong
    // question by two.
    const row0 = '你好 /srv/app/compone';
    const buf = fakeBuffer([{ text: row0 }, { text: ' nts.tsx' }], 21);
    expect(row0).toHaveLength(19);
    const info = collectWrappedLine(buf, 0, 21)!;
    expect(info.text).toBe('你好 /srv/app/components.tsx');
    expect(info.rowIndents).toEqual([0, 1]);
    expect(findPathLinks(info.text)[0].path).toBe('/srv/app/components.tsx');
  });

  it('parses a :line:col suffix written on the continuation row', () => {
    const buf = fakeBuffer([{ text: 'at /srv/app/util' }, { text: '  s.ts:42:7 ok' }], 16);
    const info = collectWrappedLine(buf, 0, 16)!;
    const [m] = findPathLinks(info.text);
    expect(m.path).toBe('/srv/app/utils.ts');
    expect(m.line).toBe(42);
    expect(m.col).toBe(7);
  });

  it('G1 — refuses a row that is not full (it ended for some other reason)', () => {
    // Same rows, a WIDER grid: row 0 no longer reaches the right edge, so nothing wrapped.
    const buf = fakeBuffer([{ text: ROW0 }, { text: ROW1 }], COLS + 1);
    const info = collectWrappedLine(buf, 0, COLS + 1)!;
    expect(info.text).toBe(ROW0);
  });

  it('G2 — refuses a continuation with no hanging indent', () => {
    const buf = fakeBuffer([{ text: ROW0 }, { text: 'straint.md' }], COLS);
    const info = collectWrappedLine(buf, 0, COLS)!;
    expect(info.text).toBe(ROW0);
  });

  it('G2 — refuses an indented row whose first character cannot start a path', () => {
    // Deliberately path-SHAPED after the quote, so G4 (does the head contain `.`/`/`/`\`?)
    // and G5 (is the head a complete path?) both pass and only the leading-character half of
    // G2 can reject it. A head like `(see` would be rejected by G4 and prove nothing about
    // this guard.
    const buf = fakeBuffer([{ text: ROW0 }, { text: '    "src/a.ts"' }], COLS);
    expect(collectWrappedLine(buf, 0, COLS)!.text).toBe(ROW0);
  });

  it('G4 — refuses prose: two `modified:` rows of git status do not become one path', () => {
    const a = 'Changes not staged for commit: modified: src/a.ts';
    const b = '    modified: docs/b.md';
    const buf = fakeBuffer([{ text: a }, { text: b }], a.length);
    // The head is `modified:` — no `.`, `/` or `\` — so these stay two lines.
    expect(collectWrappedLine(buf, 0, a.length)!.text).toBe(a);
  });

  it('G5 — refuses a ROOTED continuation head (an indented listing, not a wrapped tail)', () => {
    // Only G5 can reject this pair, which is what makes it a real test of G5: row 0 is full, the
    // head is indented and holds a separator (G2/G4 pass), row 0's trailing token ends in neither
    // a separator nor an extension (G6/G7 pass). Deleting G5 stitches the two into
    // `/etc/app/etc/app/main.conf`.
    const a = 'checked config in /etc/app';
    const buf = fakeBuffer([{ text: a }, { text: '    /etc/app/main.conf' }], a.length);
    expect(collectWrappedLine(buf, 0, a.length)!.text).toBe(a);
  });

  it('reconstructs a hard-wrapped URL — the shape the old G5 refused', () => {
    /**
     * This case INVERTED when G5 narrowed from "the head parses as a whole path" to "the head is
     * rooted". Joining it is correct: the URL really was wrapped, so putting it back together is
     * the requirement, not residue. It is offered by right-click but not underlined on hover,
     * because `WebLinksAddon` walks soft wraps only (plan 027 §3.6).
     */
    const a = 'see https://example.com/a/very/lo';
    const buf = fakeBuffer([{ text: a }, { text: '    ng/path/file.html' }], a.length);
    const info = collectWrappedLine(buf, 0, a.length)!;
    expect(info.text).toBe('see https://example.com/a/very/long/path/file.html');
    expect(findUrlLinks(info.text)[0].url).toBe('https://example.com/a/very/long/path/file.html');
  });

  it('G7 — refuses a full row that already ends in a filename, which a join would CORRUPT', () => {
    /**
     * `built with webpack/config.js` fills a 28-column grid exactly by coincidence, and every
     * other guard passes: the next row is indented, its head `v5.91.0` holds a `.` (G4) and is
     * not rooted (G5), and the trailing token ends in neither a separator (G6) nor... an
     * extension, which is precisely what G7 adds. Without G7 the rows stitch to
     * `webpack/config.jsv5.91.0` — so this is not a spurious underline over inert text, it
     * DESTROYS the link row 0 already had.
     */
    const a = 'built with webpack/config.js';
    expect(a).toHaveLength(28);
    const buf = fakeBuffer([{ text: a }, { text: '  v5.91.0 warn' }], a.length);
    const info = collectWrappedLine(buf, 0, a.length)!;
    expect(info.text).toBe(a);
    expect(findPathLinks(info.text)[0].path).toBe('webpack/config.js');
  });

  it('G1 — a row ending in a WIDE glyph at the right edge is full, and joins', () => {
    /**
     * `前` occupies cells 16 and 17 of an 18-column grid, so `getCell(cols - 1)` is its width-0
     * RIGHT HALF, whose `getChars()` is `''` for the opposite reason a blank cell's is. Reading
     * that as "row not full" refused the join for every CJK/emoji path that wraps at the edge.
     */
    const a = 'open /srv/app/名前';
    const cols = 18;
    const last = fakeBuffer([{ text: a }], cols).getLine(0)!.getCell(cols - 1)!;
    expect(last.getWidth()).toBe(0); // the premise, asserted: this really is a continuation cell
    expect(last.getChars()).toBe(''); // ...and it really does look blank
    const buf = fakeBuffer([{ text: a }, { text: '  .txt more' }], cols);
    const info = collectWrappedLine(buf, 0, cols)!;
    expect(info.text).toBe('open /srv/app/名前.txt more');
    expect(findPathLinks(info.text)[0].path).toBe('/srv/app/名前.txt');
  });

  it('G6 — refuses a row that already ends at a separator (an `ls -R` heading)', () => {
    const a = 'total 4  ./src/components/';
    const buf = fakeBuffer([{ text: a }, { text: '    Button.tsx' }], a.length);
    expect(collectWrappedLine(buf, 0, a.length)!.text).toBe(a);
  });

  it('applies the row cap to hard-wrapped rows too', () => {
    // Every row is full, indented and path-shaped, so the join never terminates on its own —
    // only the cap stops it, and it must stop it by returning null rather than by truncating.
    const rows = [{ text: 'y'.repeat(20) }];
    for (let i = 0; i < 200; i++) rows.push({ text: ' abcd.efghijklmnopqr' });
    const buf = fakeBuffer(rows, 20);
    expect(collectWrappedLine(buf, 100, 20)).toBeNull();
  });

  it('joins three rows: a hard wrap after a soft one', () => {
    const buf = fakeBuffer([
      { text: 'run /opt/really/lo' },
      { text: 'ng/dir/name/final-', isWrapped: true }, // soft: nothing dropped
      { text: '  file.txt' },                          // hard: two blanks dropped
    ], 18);
    const info = collectWrappedLine(buf, 2, 18)!;
    expect(info.firstRow).toBe(0);
    expect(info.text).toBe('run /opt/really/long/dir/name/final-file.txt');
    expect(info.rowIndents).toEqual([0, 0, 2]);
    expect(info.rowStarts).toEqual([0, 18, 36]);
  });
});

/**
 * The join must not depend on the terminal's WIDTH — that is the requirement ("a wrapped path
 * resolves"), and sampling one break position is exactly how the opposite shipped: the old G5
 * rejected every head that parsed as a whole path, which for this path is every break outside the
 * final segment's stem, so the join fired at 39 of 103 positions and the one position the suite
 * happened to test was among them.
 *
 * So the whole sweep is the test. Every position must either reconstruct the path or appear in
 * KNOWN_MISSES — a list of INDICES, not a count, so a regression that trades one working position
 * for another still fails. It is asserted in both directions on purpose: widening the miss set is
 * a regression, and narrowing it (a guard genuinely improved) must be accompanied by an update to
 * this list AND to the residue note in `hardWrapIndent`'s docblock, which quotes the same
 * categories.
 */
describe('collectWrappedLine sweeps every wrap position of one real path', () => {
  const PATH =
    'C:\\Users\\tamtr\\.claude\\projects\\D--sources-work-rephlo\\memory\\codex-review-budget-is-not-a-constraint.md';

  /**
   * Break positions (the index of `PATH` the continuation row starts at) where the guards refuse.
   * Grouped by the guard that refuses, matching the docblock's list:
   *  - 1            G2: the head would start `:` — no path starts there.
   *  - 2,8,14,…,61  G5: the break is exactly BEFORE a `\`, so the head is rooted.
   *  - 3,9,15,…,62  G6: exactly AFTER a `\`, so row 0 ends at a separator (the `ls -R` shape).
   *  - 17..21       G7: inside `.claude`, so row 0 ends in what reads as a finished filename.
   *  - 102,103      G4: past the final `.`, so the head holds no `.`/`/`/`\` at all.
   */
  const KNOWN_MISSES = [
    1, 2, 3, 8, 9, 14, 15, 17, 18, 19, 20, 21, 22, 23, 31, 32, 54, 55, 61, 62, 102, 103,
  ];

  it('reconstructs the path at every break position except the documented misses', () => {
    const missed: number[] = [];
    for (let k = 1; k < PATH.length; k++) {
      // Row 0 is exactly `cols` wide by construction — the wrap happened because the text ran out
      // of columns — and the app indented the remainder by four.
      const row0 = 'wrote ' + PATH.slice(0, k);
      const buf = fakeBuffer([{ text: row0 }, { text: '    ' + PATH.slice(k) }], row0.length);
      const info = collectWrappedLine(buf, 0, row0.length)!;
      if (info.text === 'wrote ' + PATH) {
        const matches = findPathLinks(info.text);
        expect(matches).toHaveLength(1);
        expect(matches[0].path).toBe(PATH);
      } else {
        // A refused pair leaves row 0 alone; a PARTIAL join would be a worse failure than none.
        expect(info.text).toBe(row0);
        missed.push(k);
      }
    }
    expect(missed).toEqual(KNOWN_MISSES);
  });

  it('joins a break whose head is itself a complete path — the exact width that stayed broken', () => {
    /**
     * Break 58 makes the head `ory\codex-review-budget-is-not-a-constraint.md`, which `PATH_RE`'s
     * bare-relative branch matches WHOLE. That is what the old G5 tested, and why this terminal
     * width silently produced no link at all while a nearby width produced one.
     */
    const row0 = 'wrote ' + PATH.slice(0, 58);
    const head = PATH.slice(58);
    expect(head).toBe('ory\\codex-review-budget-is-not-a-constraint.md');
    expect(findPathLinks(head)[0]?.path).toBe(head); // the premise: the head IS a complete match
    const buf = fakeBuffer([{ text: row0 }, { text: '    ' + head }], row0.length);
    expect(findPathLinks(collectWrappedLine(buf, 0, row0.length)!.text)[0].path).toBe(PATH);
  });
});

/**
 * A line as CELLS for `wrappedBufferRange`, which now reads the buffer to convert a string index
 * into a column. Same padding rule as `fakeBuffer` above and the same reason for it.
 */
function cellBuffer(rows: string[], cols = 40) {
  return {
    getLine(n: number) {
      const text = rows[n];
      if (text === undefined) return undefined;
      const cells = toCells(text, cols);
      return { getCell: (x: number) => cells[x] };
    },
  };
}

describe('wrappedBufferRange', () => {
  it('maps a single-row match exactly like the old provider did', () => {
    // Old behavior: start.x = start + 1, end.x = end (inclusive last cell), y fixed.
    const text = 'see /usr/lib/foo.so here';
    const info = { firstRow: 7, text, rowStarts: [0], rowIndents: [0] };
    const buf = cellBuffer(Array(7).fill('').concat([text]));
    const [m] = findPathLinks(info.text);
    const range = wrappedBufferRange(info, buf, m.start, m.end);
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
      rowIndents: [0, 0],
    };
    const buf = cellBuffer(
      Array(3).fill('').concat([info.text.slice(0, 40), info.text.slice(40)]),
    );
    const [m] = findPathLinks(info.text);
    expect(m.start).toBe(9);
    expect(m.end).toBe(53); // exclusive
    const range = wrappedBufferRange(info, buf, m.start, m.end);
    expect(range.start).toEqual({ x: 10, y: 4 }); // global 9 → row 0, col 10 (1-based)
    expect(range.end).toEqual({ x: 13, y: 5 }); // global 52 (inclusive) → row 1, col 13
  });

  it('maps a match that lies entirely on a continuation row', () => {
    const info = {
      firstRow: 0,
      text: 'x'.repeat(40) + ' /tmp/a.txt tail',
      rowStarts: [0, 40],
      rowIndents: [0, 0],
    };
    const buf = cellBuffer([info.text.slice(0, 40), info.text.slice(40)]);
    const [m] = findPathLinks(info.text);
    const range = wrappedBufferRange(info, buf, m.start, m.end);
    expect(range.start.y).toBe(2);
    expect(range.end.y).toBe(2);
    expect(range.start.x).toBe(m.start - 40 + 1);
  });

  /**
   * §3.5 — the defect that was living inside this function. `x` is a CELL column; the stitched
   * offset is a STRING index. `你好 ` is two characters and four cells, so the path that starts
   * at string index 3 starts at COLUMN 5, and the old arithmetic underlined (and hit-tested)
   * two cells to the left of where the text is drawn.
   */
  it('reports a CELL column, not a string index, on a row with a wide glyph', () => {
    const text = '你好 /tmp/a.txt';
    const info = { firstRow: 0, text, rowStarts: [0], rowIndents: [0] };
    const buf = cellBuffer([text]);
    const [m] = findPathLinks(text);
    expect(m.start).toBe(3); // string index — the number the old code used as `x - 1`
    const range = wrappedBufferRange(info, buf, m.start, m.end);
    expect(range.start.x).toBe(6); // cell 5, 1-based
    expect(range.end.x).toBe(6 + '/tmp/a.txt'.length - 1);
  });

  /**
   * Direction A of §3.4. The indent is on screen but not in the stitched text, so every column
   * on a hard-wrapped row is `rowIndents[r]` cells to the right of its stitched offset. Without
   * the correction the underline starts inside the whitespace and stops short of the filename.
   */
  it('adds a hard-wrapped row indent back when mapping to a column', () => {
    const rows = ['at /srv/app/util', '  s.ts done'];
    const info = {
      firstRow: 0,
      text: 'at /srv/app/utils.ts done',
      rowStarts: [0, 16],
      rowIndents: [0, 2],
    };
    const buf = cellBuffer(rows, 16);
    const [m] = findPathLinks(info.text);
    const range = wrappedBufferRange(info, buf, m.start, m.end);
    expect(range.start).toEqual({ x: 4, y: 1 });
    // Stitched index 19 is the last `s` of `.ts`: row-local 3, plus the 2 dropped blanks → cell
    // 5, 1-based 6. `s.ts` really is drawn at columns 3-6 of `  s.ts done`.
    expect(range.end).toEqual({ x: 6, y: 2 });
  });

  /**
   * The END must map through the index AFTER the match, not through its last index. The last
   * index of a surrogate pair is the LOW surrogate, and `stringIndexToCell` resolves an index
   * inside a pair to the cell AFTER the pair — so mapping it and adding one lands a cell past the
   * emoji, onto unrelated text that xterm then underlines and accepts a Ctrl+click on.
   */
  it('does not over-extend the END past a trailing surrogate pair', () => {
    const text = 'see /tmp/a/😀';
    const info = { firstRow: 0, text, rowStarts: [0], rowIndents: [0] };
    const buf = cellBuffer([text]);
    const [m] = findPathLinks(text);
    expect(m.path).toBe('/tmp/a/😀');
    const range = wrappedBufferRange(info, buf, m.start, m.end);
    expect(range.start.x).toBe(5);
    // The emoji occupies cells 11-12 (0-based); its last cell 1-based is 13. 14 is the cell after
    // it — a cell of the row that holds no part of the match.
    expect(range.end.x).toBe(13);
  });

  /**
   * The ROW still comes from `endExclusive - 1`, and this pins it: `endExclusive` here is
   * `rowStarts[1]`, so choosing the row from it would put the range's end on row 2 — a range that
   * runs off the end of the match onto the next line.
   */
  it('keeps the END on the row holding the last character when a match ends at a row boundary', () => {
    const info = {
      firstRow: 0,
      text: 'see /tmp/a.txt more',
      rowStarts: [0, 14],
      rowIndents: [0, 0],
    };
    const buf = cellBuffer(['see /tmp/a.txt', ' more'], 14);
    const [m] = findPathLinks(info.text);
    expect(m.end).toBe(14); // exclusive end == rowStarts[1]: the boundary this test is about
    expect(wrappedBufferRange(info, buf, m.start, m.end).end).toEqual({ x: 14, y: 1 });
  });

  it('is unchanged when every indent is zero', () => {
    const rows = ['abc /tmp/a.tx', 't tail'];
    const info = { firstRow: 0, text: 'abc /tmp/a.txt tail', rowStarts: [0, 13], rowIndents: [0, 0] };
    const buf = cellBuffer(rows, 13);
    const [m] = findPathLinks(info.text);
    expect(wrappedBufferRange(info, buf, m.start, m.end)).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 1, y: 2 },
    });
  });
});
