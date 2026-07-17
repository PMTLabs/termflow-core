/**
 * @jest-environment jsdom
 *
 * A span between two shell prompts becomes an "ended region" only when a
 * non-shell program ran inside it. The mark is pushed in by the renderer's
 * existing detection; a plain `ls` span is never marked and never marked up.
 *
 * jsdom is needed so the mock's decoration elements are real DOM nodes (with a
 * classList) — the tracker tags them and CSS does the geometry.
 */
import { Terminal } from '@xterm/xterm';
import { EndedRegionTracker } from './endedRegions';

type MockTerm = Terminal & {
  decorations: { options: Record<string, unknown>; disposed: boolean; element: HTMLElement }[];
  markers: { line: number; isDisposed: boolean }[];
  __setCursorLine(line: number): void;
  __failDecorations(v: boolean): void;
};

const newTerm = (cols = 80): MockTerm => {
  const t = new Terminal() as MockTerm;
  t.resize(cols, 24);
  return t;
};

/** A tracker holding one closed region of `height` lines, painted. */
function withRegion(cols = 80, height = 5) {
  const term = newTerm(cols);
  const t = new EndedRegionTracker(term);
  t.setColors('#2a2a2a', '#7aa2f7');
  t.onPrompt(); // start marker at line 0
  t.markProgramActive();
  term.__setCursorLine(height);
  t.onPrompt(); // closing marker at `height`
  return { term, t };
}

describe('span bookkeeping', () => {
  it('makes no region for a span with no program (plain ls)', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.onPrompt();
    term.__setCursorLine(3);
    t.onPrompt();
    expect(t.regionCount()).toBe(0);
  });

  it('makes a region for a span a program ran in', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.onPrompt();
    t.markProgramActive();
    term.__setCursorLine(4);
    t.onPrompt();
    expect(t.regionCount()).toBe(1);
  });

  it('needs a CLOSING prompt — a program still running has no region yet', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.onPrompt();
    t.markProgramActive();
    expect(t.regionCount()).toBe(0);
  });

  it('does not carry a mark into the NEXT span', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.onPrompt();
    t.markProgramActive();
    term.__setCursorLine(4);
    t.onPrompt(); // closes region 1
    term.__setCursorLine(8);
    t.onPrompt(); // an unmarked ls span
    expect(t.regionCount()).toBe(1);
  });

  // Observed in the running app: a mount hydrates from the backend's SNAPSHOT (a
  // rendered screen — the backend's parser consumes the OSCs, so they are not in
  // the replay), so the prompt already on screen never reaches our handler. The
  // program launched from it was then detected with NO span open and dropped, and
  // the first prompt we ever saw was the one AFTER Ctrl+C:
  //   markProgramActive {hasOpenSpan: false}
  //   onPrompt {openStart: undefined, closing: 74, height: -1, hadProgram: false}
  // The first span of every mount must therefore be anchored without a prompt.
  it('anchors a span when a program is detected before any prompt was seen', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.setColors('#2a2a2a', '#7aa2f7');
    t.markProgramActive(); // claude detected; no prompt has ever been observed
    term.__setCursorLine(74);
    t.onPrompt(); // the prompt that came back after Ctrl+C
    expect(t.regionCount()).toBe(1);
  });

  it('openSpanHere anchors the first span, and a later prompt closes it', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.setColors('#2a2a2a', '#7aa2f7');
    t.openSpanHere(); // engine calls this once hydration settles
    t.markProgramActive();
    term.__setCursorLine(74);
    t.onPrompt();
    expect(t.regionCount()).toBe(1);
  });

  it('openSpanHere never clobbers a span a real prompt already opened', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.onPrompt(); // real prompt anchors at line 0
    term.__setCursorLine(30);
    t.openSpanHere(); // a late attach must not move the anchor to line 30
    t.markProgramActive();
    term.__setCursorLine(40);
    t.onPrompt();
    // Height is measured from the REAL prompt at 0, not the late anchor at 30.
    expect(t.regionCount()).toBe(1);
    const wash = term.decorations.find(d => d.options.layer === 'bottom');
    expect(wash).toBeUndefined(); // no colours set — but the region is tracked
  });

  it('still ignores a mark with no span when nothing follows it', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.markProgramActive();
    // No closing prompt: the program is still running, so nothing to mark yet.
    expect(t.regionCount()).toBe(0);
  });

  it('tolerates repeated marks in one span', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.onPrompt();
    t.markProgramActive();
    t.markProgramActive();
    term.__setCursorLine(4);
    t.onPrompt();
    expect(t.regionCount()).toBe(1);
  });

  it('makes no region for a zero-height span (prompt with no output)', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.onPrompt();
    t.markProgramActive();
    t.onPrompt(); // cursor never moved
    expect(t.regionCount()).toBe(0);
  });

  it('evicts the oldest region past the cap', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term, { maxRegions: 2 });
    for (let i = 1; i <= 4; i++) {
      t.onPrompt();
      t.markProgramActive();
      term.__setCursorLine(i * 10);
    }
    t.onPrompt();
    expect(t.regionCount()).toBe(2);
  });

  it('disposes everything on dispose()', () => {
    const { t } = withRegion();
    t.dispose();
    expect(t.regionCount()).toBe(0);
  });
});

