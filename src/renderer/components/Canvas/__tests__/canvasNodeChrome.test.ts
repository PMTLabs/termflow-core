import fs from 'fs';
import path from 'path';

/**
 * Node chrome holds a constant on-screen size once the zoom passes 1.
 *
 * A canvas node lives inside `.canvas-world`, which is `transform: scale(z)`. Everything on it
 * is multiplied by that — including the parts that are not content. At the working zoom
 * (~4.2) a 1px border draws at 4.2px, the 2px focus ring at 8.5px, and the 13px connector
 * ports at 55px across. The terminal is meant to grow; its picture frame is not.
 *
 * The fix is one custom property, `--node-k` (= `headScale(zoom)`), and the point of testing
 * it here rather than in a unit test is that **the failure is additive**: the next chrome rule
 * someone writes will use a bare `px` unless something says otherwise, and it will look fine
 * at zoom 1 — which is where anyone would check it. So the check runs against the RULES, not
 * against a list of the four that exist today.
 *
 * Deliberately scoped OUT: anything inside `.canvas-node-head-inner`. That element is already
 * counter-scaled as a whole (see `CanvasNode`), so its children must use natural sizes —
 * applying `--node-k` there would scale them twice.
 */

const CSS = fs.readFileSync(
  path.resolve(__dirname, '../Canvas.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule { selector: string; body: string }

function rules(): Rule[] {
  const out: Rule[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = m[1].trim();
    if (head.startsWith('@') || head.startsWith('from') || head.startsWith('to')) continue;
    for (const one of head.split(',')) out.push({ selector: one.trim(), body: m[2] });
  }
  return out;
}

function ruleFor(selector: string): string {
  const found = rules().find((r) => r.selector === selector);
  if (!found) throw new Error(`no rule for ${selector} — its subject moved or was renamed`);
  return found.body;
}

/** Lengths that draw chrome. Excludes `0px`, which has no size to scale. */
const BARE_PX = /(?<![\w-])(\d*\.?\d+)px/g;

function unscaledLengths(body: string): string[] {
  // Everything already routed through a counter-scaled custom property is fine, whether that
  // is `--node-k` directly or `--port-size`, which is itself defined from it.
  const stripped = body
    .replace(/calc\([^()]*var\(--node-k[^)]*\)[^)]*\)/g, '')
    .replace(/var\(--port-size[^)]*\)/g, '')
    .replace(/calc\([^()]*var\(--port-size[^)]*\)[^)]*\)/g, '');
  return [...stripped.matchAll(BARE_PX)].map((m) => m[0]).filter((v) => parseFloat(v) !== 0);
}

describe('node chrome is counter-scaled', () => {
  // The chrome that sits OUTSIDE the header's own counter-scale wrapper. Listed because each
  // is a distinct visual failure, then checked structurally below so the list cannot go stale
  // without the sweep test noticing.
  const CHROME = ['.canvas-node', '.canvas-node.selected', '.canvas-node.focused', '.canvas-port'];

  it.each(CHROME)('%s uses no unscaled pixel length', (selector) => {
    expect(unscaledLengths(ruleFor(selector))).toEqual([]);
  });

  // Mutation check. Without it, a typo in BARE_PX or an over-eager strip would leave a suite
  // that inspects four real rules, finds nothing, and passes whatever they say.
  it('would actually catch a bare pixel length', () => {
    expect(unscaledLengths('border: 1px solid red;')).toEqual(['1px']);
    expect(unscaledLengths('width: 13px; height: 13px;')).toEqual(['13px', '13px']);
    expect(unscaledLengths('border: calc(1px * var(--node-k, 1)) solid red;')).toEqual([]);
    expect(unscaledLengths('width: var(--port-size);')).toEqual([]);
    // A zero has no size to scale, and `0px` is not a defect.
    expect(unscaledLengths('inset: 0px;')).toEqual([]);
  });

  it('finds every chrome rule it names', () => {
    for (const s of CHROME) expect(() => ruleFor(s)).not.toThrow();
    expect(() => ruleFor('.canvas-node.no-such-state')).toThrow();
  });

  // The other half of the rule, and the one that is easy to get backwards: the header's
  // contents must NOT be scaled again, because the wrapper around them already is.
  it('leaves the header contents at their natural size', () => {
    expect(ruleFor('.canvas-node-head-inner')).not.toMatch(/--node-k/);
    expect(ruleFor('.canvas-node-open')).not.toMatch(/--node-k/);
  });
});

/**
 * Exactly one sweep band crosses a running node's header at a time.
 *
 * This started as a copy of the tab strip's rule, which tiles a 160px gradient with
 * `repeat-x`. That shows one band on a ~160px tab and THREE on a 1440px overlaid node — three
 * sweeps chasing each other, which is not what "one thing is running" looks like.
 *
 * The replacement is a band sized as a FRACTION of the header, translated across it once per
 * period. The two numbers involved have to agree — travel end = 100 / band fraction, so the
 * band leaves the right edge exactly as the next crossing begins — and that relationship is
 * the thing worth pinning, because changing the width alone silently reintroduces overlap.
 */
describe('the running sweep runs once at a time', () => {
  const SWEEP = '.canvas-node.running .canvas-node-head::after';

  it('does not tile a fixed-width gradient across the header', () => {
    const body = ruleFor(SWEEP);
    expect(body).not.toMatch(/background-repeat:\s*repeat/);
    // `background-size` in px is the tiling period that caused this; a band width is a width.
    expect(body).not.toMatch(/background-size:\s*\d+px/);
    expect(body).toMatch(/width:\s*\d+(\.\d+)?%/);
  });

  it('borrows nothing from the tab strip, whose period is a tab wide', () => {
    expect(ruleFor(SWEEP)).not.toMatch(/tab-running-sweep/);
  });

  it('travels exactly one band width past each edge', () => {
    const bandPct = Number(ruleFor(SWEEP).match(/width:\s*(\d+(?:\.\d+)?)%/)![1]);
    const frames = CSS.match(/@keyframes\s+canvas-node-sweep\s*\{([\s\S]*?)\n\}/)![1];
    const from = Number(frames.match(/from\s*\{[^}]*translateX\((-?\d+(?:\.\d+)?)%/)![1]);
    const to = Number(frames.match(/to\s*\{[^}]*translateX\((-?\d+(?:\.\d+)?)%/)![1]);

    // Percentages in `translateX` are of the BAND's own width. Starting at -100% puts it fully
    // off the left edge; ending at 100/fraction puts it fully off the right.
    expect(from).toBe(-100);
    expect(to).toBeCloseTo(100 / (bandPct / 100), 0);
  });

  // The user's words: "timing of head and tail should be balanced". The band reads symmetric
  // only if its gradient peaks in the middle — an off-centre peak makes the leading and
  // trailing ramps different lengths, which looks like a stutter however wide the node is.
  it('peaks in the middle of the band, so head and tail ramp equally', () => {
    const body = ruleFor(SWEEP);
    const stops = [...body.matchAll(/(transparent|var\([^)]*\))\s+(\d+)%/g)].map((m) => ({
      colour: m[1], at: Number(m[2]),
    }));
    expect(stops.map((s) => s.at)).toEqual([0, 50, 100]);
    expect(stops[0].colour).toBe('transparent');
    expect(stops[2].colour).toBe('transparent');
    expect(stops[1].colour).not.toBe('transparent');
  });
});
