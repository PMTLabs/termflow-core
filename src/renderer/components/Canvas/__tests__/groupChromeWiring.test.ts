/**
 * The parts of the group-chrome fix that only exist as wiring — which scale each element gets,
 * and the CSS without which two of the caps do nothing at all.
 *
 * Source-derived, with comments stripped first: three tests in this plan have been satisfied
 * by their own explanatory prose, and this one polices identifiers that its own doc block
 * names.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

const CANVAS = path.resolve(__dirname, '..');

function code(file: string): string {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FRAME = code(path.join(CANVAS, 'CanvasGroupFrame.tsx'));
const MODE = code(path.join(CANVAS, 'CanvasMode.tsx'));
const CSS = readSource(path.join(CANVAS, 'Canvas.css'));

describe('the label is capped and the chip is not', () => {
  /**
   * The asymmetry is the design, and both halves are load-bearing:
   *
   *  - the LABEL is capped, because it is a world-space element whose unbounded footprint
     *    lands it on the neighbouring group;
   *  - the CHIP is NOT, because at the collapsed tier it is the only thing still legible —
   *    capping it would reintroduce the "too small" half of the same report.
   *
   * Swapping them compiles, renders, and is wrong in both directions at once.
   */
  it('scales the label with labelScale', () => {
    expect(FRAME).toContain('const k = labelScale(zoom, zMax);');
    expect(FRAME).toContain('transform: `scale(${k})`');
  });

  it('scales the chip with the uncapped counterScale', () => {
    expect(FRAME).toContain('transform: `scale(${counterScale(zoom, zMax)})`');
  });

  it('bounds the label\'s width as well as its scale', () => {
    // A scale ceiling cannot bound width — the text length does. Without this a long tab name
    // still reaches the frame beside it.
    expect(FRAME).toContain('maxWidth: labelMaxWidth(w, k)');
  });

  /**
   * The chip's nudge goes on its world POSITION, not into its transform. Folding a translate
   * into `transform` would put it before the `scale`, so the offset would be scaled too — and
   * the layout computed it in screen units on purpose.
   */
  it('applies the chip offset to left/top, not to the transform', () => {
    expect(FRAME).toContain('left: x + (chipOffset?.dx ?? 0)');
    expect(FRAME).toContain('top: y + (chipOffset?.dy ?? 0)');
    expect(FRAME).not.toMatch(/transform: `translate/);
  });

  it('renders without an offset rather than throwing when none was computed', () => {
    // Only collapsed frames get one; a frame rendered before the memo settles must not crash.
    expect(FRAME).toContain('?? 0');
  });
});

describe('CanvasMode feeds them', () => {
  it('passes the zoom to the collapse rule', () => {
    // The rule is now a legibility question, and legibility is a function of the zoom.
    expect(MODE).toContain('allCollapsed(model.nodes, tiers, vp.z)');
  });

  it('computes chip offsets only while collapsed', () => {
    // A chip is the only consumer, and it only exists when collapsed — running the layout the
    // rest of the time would be work per viewport change for nothing.
    expect(MODE).toContain('collapsed ? chipOffsets(model.groups, vp.z) : {}');
  });

  it('recomputes them when the zoom or the groups change', () => {
    const deps = /\[collapsed, model\.groups, vp\.z\]/.exec(MODE);
    expect(deps).not.toBeNull();
  });

  it('hands each frame its own offset', () => {
    expect(MODE).toContain('chipOffset={chipNudge[g.tabId]}');
  });
});

/**
 * Two of the caps are inert without their CSS, and inert in a way that looks correct: the
 * inline `max-width` is applied, the DOM shows it, and `white-space: nowrap` overflows the box
 * regardless. A test that only read the JSX would pass on a label that still spilled.
 */
describe('the CSS the caps depend on', () => {
  const rule = (sel: string) =>
    new RegExp(`(^|\\n)\\${sel}\\s*\\{([^}]*)\\}`).exec(CSS)?.[2] ?? '';

  it('found the rules it is policing', () => {
    expect(rule('.canvas-glabel')).not.toBe('');
    expect(rule('.canvas-gchip')).not.toBe('');
  });

  it('lets the label ellipsise, which is what makes max-width bite', () => {
    const r = rule('.canvas-glabel');
    expect(r).toMatch(/overflow:\s*hidden/);
    expect(r).toMatch(/text-overflow:\s*ellipsis/);
  });

  /** `groupChipLayout` resolves collisions against a FIXED `CHIP_W`. A chip sized by its own
   *  title would have to be measured, and a layout that guesses widths guesses the overlaps. */
  it('gives the chip the fixed width the layout assumes', () => {
    const r = rule('.canvas-gchip');
    expect(r).toMatch(/width:\s*190px/);
    // `box-sizing` is not decoration here: the global default is border-box, but stating it
    // locally is what keeps 190px meaning the same thing as the layout's CHIP_W if that
    // default ever changes. Content-box would make every chip 30px wider than the maths.
    expect(r).toMatch(/box-sizing:\s*border-box/);
  });

  it('keeps the chip width in step with the layout constant', () => {
    // The one number that lives in two files. Read from both and compared, rather than
    // trusted — a chip 190px in CSS and 220 in the layout leaves gaps or overlaps forever.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CHIP_W } = require('../groupChips');
    const declared = /width:\s*(\d+)px/.exec(rule('.canvas-gchip'))?.[1];
    expect(Number(declared)).toBe(CHIP_W);
  });
});