describe('rendering', () => {
  // The WASH is per-row bottom-layer decorations; the RAIL is a plain <div> in the
  // outer wrapper (integration-level — no DOM in these unit tests, so it is not
  // asserted here; its geometry is verified by the browser spike).
  it('paints one WASH decoration PER ROW — xterm hides a decoration whose anchor is off-screen', () => {
    // A single decoration spanning `height` rows renders ONLY while its anchor is in
    // the viewport (_refreshStyle: marker.line - ydisp, display:none when < 0 or
    // >= rows). Per-row anchors render whichever rows are visible.
    const { term } = withRegion(80, 5);
    expect(term.decorations).toHaveLength(5);
  });

  it('every wash decoration is exactly ONE row tall', () => {
    const { term } = withRegion(80, 5);
    for (const d of term.decorations) expect(d.options.height).toBe(1);
  });

  it('the wash spans the full width and is bottom-layer (behind the text)', () => {
    const { term } = withRegion(120, 3);
    const wash = term.decorations.filter(d => d.options.layer === 'bottom');
    expect(wash).toHaveLength(3);
    for (const d of wash) expect(d.options.width).toBe(120);
    // The rail is NOT a decoration any more — nothing lands on the top layer.
    expect(term.decorations.filter(d => d.options.layer === 'top')).toHaveLength(0);
  });

  it('uses the pre-blended wash colour (xterm allows no alpha)', () => {
    const { term } = withRegion(80, 2);
    expect(term.decorations.find(d => d.options.layer === 'bottom')?.options)
      .toMatchObject({ backgroundColor: '#2a2a2a' });
  });

  it('registers no wash decoration when only the rail colour resolves', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.setColors(undefined, '#7aa2f7');
    t.onPrompt();
    t.markProgramActive();
    term.__setCursorLine(3);
    t.onPrompt();
    // Wash off (no colour); the rail is an HTML <div>, not a decoration.
    expect(term.decorations).toHaveLength(0);
    expect(t.regionCount()).toBe(1);
  });

  it('tracks the region even with no colours, so a later colour can paint it', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.onPrompt();
    t.markProgramActive();
    term.__setCursorLine(3);
    t.onPrompt();
    expect(term.decorations).toHaveLength(0);
    expect(t.regionCount()).toBe(1);
  });

  it('repaints existing regions when the scheme changes the colours', () => {
    const { term, t } = withRegion(80, 2);
    const before = term.decorations.length;
    t.setColors('#efefef', '#0044cc');
    for (let i = 0; i < before; i++) expect(term.decorations[i].disposed).toBe(true);
    const fresh = term.decorations.slice(before);
    expect(fresh.length).toBe(before);
    expect(fresh.find(d => d.options.layer === 'bottom')?.options)
      .toMatchObject({ backgroundColor: '#efefef' });
  });

  it('does not repaint when the colours are unchanged', () => {
    const { term, t } = withRegion(80, 2);
    const n = term.decorations.length;
    t.setColors('#2a2a2a', '#7aa2f7');
    expect(term.decorations).toHaveLength(n);
  });

  it('survives registerDecoration returning undefined (alt buffer / disposed marker)', () => {
    const term = newTerm();
    term.__failDecorations(true);
    const t = new EndedRegionTracker(term);
    t.setColors('#2a2a2a', '#7aa2f7');
    t.onPrompt();
    t.markProgramActive();
    term.__setCursorLine(3);
    expect(() => t.onPrompt()).not.toThrow();
    expect(t.regionCount()).toBe(1); // tracked, just not painted
  });

  it('drops a region whose start/end bracket was trimmed out of scrollback (line -1)', () => {
    const { term, t } = withRegion(80, 3);
    // Scrollback trim disposed the region's brackets (xterm reports line === -1).
    for (const m of term.markers) m.line = -1;
    t.setColors('#333333', '#7aa2f7');
    expect(t.regionCount()).toBe(0);
  });

  it('rebuilds per-row coverage across the CURRENT span on a NARROW (reflow-proof)', () => {
    // The bug this pins: a narrow re-wraps the region so it occupies more rows, but the
    // fixed per-line markers stay put and leave gaps. paint() re-derives the rows from
    // the [start, end) brackets, so coverage is contiguous again.
    const { term, t } = withRegion(120, 3);
    expect(term.decorations.filter(d => !d.disposed && d.options.layer === 'bottom')).toHaveLength(3);
    // Simulate a narrow that grew this region from 3 rows to 6 (end rides down). A real
    // narrow pushes the content below it — and the cursor — down too, so move both.
    term.markers[2].line = 6;  // region.end
    term.__setCursorLine(20);  // cursor well below the grown region
    term.resize(80, 24);
    t.onResize(80);            // a NARROW triggers the rebuild (a widen would drop)
    const liveWash = term.decorations.filter(d => !d.disposed && d.options.layer === 'bottom');
    expect(liveWash).toHaveLength(6); // all 6 rows covered — no gaps
  });

  it('clamps coverage to the cursor even when a bracket points below it (defensive)', () => {
    // Belt-and-suspenders on top of drop-on-widen: paint never lets a region extend
    // past the cursor (the live boundary), so a stray/drifted end can't cover live
    // content on any repaint. Triggered here via setColors, not a resize.
    const { term, t } = withRegion(80, 3); // region [0,3), cursor at row 3
    term.markers[2].line = 9;              // end points below the cursor (row 9)
    t.setColors('#333333', '#7aa2f7');     // a repaint, not a resize
    const liveWash = term.decorations.filter(d => !d.disposed && d.options.layer === 'bottom');
    expect(liveWash).toHaveLength(3);      // clamped to the cursor (row 3), not row 9
  });
});

