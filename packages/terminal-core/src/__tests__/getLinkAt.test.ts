import {
  linkAtIndex, pointToCell, collectWrappedLine, RenderedTerminalBox,
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
 * The two joined the way `getLinkAt` joins them, over a WRAPPED line — the case where the naive
 * composition is wrong.
 *
 * A link that soft-wraps continues on the next buffer row. The stitched logical line is one
 * string, so the index of a click on the SECOND row is that row's start plus the column. Using
 * the column alone hit-tests the first row for every row, so a right-click on the tail of a long
 * URL finds whatever happens to sit at that column of the line's beginning.
 */
describe('a wrapped link is hit on every row it occupies', () => {
  const fakeBuffer = (rows: Array<{ text: string; isWrapped?: boolean }>) => ({
    getLine(n: number) {
      const entry = rows[n];
      if (!entry) return undefined;
      return {
        isWrapped: entry.isWrapped ?? false,
        translateToString: (trim?: boolean) => (trim ? entry.text.replace(/\s+$/, '') : entry.text),
      };
    },
  });

  // A 20-column terminal; the URL breaks across two rows.
  const buf = fakeBuffer([
    { text: 'see https://ex.test/' },
    { text: 'a/very/long/path.txt', isWrapped: true },
  ]);

  const hitAt = (row: number, col: number) => {
    const info = collectWrappedLine(buf, row)!;
    const rowStart = info.rowStarts[row - info.firstRow];
    return linkAtIndex(info.text, rowStart + col);
  };

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
