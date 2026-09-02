import {
  linkAtIndex, pointToCell, cellToStringIndex, stringIndexToCell, collectWrappedLine,
  findPathLinks, RenderedTerminalBox, CellAddressableLine,
} from '../TerminalEngine';

/**
 * Hit-testing the link under a right-click — the two decisions behind `getLinkAt`
 * (Tam, 2026-08-21).
 *
 * `getLinkAt` itself is glue over these two pure functions plus `collectWrappedLine`, which is
 * already covered by `wrappedLineLinks.test.ts`. Splitting them out is what makes the geometry
 * testable at all: the alternative is a mounted xterm with a faked `_core._renderService`, which
 * would test the mock's arithmetic rather than ours.
 */

describe('linkAtIndex picks the link covering a character', () => {
  //            0         1         2         3
  //            0123456789012345678901234567890123456789
  const LINE = 'open https://ex.test/a here and ./x/y.txt';
  const urlStart = LINE.indexOf('https');
  const urlEnd = urlStart + 'https://ex.test/a'.length;
  const pathStart = LINE.indexOf('./x/y.txt');

  it('finds the url when the index is inside it', () => {
    expect(linkAtIndex(LINE, urlStart)).toEqual({ kind: 'url', text: 'https://ex.test/a' });
    expect(linkAtIndex(LINE, urlStart + 5)).toEqual({ kind: 'url', text: 'https://ex.test/a' });
  });

  /**
   * The boundary, both sides. `end` is EXCLUSIVE, so the last character of the link must hit and
   * the one after it must not — an off-by-one here is a Copy Link that appears on the space
   * beside a link, or refuses on its final character.
   */
  it('covers the last character and not the one after it', () => {
    expect(linkAtIndex(LINE, urlEnd - 1)).not.toBeNull();
    expect(linkAtIndex(LINE, urlEnd)).toBeNull();
  });

  it('finds nothing in the gap between two links', () => {
    expect(linkAtIndex(LINE, LINE.indexOf(' here') + 2)).toBeNull();
  });

  it('finds the path when the index is inside that instead', () => {
    expect(linkAtIndex(LINE, pathStart + 2)).toEqual({ kind: 'path', text: './x/y.txt' });
  });

  it('finds nothing at all in ordinary output', () => {
    expect(linkAtIndex('$ git status', 4)).toBeNull();
  });

  /**
   * The ordering rule, stated as a test rather than left to the order of two loops. A URL's tail
   * is also a valid path match, so paths-first would put a fragment like `ex.test/a` on the
   * clipboard for a right-click on a link.
   */
  it('prefers the url when both matchers claim the character', () => {
    const text = 'fetch https://example.com/a/b.txt done';
    const hit = linkAtIndex(text, text.indexOf('b.txt'));
    expect(hit).toEqual({ kind: 'url', text: 'https://example.com/a/b.txt' });
  });

  it('is out of range safely', () => {
    expect(linkAtIndex(LINE, -1)).toBeNull();
    expect(linkAtIndex(LINE, 9999)).toBeNull();
  });
});