/**
 * Resize handling is asymmetric because xterm's reflow is. NARROWING is exact —
 * _reflowSmaller fires onInsert so markers adjust — so we rebuild coverage for the
 * new (re-wrapped) row span. A column-WIDEN is not: reflowLarger neither adjusts nor
 * reliably keeps markers (they drift into live content, or are disposed), so any
 * marker-anchored mark would "stretch" over the new prompt. There is no correct
 * re-anchor, so we DROP on widen; the marks reappear on the next command.
 */
describe('reflow', () => {
  it('KEEPS regions when the terminal narrows', () => {
    const { t } = withRegion(120);
    t.onResize(80);
    expect(t.regionCount()).toBe(1);
  });

  it('keeps regions when the width is unchanged', () => {
    const { t } = withRegion(80);
    t.onResize(80);
    expect(t.regionCount()).toBe(1);
  });

  it('DROPS regions on a widen — xterm cannot keep markers, so marks are cleared not drifted', () => {
    const { term, t } = withRegion(80);
    t.onResize(120);
    expect(t.regionCount()).toBe(0);
    for (const d of term.decorations) expect(d.disposed).toBe(true);
  });

  it('repaints the wash to the new width on a NARROW (no un-tinted strip)', () => {
    const { term, t } = withRegion(120, 3);
    term.resize(80, 24); // narrow: xterm updates cols before firing onResize
    t.onResize(80);
    const liveWash = term.decorations.filter(d => !d.disposed && d.options.layer === 'bottom');
    expect(liveWash.length).toBeGreaterThan(0);
    for (const d of liveWash) expect(d.options.width).toBe(80);
  });

  it('does not repaint when only the height (rows) changes — width stays', () => {
    const { term, t } = withRegion(80, 2);
    const before = term.decorations.filter(d => !d.disposed).length;
    t.onResize(80); // same cols
    const after = term.decorations.filter(d => !d.disposed).length;
    expect(after).toBe(before); // nothing disposed/recreated
  });

  it('drops the OPEN span on a widen too — its anchor is equally unreliable', () => {
    const term = newTerm(80);
    const t = new EndedRegionTracker(term);
    t.setColors('#2a2a2a', '#7aa2f7');
    t.onPrompt();
    t.markProgramActive(); // a program is running RIGHT NOW
    t.onResize(120);       // widen — open span dropped
    term.__setCursorLine(9);
    t.onPrompt();          // no open span to close → no region
    expect(t.regionCount()).toBe(0);
  });

  it('starts fresh after a widen clears the old regions', () => {
    const { term, t } = withRegion(80); // region 1
    t.onResize(120);                    // dropped
    expect(t.regionCount()).toBe(0);
    // A brand-new region builds from scratch.
    t.onPrompt();                       // opens a span
    t.markProgramActive();
    term.__setCursorLine(30);           // program produced output
    t.onPrompt();                       // closes it into a region
    expect(t.regionCount()).toBe(1);
  });
});
