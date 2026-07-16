/**
 * A span between two shell prompts becomes an "ended region" only when a
 * non-shell program ran inside it. The mark is pushed in by the renderer's
 * existing detection; a plain `ls` span is never marked and never marked up.
 */
import { Terminal } from '@xterm/xterm';
import { EndedRegionTracker } from './endedRegions';

type MockTerm = Terminal & {
  decorations: { options: Record<string, unknown>; disposed: boolean }[];
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

  it('ignores a mark that arrives before any prompt', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.markProgramActive();
    term.__setCursorLine(4);
    t.onPrompt();
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
  it('paints a wash AND a left rail per region', () => {
    const { term } = withRegion();
    expect(term.decorations).toHaveLength(2);
  });

  it('the wash spans the full width and the region height', () => {
    const { term } = withRegion(120, 9);
    const wash = term.decorations.find(d => d.options.layer === 'bottom');
    expect(wash?.options).toMatchObject({ width: 120, height: 9 });
  });

  it('the rail is a narrow bar pinned to column 0, spanning the region', () => {
    const { term } = withRegion(120, 9);
    const rail = term.decorations.find(d => d.options.layer === 'top');
    expect(rail?.options).toMatchObject({ x: 0, width: 1, height: 9 });
  });

  it('the wash renders BELOW search highlights — overlapping decorations are last-wins', () => {
    const { term } = withRegion();
    expect(term.decorations.some(d => d.options.layer === 'bottom')).toBe(true);
  });

  it('uses the pre-blended colours (xterm allows no alpha)', () => {
    const { term } = withRegion();
    const wash = term.decorations.find(d => d.options.layer === 'bottom');
    const rail = term.decorations.find(d => d.options.layer === 'top');
    expect(wash?.options).toMatchObject({ backgroundColor: '#2a2a2a' });
    expect(rail?.options).toMatchObject({ backgroundColor: '#7aa2f7' });
  });

  it('still paints the rail when no wash colour resolves', () => {
    const term = newTerm();
    const t = new EndedRegionTracker(term);
    t.setColors(undefined, '#7aa2f7');
    t.onPrompt();
    t.markProgramActive();
    term.__setCursorLine(3);
    t.onPrompt();
    expect(term.decorations).toHaveLength(1);
    expect(term.decorations[0].options).toMatchObject({ layer: 'top', x: 0 });
  });

  it('tracks the region even with no colours at all, so a later colour can paint it', () => {
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
    const { term, t } = withRegion();
    t.setColors('#efefef', '#0044cc');
    expect(term.decorations[0].disposed).toBe(true);
    expect(term.decorations[1].disposed).toBe(true);
    expect(term.decorations[2].options).toMatchObject({ backgroundColor: '#efefef' });
    expect(term.decorations[3].options).toMatchObject({ backgroundColor: '#0044cc' });
  });

  it('does not repaint when the colours are unchanged', () => {
    const { term, t } = withRegion();
    t.setColors('#2a2a2a', '#7aa2f7');
    expect(term.decorations).toHaveLength(2);
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

  it('drops a region whose anchor was trimmed out of scrollback (line -1)', () => {
    const { term, t } = withRegion();
    (term.decorations[0].options.marker as { line: number }).line = -1;
    t.setColors('#333333', '#7aa2f7');
    expect(t.regionCount()).toBe(0);
  });
});

/**
 * Narrowing maintains markers (xterm fires onInsert), so the marks follow and we
 * keep them. Widening SILENTLY corrupts them — no event, no onDispose, the line
 * never adjusted — so they would drift onto the wrong rows with no signal.
 * Losing the marks is correct; lying about them is not.
 */
describe('reflow', () => {
  it('KEEPS regions when the terminal narrows — markers are maintained', () => {
    const { t } = withRegion(120);
    t.onResize(80);
    expect(t.regionCount()).toBe(1);
  });

  it('keeps regions when the width is unchanged', () => {
    const { t } = withRegion(80);
    t.onResize(80);
    expect(t.regionCount()).toBe(1);
  });

  it('DROPS every region when the terminal widens — markers silently corrupt', () => {
    const { t } = withRegion(80);
    t.onResize(120);
    expect(t.regionCount()).toBe(0);
  });

  it('disposes both decorations on widen, not just the bookkeeping', () => {
    const { term, t } = withRegion(80);
    t.onResize(120);
    expect(term.decorations[0].disposed).toBe(true);
    expect(term.decorations[1].disposed).toBe(true);
  });

  it('abandons the OPEN span on widen too — its anchor is corrupt as well', () => {
    const term = newTerm(80);
    const t = new EndedRegionTracker(term);
    t.setColors('#2a2a2a', '#7aa2f7');
    t.onPrompt();
    t.markProgramActive(); // a program is running RIGHT NOW
    t.onResize(120);       // its anchor is now wrong
    term.__setCursorLine(9);
    t.onPrompt();          // must NOT create a drifted region
    expect(t.regionCount()).toBe(0);
  });

  it('tracks new regions normally after a widen', () => {
    const { term, t } = withRegion(80);
    t.onResize(120);
    t.onPrompt();
    t.markProgramActive();
    term.__setCursorLine(20);
    t.onPrompt();
    expect(t.regionCount()).toBe(1);
  });
});
