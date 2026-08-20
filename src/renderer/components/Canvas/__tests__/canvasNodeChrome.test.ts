import fs from 'fs';
import path from 'path';
import { readSource } from '../../../utils/readSource';

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

const CSS = readSource(path.resolve(__dirname, '../Canvas.css')).replace(/\/\*[\s\S]*?\*\//g, '');

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

/** Custom properties that are themselves defined from `--node-k`, so using one is enough. */
const COUNTER_SCALED = [
  '--node-k', '--node-chrome-k', '--node-chrome-w', '--node-divider-w', '--port-size', '--node-radius',
];

/**
 * Remove every `calc(...)` / `var(...)` call satisfying `drop`, matching parentheses by
 * counting rather than by regex.
 *
 * `calc(1px * var(--node-k, 1))` nests, and a regex written to skip one level silently stops
 * matching at two — which reads as "no unscaled lengths here" and passes. A scanner cannot
 * make that mistake, and getting this wrong makes the whole suite vacuous.
 */
function stripCalls(css: string, drop: (call: string) => boolean): string {
  let out = '';
  for (let i = 0; i < css.length;) {
    const m = /^(calc|var)\(/.exec(css.slice(i));
    if (!m) { out += css[i]; i += 1; continue; }
    let depth = 0;
    let j = i + m[0].length - 1;
    for (; j < css.length; j += 1) {
      if (css[j] === '(') depth += 1;
      else if (css[j] === ')' && (depth -= 1) === 0) break;
    }
    const call = css.slice(i, j + 1);
    if (!drop(call)) out += call;
    i = j + 1;
  }
  return out;
}

function unscaledLengths(body: string): string[] {
  const stripped = stripCalls(body, (call) =>
    // Anything routed through a counter-scaled custom property is fine...
    COUNTER_SCALED.some((name) => call.includes(name))
    // ...and a `var(--x, 29px)` FALLBACK is a default for a value the component always
    // supplies, not a length this stylesheet draws.
    || /^var\(--[\w-]+,/.test(call));
  return [...stripped.matchAll(BARE_PX)].map((m) => m[0]).filter((v) => parseFloat(v) !== 0);
}

describe('node chrome is counter-scaled', () => {
  // The chrome that sits OUTSIDE the header's own counter-scale wrapper. Listed because each
  // is a distinct visual failure, then checked structurally below so the list cannot go stale
  // without the sweep test noticing.
  const CHROME = [
    '.canvas-node', '.canvas-node.selected', '.canvas-node.focused', '.canvas-port',
    // Added after a real miss. These two kept a hard-coded `6px` radius while the node's own
    // corner counter-scaled, so at the working zoom the terminal had a ~25px corner inside a
    // ~2px one and the node's background showed through the gap as a wedge. The list was the
    // bug: the rule was right, the set it ran over was too small.
    '.canvas-node-head', '.canvas-node-body',
    '.canvas-node[data-lod="chip"] .canvas-node-head',
    // A GROUP FRAME is chrome too, and was the last piece still growing with the zoom: at the
    // working zoom its 1px border drew at 4.2px, so the frame outlined its terminals more
    // heavily than they outlined themselves. It is a SIBLING of the nodes, not a child, which
    // is why the scales had to move to `.canvas-mode` before it could read one.
    '.canvas-gframe',
  ];

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
    expect(unscaledLengths('border-radius: 0 0 6px 6px;')).toEqual(['6px', '6px']);
    expect(unscaledLengths('border-radius: 0 0 var(--node-radius) var(--node-radius);')).toEqual([]);
    // A zero has no size to scale, and `0px` is not a defect.
    expect(unscaledLengths('inset: 0px;')).toEqual([]);
    // A variable fallback is a default, not a drawn length.
    expect(unscaledLengths('height: var(--canvas-head-h, 29px);')).toEqual([]);
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

  /**
   * Task 14's sidebar rows are the THIRD surface to want this, so they join the selector list
   * rather than taking a copy — everything above then holds for a row for free, which is the
   * whole point of not pasting it a third time.
   *
   * Asserted as identity of the rule BODY, not as "the row has a sweep": two rules that happen
   * to agree today is exactly the state this is meant to prevent.
   */
  const ROW_SWEEP = '.canvas-srow.running::after';

  it('a sidebar row shares the rule rather than owning a copy of it', () => {
    expect(ruleFor(ROW_SWEEP)).toBe(ruleFor(SWEEP));
  });

  /**
   * ...and the band only lands correctly because the row reproduces the three properties the
   * node header carries. `z-index: -1` is resolved against the nearest stacking context, so
   * without `isolation: isolate` on the row the band would sink behind the sidebar's own
   * background and vanish — visible nowhere, and passing every test that only reads the sweep
   * rule itself.
   */
  it('a sidebar row establishes the stacking context the band needs', () => {
    const row = ruleFor('.canvas-srow');
    expect(row).toMatch(/position:\s*relative/);
    expect(row).toMatch(/isolation:\s*isolate/);
    expect(row).toMatch(/overflow:\s*hidden/);
  });

  it('the reduced-motion override reaches the row too', () => {
    // Design 010 §9. Two entries in one media rule, so they cannot fall out of step.
    const reduced = rules().filter((r) => r.selector === ROW_SWEEP && /animation-duration/.test(r.body));
    expect(reduced).toHaveLength(1);
    expect(reduced[0].body).toBe(
      rules().find((r) => r.selector === SWEEP && /animation-duration/.test(r.body))!.body,
    );
  });
});

/**
 * The frame is one screen pixel at every zoom, and it costs no layout.
 *
 * Two properties, and they are load-bearing together rather than separately:
 *
 *  - **`outline`, never `border`.** `box-sizing: border-box` is global, so a world-space border
 *    eats the body's height — at the overview `1px / 0.05` is twenty world pixels, a tenth of
 *    the body — and the box the surface scales into would move with the zoom. An outline is
 *    free, which is what lets the width be counter-scaled honestly instead of clamped to
 *    something that looks wrong at one end.
 *  - **`--node-chrome-k`, not `--node-k`.** The frame's counter-scale is UNCLAMPED `1/z`. The
 *    title bar's is clamped at 1, because a label on a 96px node has to grow with it. Using
 *    the header's scale for the frame is the bug this pins: it leaves the outline at `1px * z`
 *    below zoom 1, which is a third of a pixel at the overview.
 */
describe('the node frame is screen-space', () => {
  const declaration = (selector: string, prop: string) => {
    for (const decl of ruleFor(selector).split(';')) {
      const [name, ...rest] = decl.split(':');
      if (name.trim() === prop) return rest.join(':').trim();
    }
    return null;
  };

  it('draws the frame with an outline that consumes no layout', () => {
    const node = ruleFor('.canvas-node');
    expect(declaration('.canvas-node', 'outline')).toContain('var(--node-chrome-w)');
    // A `border` shorthand here would silently reintroduce the layout cost. `border-radius`
    // is a different property and is expected.
    expect(node).not.toMatch(/(?:^|;)\s*border(?:-(?:top|right|bottom|left|width))?\s*:/);
  });

  it('counter-scales the frame with the UNCLAMPED scale, not the header one', () => {
    expect(declaration('.canvas-node', '--node-chrome-w')).toContain('var(--node-chrome-k');
    expect(declaration('.canvas-node', '--node-chrome-w')).not.toContain('--node-k,');
    // The ports are frame, not content, and share its scale.
    expect(declaration('.canvas-port', '--port-size')).toContain('var(--node-chrome-k');
  });

  // The header keeps the CLAMPED scale, and mixing the two up is the easiest mistake here.
  it('keeps the corner radius on the header scale', () => {
    expect(declaration('.canvas-node', '--node-radius')).toContain('var(--node-k');
  });

  // The outer edge and the inner rule are different jobs and must not share a width: at the
  // same weight the divider under the title competes with the outline that separates the whole
  // node from the canvas.
  it('gives the inner divider its own, lighter width', () => {
    const outer = declaration('.canvas-node', '--node-chrome-w')!;
    const inner = declaration('.canvas-node', '--node-divider-w')!;
    expect(inner).not.toBe(outer);
    const px = (v: string) => Number(v.match(/(\d+(?:\.\d+)?)px/)![1]);
    expect(px(inner)).toBeLessThan(px(outer));
    expect(declaration('.canvas-node-head', 'border-bottom')).toContain('var(--node-divider-w)');
  });
});

/**
 * All three corners are one radius.
 *
 * The node, its header and its body each draw a corner. They only read as one shape if they
 * share a value — an earlier version had `7px` outside and `6px` inside, which lined up only
 * because the border happened to be 1px, and produced a visible wedge of node background as
 * soon as the outer radius counter-scaled and the inner one did not.
 *
 * With the frame an outline, nothing consumes layout between them, so there is no inner/outer
 * distinction left to get wrong: one variable, used three times.
 */
describe('node corners are one radius', () => {
  const radius = (selector: string) => {
    const m = ruleFor(selector).match(/border-radius:([^;]+)/);
    return m ? m[1].trim() : null;
  };

  it('uses the same variable for the node, the header and the body', () => {
    expect(radius('.canvas-node')).toBe('var(--node-radius)');
    for (const s of ['.canvas-node-head', '.canvas-node-body']) {
      expect(radius(s)).toContain('var(--node-radius)');
      expect(radius(s)).not.toMatch(/\d+px/);
    }
  });

  // The body is what clips the terminal to the node's shape. Without the clip, xterm's own
  // square background paints over the rounded corner and the node has no corner at all.
  it('clips the terminal to that corner', () => {
    expect(ruleFor('.canvas-node-body')).toMatch(/overflow:\s*hidden/);
  });
});

/**
 * `plan/020` §1 — the bottom-anchoring lift, and the one thing about it that can silently break.
 *
 * `surfaceShift` is unit-tested against real numbers, but it computes a length in the NODE's
 * unscaled pixels. Whether that length lands correctly is decided entirely by where it sits in
 * the `transform` list, and CSS applies transform functions RIGHT TO LEFT. Written after the
 * scale it is a move in the parent's coordinate space, which is what the number means; written
 * before it, the same number is multiplied by the scale — off by 3x on a portrait pane, and
 * still zero in every case where the shift is zero, so the mistake hides wherever anyone would
 * think to look for it.
 *
 * Nothing executes a stylesheet, so this is derived from the file.
 */
describe('the surface is lifted, not letterboxed', () => {
  const surface = ruleFor('.canvas-surface');

  it('applies the shift in the node\'s own pixels, after the scale', () => {
    const transform = /transform:\s*([^;]+);/.exec(surface)?.[1].replace(/\s+/g, ' ');
    expect(transform).toBeTruthy();
    const translateAt = transform!.indexOf('translateY');
    const scaleAt = transform!.indexOf('scale(');
    expect(translateAt).toBeGreaterThanOrEqual(0);
    expect(scaleAt).toBeGreaterThanOrEqual(0);
    // Right-to-left: the scale must be applied FIRST, so it must be written LAST.
    expect(translateAt).toBeLessThan(scaleAt);
  });

  // The var has to carry a fallback. A node that never sets it — a test render, or the chip
  // tier — would otherwise make the whole transform invalid and drop the SCALE with it, which
  // renders every host at full pane size inside a 320px node.
  it('falls back to no shift when a node does not set one', () => {
    expect(surface).toMatch(/var\(--node-surface-shift,\s*0px\)/);
  });

  // The lift replaces a clip; it must not become a second one. `.canvas-surface` keeps its own
  // `overflow: hidden` so the lifted-out rows are cut at the surface, not painted over chrome.
  it('still clips its own overflow', () => {
    expect(surface).toMatch(/overflow:\s*hidden/);
  });

  // `plan/017` §5.2: the border-box chain only holds because this element has neither.
  // A border here shifts every canvas terminal by a column.
  it('takes no padding or border, which would resize a live PTY', () => {
    expect(surface).not.toMatch(/(?<![\w-])padding\s*:/);
    expect(surface).not.toMatch(/(?<![\w-])border\s*:/);
  });
});
