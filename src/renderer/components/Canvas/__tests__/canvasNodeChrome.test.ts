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

/**
 * Every `@keyframes` block in the file, by name.
 *
 * Braces are matched by COUNTING, because a keyframes block contains rules of its own. A regex
 * that stops at the first `}` reads only the `from` step — which for a translate animation is
 * usually the one that looks stationary, so the parser would report a moving band as still.
 * `rules()` above deliberately skips `@`-prefixed heads, so this is the only way to see them.
 */
function keyframes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < CSS.length && depth > 0; i += 1) {
      if (CSS[i] === '{') depth += 1;
      else if (CSS[i] === '}') depth -= 1;
    }
    out.set(m[1], CSS.slice(start, i - 1));
  }
  return out;
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
 * Req 5 (`plan/020` §3) — the header-wide sweep is gone from every canvas surface; the tab
 * strip's own sweep is untouched.
 *
 * This REPLACES `describe('the running sweep runs once at a time')`, which pinned the deleted
 * rule's shape (band width as a fraction of the header, symmetric gradient stops, the
 * once-per-period travel distance). Deleting that test along with the rule would leave the
 * requirement unpinned — a future PR could bring the sweep back onto `.canvas-node.running` or
 * `.canvas-srow.running` and nothing here would notice. So this asserts the requirement
 * POSITIVELY instead: no canvas surface's stylesheet defines or uses a sweep, and the tab
 * strip's — a different file — still does.
 */
describe('no canvas surface carries a sweep animation', () => {
  // Catches the rule being reintroduced under ITS OLD NAME...
  it('Canvas.css defines no sweep keyframes', () => {
    expect(CSS).not.toMatch(/@keyframes\s+[\w-]*sweep/i);
  });

  // ...and catches it being reintroduced under a NEW name, on a NEW selector, by MECHANISM.
  //
  // The first version of this test checked for `background-repeat` / `background-position` —
  // the tab strip's tiling technique, which the rule actually deleted here never used. It moved
  // a fixed-width gradient band with `transform: translateX` in its keyframes, so the exact
  // deleted effect could come back on `.canvas-node-head-inner::after` under a keyframe called
  // `canvas-node-crawl` and every assertion in this block would still have passed. A guard that
  // names one technique only guards that technique.
  //
  // What the requirement actually says is that a canvas busy cue is CHEAP: an opacity blink on a
  // small element, not something that moves. So that is what is asserted — any keyframe a canvas
  // surface animates must not translate anything or scroll a background, whatever it is called.
  it('no canvas surface animates anything that MOVES', () => {
    const frames = keyframes();
    const animated = rules()
      .filter((r) => /\.canvas-node|\.canvas-srow/.test(r.selector))
      .flatMap((r) => {
        const decl = /animation:\s*([^;]+)/.exec(r.body)?.[1] ?? '';
        return [...frames.keys()]
          .filter((name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(decl))
          .map((name) => ({ selector: r.selector, name }));
      });
    // Guard on the guard: if this resolved nothing the loop below would assert nothing, and a
    // renamed keyframe or a broken parser would read as "no canvas surface moves".
    expect(animated.length).toBeGreaterThan(0);
    for (const { selector, name } of animated) {
      const body = frames.get(name)!;
      expect({ selector, name, moves: /transform|background-position|\bleft\b|\bright\b/.test(body) })
        .toEqual({ selector, name, moves: false });
    }
  });

  // The tab strip's technique too, kept from the first version — it is still a way back in, just
  // not the one the deleted rule used.
  it('no canvas surface tiles or scrolls a background', () => {
    const surfaceRules = rules().filter((r) => /\.canvas-node|\.canvas-srow/.test(r.selector));
    expect(surfaceRules.length).toBeGreaterThan(0); // guard on the guard — the filter must hit something
    for (const r of surfaceRules) {
      expect(r.body).not.toMatch(/background-repeat:\s*repeat/);
      expect(r.body).not.toMatch(/background-position/);
      expect(r.body).not.toMatch(/tab-running-sweep/);
    }
  });

  // The exact two selectors the old rule was written against no longer resolve to anything —
  // `ruleFor` throws for a selector with no rule, same as it does for a typo.
  it('the deleted selectors have no rule at all', () => {
    expect(() => ruleFor('.canvas-node.running .canvas-node-head::after')).toThrow();
    expect(() => ruleFor('.canvas-srow.running::after')).toThrow();
  });

  // The other half of the requirement: this was never about removing the cue, only the
  // expensive, three-surface-wide version of it. The tab strip is a DIFFERENT stylesheet, so
  // deleting Canvas.css's copy cannot have taken it down too by accident.
  it('the tab strip still sweeps', () => {
    const tabCss = readSource(path.resolve(__dirname, '../../Tabs/TabManager.css'));
    expect(tabCss).toMatch(/\.tab-item\.tab-running::after\s*\{[^}]*animation:\s*tab-running-sweep/);
    expect(tabCss).toMatch(/@keyframes\s+tab-running-sweep/);
  });
});

/**
 * Req 6/7 — what replaced the sweep on the canvas: one shared keyframe, two consumers.
 *
 * Not a copy of the deleted describe above (there is no shape to reverse-engineer — a blink is
 * just an opacity animation), but the same principle: pin that the two rules genuinely SHARE
 * `canvas-busy-blink` rather than each defining their own that happens to look alike today.
 */
describe('the busy dot and the busy icon share one blink', () => {
  it('both reference the same keyframe', () => {
    expect(ruleFor('.canvas-node-dot')).toMatch(/animation:\s*canvas-busy-blink/);
    expect(ruleFor('.canvas-srow.running .shell-profile-icon')).toMatch(/animation:\s*canvas-busy-blink/);
  });

  it('the keyframe they share actually exists', () => {
    expect(CSS).toMatch(/@keyframes\s+canvas-busy-blink\s*\{/);
  });

  // Reduced motion keeps the animation (design 010 §9 / the tab strip's own note in
  // `TabManager.css`: a static accent "read as a stray border, not a running signal") rather
  // than dropping it — just slower. Both selectors, so they cannot fall out of step.
  it('reduced motion slows both rather than freezing either', () => {
    const reduced = rules().filter((r) => /animation-duration/.test(r.body)
      && (r.selector === '.canvas-node-dot' || r.selector === '.canvas-srow.running .shell-profile-icon'));
    expect(reduced.map((r) => r.selector).sort()).toEqual(
      ['.canvas-node-dot', '.canvas-srow.running .shell-profile-icon'].sort(),
    );
    expect(new Set(reduced.map((r) => r.body))).toEqual(new Set([reduced[0].body]));
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