describe('pointToCell maps a viewport point onto the grid', () => {
  /** A pane at the origin, drawn at CSS scale 1 — 8x17 cells, 80x24. */
  const pane = (over: Partial<RenderedTerminalBox> = {}): RenderedTerminalBox => ({
    rect: { left: 0, top: 0, width: 640, height: 408 },
    offsetWidth: 640,
    offsetHeight: 408,
    cell: { width: 8, height: 17 },
    cols: 80,
    rows: 24,
    ...over,
  });

  it('finds the cell under a point', () => {
    expect(pointToCell(0, 0, pane())).toEqual({ col: 0, row: 0 });
    expect(pointToCell(83, 40, pane())).toEqual({ col: 10, row: 2 });
  });

  it('accounts for an element that is not at the viewport origin', () => {
    const box = pane({ rect: { left: 100, top: 50, width: 640, height: 408 } });
    expect(pointToCell(100, 50, box)).toEqual({ col: 0, row: 0 });
    expect(pointToCell(183, 90, box)).toEqual({ col: 10, row: 2 });
  });

  /**
   * THE case this function exists for. On the canvas overlay `.canvas-surface` carries a
   * `scale()`, so `getBoundingClientRect()` is in post-transform pixels while `cell` is in
   * untransformed CSS pixels. A naive `(x - left) / cell.width` is then wrong BY THE SCALE — at
   * 2x it reports column 20 for the click that landed on column 10, and Copy Link quietly
   * offers a different link from the one under the cursor.
   */
  it('reconciles a CSS transform scale', () => {
    const scaled = pane({ rect: { left: 0, top: 0, width: 1280, height: 816 } }); // 2x
    // The click that lands on cell (10, 2) is at twice the unscaled offset.
    expect(pointToCell(166, 80, scaled)).toEqual({ col: 10, row: 2 });
    // ...and the UNSCALED coordinate now lands on a different cell, which is what makes the
    // assertion above meaningful rather than a coincidence.
    expect(pointToCell(83, 40, scaled)).toEqual({ col: 5, row: 1 });
  });

  it('is exactly a no-op at scale 1', () => {
    expect(pointToCell(83, 40, pane())).toEqual(pointToCell(83, 40, pane({ offsetWidth: 640 })));
  });

  it('refuses a point outside the grid', () => {
    expect(pointToCell(-1, 10, pane())).toBeNull();
    expect(pointToCell(10, -1, pane())).toBeNull();
    // One cell past the last column / row.
    expect(pointToCell(80 * 8, 10, pane())).toBeNull();
    expect(pointToCell(10, 24 * 17, pane())).toBeNull();
  });

  /**
   * An unmeasured terminal. xterm's render service has no dimensions before its first paint, and
   * a zero cell size would divide to Infinity and index a cell that is not there.
   */
  it('refuses a terminal that has not been measured', () => {
    expect(pointToCell(10, 10, pane({ cell: { width: 0, height: 17 } }))).toBeNull();
    expect(pointToCell(10, 10, pane({ cell: { width: 8, height: 0 } }))).toBeNull();
  });

  /**
   * A hidden element measures 0x0 in BOTH — `offsetWidth` and `rect.width` — so the ratio is
   * 0/0 = NaN, and every comparison with NaN is false. Without the explicit `> 0` guards the
   * bounds check passes and `Math.floor(NaN)` indexes cell NaN.
   */
  it('refuses an element with no measurable box', () => {
    const hidden = pane({
      rect: { left: 0, top: 0, width: 0, height: 0 }, offsetWidth: 0, offsetHeight: 0,
    });
    expect(pointToCell(10, 10, hidden)).toBeNull();
  });
});

/**
 * A CELL column is not a STRING index once the row holds a double-width glyph.
 *
 * CJK, most emoji and many box-drawing characters occupy two cells and contribute one index to
 * `translateToString()`; a surrogate-pair emoji occupies two cells and contributes two. So on any
 * line containing one, the two spaces drift apart and every hit-test to the right of it is wrong
 * — in BOTH directions. On `你好 https://a.test` the URL starts at cell 5 and string index 3:
 * adding the raw column reads three characters into the link when you click its first character,
 * and reads INSIDE the link when you click 好.
 */
describe('cellToStringIndex bridges cells and characters', () => {
  /**
   * A line as cells. `w` is the cell width — 2 for the left half of a wide glyph, 0 for its right
   * half, 1 for everything else — mirroring what xterm reports.
   */
  const cells = (spec: Array<[string, number]>): CellAddressableLine => ({
    getCell: (x) => {
      const c = spec[x];
      return c ? { getChars: () => c[0], getWidth: () => c[1] } : undefined;
    },
  });

  /** `你好 https://a.test` — the exact line from the note above. */
  const CJK = cells([
    ['你', 2], ['', 0], ['好', 2], ['', 0], [' ', 1],
    ...'https://a.test'.split('').map((ch) => [ch, 1] as [string, number]),
  ]);
  const CJK_TEXT = '你好 https://a.test';

  it('maps a plain ASCII row one to one', () => {
    const ascii = cells('abc'.split('').map((c) => [c, 1] as [string, number]));
    expect([0, 1, 2].map((c) => cellToStringIndex(ascii, c))).toEqual([0, 1, 2]);
  });

  it('counts a wide glyph as ONE character across its TWO cells', () => {
    // 你 occupies cells 0-1, 好 occupies cells 2-3, the space is cell 4.
    expect(cellToStringIndex(CJK, 0)).toBe(0);       // 你
    expect(cellToStringIndex(CJK, 2)).toBe(1);       // 好
    expect(cellToStringIndex(CJK, 4)).toBe(2);       // the space
    expect(cellToStringIndex(CJK, 5)).toBe(3);       // 'h' — the URL's first character
  });

  /** Either half of a wide glyph means that glyph, so a click on its right half is not the next
   *  character along. Without this, clicking 好 lands inside the URL beside it. */
  it('resolves the right half of a wide glyph to the glyph itself', () => {
    expect(cellToStringIndex(CJK, 3)).toBe(cellToStringIndex(CJK, 2));
    expect(cellToStringIndex(CJK, 1)).toBe(cellToStringIndex(CJK, 0));
  });

  /** The whole point, end to end: the two failure directions the raw column produced. */
  it('stops a click on CJK from reporting the URL beside it', () => {
    // The DEFECT, restated so this test cannot pass for the wrong reason: the raw column DID hit.
    expect(linkAtIndex(CJK_TEXT, 3)).not.toBeNull();
    // ...and with the mapping, cell 3 is 好, which is not a link.
    expect(linkAtIndex(CJK_TEXT, cellToStringIndex(CJK, 3))).toBeNull();
  });

  it('and puts the URL\'s first character genuinely inside the URL', () => {
    const hit = linkAtIndex(CJK_TEXT, cellToStringIndex(CJK, 5));
    expect(hit).toEqual({ kind: 'url', text: 'https://a.test' });
    // The last cell of the line is the URL's last character, and must still hit.
    expect(linkAtIndex(CJK_TEXT, cellToStringIndex(CJK, 4 + 'https://a.test'.length)))
      .toEqual({ kind: 'url', text: 'https://a.test' });
  });

  /**
   * A surrogate-pair emoji is TWO cells and TWO string indices, unlike CJK's two-and-one — so a
   * mapping that simply halved wide glyphs would be wrong here in the other direction.
   */
  it('counts a surrogate-pair emoji as its real character length', () => {
    const emoji = cells([['👍', 2], ['', 0], ['x', 1]]);
    expect('👍'.length).toBe(2);                 // the premise
    expect(cellToStringIndex(emoji, 0)).toBe(0);
    expect(cellToStringIndex(emoji, 2)).toBe(2); // 'x' sits after both code units
  });

  /**
   * A blank cell reports `''` but `translateToString` writes a space for it, so it must still
   * advance the string by one. Without the `|| 1`, every link after a run of blanks shifts left
   * by the number of blanks — which is most of a padded terminal line.
   */
  it('advances a blank cell by the space it renders as', () => {
    const padded = cells([['', 1], ['', 1], ['a', 1]]);
    expect(cellToStringIndex(padded, 2)).toBe(2);
  });

  it('is safe past the end of the line', () => {
    const short = cells([['a', 1]]);
    expect(cellToStringIndex(short, 99)).toBe(1);
    expect(cellToStringIndex(short, 0)).toBe(0);
  });

  /**
   * `getLinkAt` must actually USE the mapping — every case above holds against a `getLinkAt`
   * that still adds the raw column, because they exercise `cellToStringIndex` directly.
   *
   * Source-derived because composing it for real needs a mounted xterm with a render service,
   * which this package's jest config deliberately mocks away. Comments stripped first, or the
   * docblock explaining the rule would satisfy the regex describing it.
   */
  it('is the index getLinkAt actually hit-tests with', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const src: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../TerminalEngine.ts'), 'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    const body = /getLinkAt\(clientX: number, clientY: number\)[\s\S]*?\n  \}/.exec(src);
    expect(body).not.toBeNull();
    // The column reaches the stitched line through `cellToStringIndex` and nothing else.
    expect(body![0]).toMatch(/const inRow = cellToStringIndex\(line, at\.col\);/);
    expect(body![0])
      .toMatch(/linkAtIndex\(\s*info\.text,\s*rowStart \+ \(inRow - rowIndent\)\s*\)/);
    // ...and NOT the raw column, which is the defect this whole block exists for.
    expect(body![0]).not.toMatch(/rowStart \+ at\.col/);
    /**
     * Updated for plan 027 §3.4 direction B, deliberately and not to make a red test green: the
     * hit-test now also SUBTRACTS the hard-wrapped row's dropped indent, and refuses outright
     * when the pointer is inside it. Both halves are pinned, because dropping either one is
     * silent — the first shifts every hit on a joined row by the indent width, the second offers
     * "Copy Path" over blank cells.
     */
    expect(body![0]).toMatch(/const rowIndent = info\.rowIndents\[r\];/);
    expect(body![0]).toMatch(/if \(inRow < rowIndent\) return null;/);
    // And the stitch is asked for the grid width, or it can only ever see a soft wrap.
    expect(body![0]).toMatch(/collectWrappedLine\(buf, bufferRow, term\.cols\)/);
  });
});

/**
 * The inverse walk, `stringIndexToCell` — used by `wrappedBufferRange` to turn a stitched string
 * offset back into the CELL column xterm draws a link range in.
 *
 * Round-tripping is the property that matters and the one a hand-written table would miss: for
 * every cell that STARTS a character, `stringIndexToCell(cellToStringIndex(c)) === c`. Asserting
 * it over ASCII, CJK, a surrogate-pair emoji and a blank in ONE loop is what makes it a property
 * rather than four samples.
 */
describe('stringIndexToCell inverts cellToStringIndex', () => {
  const cells = (spec: Array<[string, number]>): CellAddressableLine => ({
    getCell: (x) => {
      const c = spec[x];
      return c ? { getChars: () => c[0], getWidth: () => c[1] } : undefined;
    },
  });

  /** `a你 👍b` — one of each: ASCII, CJK (2 cells / 1 char), a blank-width space, and a
   *  surrogate-pair emoji (2 cells / 2 chars). Every one of those ratios is different, which is
   *  the whole point of the fixture. */
  const MIXED: Array<[string, number]> = [
    ['a', 1], ['你', 2], ['', 0], [' ', 1], ['👍', 2], ['', 0], ['b', 1],
  ];
  const line = cells(MIXED);
  /** The columns that START a character — the right half of a wide glyph is not one. */
  const STARTS = [0, 1, 3, 4, 6];

  it('round-trips every cell that starts a character', () => {
    for (const col of STARTS) {
      expect(stringIndexToCell(line, cellToStringIndex(line, col))).toBe(col);
    }
  });

  it('maps the string indices of that line to the columns they are drawn at', () => {
    // 'a' idx 0 → cell 0; 你 idx 1 → cell 1; ' ' idx 2 → cell 3; 👍 idx 3 → cell 4;
    // 'b' idx 5 → cell 6 (the emoji contributed TWO indices across its two cells).
    expect([0, 1, 2, 3, 5].map((i) => stringIndexToCell(line, i))).toEqual([0, 1, 3, 4, 6]);
  });

  /** An index INSIDE a surrogate pair is at no cell boundary at all. The cell after the pair is
   *  the only answer that is a real boundary, and it must not be the pair's own right half. */
  it('resolves an index inside a surrogate pair to the cell after it', () => {
    expect(stringIndexToCell(line, 4)).toBe(6);
  });

  /** A blank cell renders as a space and so advances the string by one — the `|| 1` on both
   *  sides of the walk. Without it every column after a run of blanks drifts left. */
  it('counts blank cells as the space they render as', () => {
    const padded = cells([['', 1], ['', 1], ['a', 1]]);
    expect(stringIndexToCell(padded, 2)).toBe(2);
    expect(stringIndexToCell(padded, cellToStringIndex(padded, 2))).toBe(2);
  });

  /** Past the end there are no cells left to walk; falling back to one cell per remaining
   *  character is what `translateToString` would have produced for the trailing blanks. */
  it('is safe past the end of the line', () => {
    const short = cells([['a', 1]]);
    expect(stringIndexToCell(short, 0)).toBe(0);
    expect(stringIndexToCell(short, 5)).toBe(5);
  });
});

/**
 * The two joined the way `getLinkAt` joins them, over a WRAPPED line — the case where the naive
 * composition is wrong.
 *
 * A link that soft-wraps continues on the next buffer row. The stitched logical line is one
 * string, so the index of a click on the SECOND row is that row's start plus the column. Using
 * the column alone hit-tests the first row for every row, so a right-click on the tail of a long
 * URL finds whatever happens to sit at that column of the line's beginning.
 */
/**
 * A buffer row as CELLS. Wide glyphs occupy two cells and the row is padded to `cols` with
 * blanks, exactly as a real xterm line is — `collectWrappedLine` asks `getCell(cols - 1)` whether
 * the row is full, and a fixture that stopped at the end of its text would answer `undefined`.
 */
const rowCells = (text: string, cols: number) => {
  const out: Array<{ getChars(): string; getWidth(): number }> = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide = (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0x1f300 && cp <= 0x1faff);
    out.push({ getChars: () => ch, getWidth: () => (wide ? 2 : 1) });
    if (wide) out.push({ getChars: () => '', getWidth: () => 0 });
  }
  while (out.length < cols) out.push({ getChars: () => '', getWidth: () => 1 });
  return out;
};

const wrapBuffer = (rows: Array<{ text: string; isWrapped?: boolean }>, cols: number) => ({
  getLine(n: number) {
    const entry = rows[n];
    if (!entry) return undefined;
    const cells = rowCells(entry.text, cols);
    return {
      isWrapped: entry.isWrapped ?? false,
      translateToString: (trim?: boolean) => (trim ? entry.text.replace(/\s+$/, '') : entry.text),
      getCell: (x: number) => cells[x],
    };
  },
});

/** `getLinkAt`'s composition, exactly — see the source-derived test above that pins it. */
const hitLink = (
  buf: ReturnType<typeof wrapBuffer>, row: number, col: number, cols: number,
) => {
  const info = collectWrappedLine(buf, row, cols)!;
  const r = row - info.firstRow;
  const rowStart = info.rowStarts[r];
  const rowIndent = info.rowIndents[r];
  const inRow = cellToStringIndex(buf.getLine(row)!, col);
  if (inRow < rowIndent) return null;
  return linkAtIndex(info.text, rowStart + (inRow - rowIndent));
};

describe('a wrapped link is hit on every row it occupies', () => {
  // A 20-column terminal; the URL breaks across two rows.
  const buf = wrapBuffer([
    { text: 'see https://ex.test/' },
    { text: 'a/very/long/path.txt', isWrapped: true },
  ], 20);

  const hitAt = (row: number, col: number) => hitLink(buf, row, col, 20);

  const WHOLE = 'https://ex.test/a/very/long/path.txt';

  it('hits the whole url from its first row', () => {
    expect(hitAt(0, 6)).toEqual({ kind: 'url', text: WHOLE });
  });

  it('hits the SAME url from its continuation row', () => {
    expect(hitAt(1, 5)).toEqual({ kind: 'url', text: WHOLE });
  });

  /**
   * The guard on the guard, and the reason the row offset is not optional: column 5 of the FIRST
   * row is inside the word `see `/`http`, so a broken composition would return a hit here too —
   * just the wrong one. These two must be the same object, not merely both non-null.
   */
  it('and the row offset is what makes those the same link', () => {
    expect(hitAt(1, 5)).toEqual(hitAt(0, 6));
    // Column 1 of row 0 is in the word "see" — genuinely not a link — so the stitched index
    // really is being used rather than the whole line being treated as one match.
    expect(hitAt(0, 1)).toBeNull();
  });
});

/**
 * The same composition over a HARD wrap (plan 027 §3) — the app's own newline plus a hanging
 * indent, where `isWrapped` is FALSE and real whitespace was inserted.
 *
 * The fixture carries CJK on the first row on purpose. Cell space and string space agree on an
 * all-ASCII row, so an ASCII fixture would pass against a `getLinkAt` that still added the raw
 * column AND against one that forgot to subtract the indent — it can only fail for the right
 * reason if the two spaces actually differ (`suspect-the-shared-fixture-first`).
 */
describe('a HARD-wrapped path is hit from both of its rows', () => {
  const COLS = 21; // 你(2) + 好(2) + ' '(1) + 16 = 21 cells, from 19 characters
  const buf = wrapBuffer([
    { text: '你好 /srv/app/compone' },
    { text: ' nts.tsx:42:7 ok' },
  ], COLS);
  const hitAt = (row: number, col: number) => hitLink(buf, row, col, COLS);
  const PATH = '/srv/app/components.tsx';

  it('hits the joined path from the FIRST row, at the column it is drawn at', () => {
    // The `/` is string index 3 but CELL 5, because 你好 is two characters over four cells.
    expect(hitAt(0, 5)).toEqual({ kind: 'path', text: PATH });
  });

  it('hits the SAME path from the continuation row', () => {
    expect(hitAt(1, 1)).toEqual({ kind: 'path', text: PATH });
    expect(hitAt(1, 1)).toEqual(hitAt(0, 5));
  });

  /**
   * Inside the dropped indent there is nothing to hit. Those cells are blank, xterm draws no
   * glyph on them, and clamping to the first real character would offer "Copy Path" for a
   * right-click on whitespace.
   */
  it('returns null for a pointer inside the dropped indent', () => {
    expect(hitAt(1, 0)).toBeNull();
  });

  /** And the wide glyph itself is not a link — the guard that says the cell→string mapping is
   *  really being applied rather than the raw column happening to land inside the path. */
  it('does not report the path for a click on the CJK ahead of it', () => {
    expect(hitAt(0, 0)).toBeNull();
    expect(hitAt(0, 2)).toBeNull();
  });

  it('parses the :line:col suffix written on the continuation row', () => {
    const info = collectWrappedLine(buf, 0, COLS)!;
    const [m] = findPathLinks(info.text);
    expect(m.path).toBe(PATH);
    expect(m.line).toBe(42);
    expect(m.col).toBe(7);
  });
});
