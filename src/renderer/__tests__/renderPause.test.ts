import path from 'path';
import { readSource } from '../utils/readSource';

/**
 * **Hiding a terminal must also PAUSE it.**
 *
 * xterm 6's `RenderService` registers an `IntersectionObserver` on its screen element and
 * sets `_isPaused` when that element stops intersecting the viewport. That is a free render
 * suspension the library already ships — and `visibility: hidden` does not trigger it,
 * because a `visibility: hidden` element still intersects. Neither does `opacity: 0`.
 *
 * Measured, in an isolated xterm harness, over 8s with data arriving:
 *
 *     visible (baseline)          _isPaused=false    79 renders
 *     visibility:hidden           _isPaused=false    79 renders   <- full cost, invisible
 *     opacity:0                   _isPaused=false    79 renders
 *     display:none                _isPaused=true      0 renders   <- but collapses the box
 *     content-visibility:hidden   _isPaused=true      0 renders   <- box preserved
 *     off-screen transform        _isPaused=true      0 renders   <- box preserved
 *
 * So every surface that hides a live terminal has to say `content-visibility: hidden` as
 * well, and `display: none` is still forbidden everywhere (it collapses the host to 0x0 and
 * `FitAddon.proposeDimensions()` then returns a plausible, wrong `{cols:12, rows:6}` rather
 * than erroring — `012` §6.5 RC3).
 *
 * **This file is deliberately one test per LAYER, not one test.** The same defect existed at
 * three independent sites at once — the tab container, the canvas tier stylesheet, and
 * `CanvasNode`'s inline style — and fixing the one that was noticed would have left the other
 * two silently repainting. Each is derived from its own real source file, so deleting the
 * property anywhere fails here rather than in a profiler months later.
 */

const RENDERER = path.resolve(__dirname, '..');
const read = (rel: string) => readSource(path.join(RENDERER, rel));

/**
 * The declaration block of a rule, matched on the WHOLE selector — the same approach
 * `canvasStacking.test.ts` uses, and for the same reason: every selector here is full of
 * regex metacharacters, and matching on a substring would let `.tab-content` silently read
 * `.tab-content.active`'s body.
 */
function ruleBody(css: string, selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const one of m[1].split(',')) {
      if (one.trim() === selector) return m[2];
    }
  }
  throw new Error(`no rule for ${selector} — the test's subject moved or was renamed`);
}

/** A rule whose selector LIST contains `selector`, for the grouped canvas tier rule. */
function groupedRuleBody(css: string, selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').some((s) => s.trim() === selector)) return m[2];
  }
  throw new Error(`no rule listing ${selector} — the test's subject moved or was renamed`);
}

describe('layer 1 — an inactive TAB pauses its terminals', () => {
  const css = read('components/TerminalContainer.css');

  it('gives inactive tab content content-visibility: hidden', () => {
    expect(ruleBody(css, '.tab-content')).toMatch(/content-visibility:\s*hidden/);
  });

  // Without this the property would apply to the ACTIVE tab too and blank the app: the base
  // rule matches every .tab-content, so the active one must switch it back on explicitly.
  it('restores it on the active tab', () => {
    expect(ruleBody(css, '.tab-content.active')).toMatch(/content-visibility:\s*visible/);
  });

  // The three pre-existing declarations are load-bearing for a DIFFERENT reason (stacking and
  // input, see canvasStacking.test.ts). content-visibility is an addition, never a swap.
  it('keeps the opacity/visibility/pointer-events trio it was added alongside', () => {
    const body = ruleBody(css, '.tab-content');
    expect(body).toMatch(/opacity:\s*0/);
    expect(body).toMatch(/visibility:\s*hidden/);
    expect(body).toMatch(/pointer-events:\s*none/);
  });

  it('never reaches for display: none', () => {
    expect(ruleBody(css, '.tab-content')).not.toMatch(/display:\s*none/);
  });
});

describe('layer 2 — canvas tiers below `live` pause their terminals', () => {
  const css = read('components/Canvas/Canvas.css');

  // The tier rule is what makes MAX_INTERACTIVE mean anything. Before this, a node the user
  // saw as a static snapshot or a chip was still repainting its terminal underneath.
  it.each(['snapshot', 'chip', 'group'])('pauses the %s tier surface', (tier) => {
    const body = groupedRuleBody(css, `.canvas-node[data-lod="${tier}"] .canvas-surface`);
    expect(body).toMatch(/content-visibility:\s*hidden/);
    expect(body).toMatch(/visibility:\s*hidden/);
    expect(body).not.toMatch(/display:\s*none/);
  });
});

describe('layer 3 — a hidden canvas NODE pauses its terminal', () => {
  const src = read('components/Canvas/CanvasNode.tsx');

  /**
   * `isHidden` is `collapsed || tier === 'group' || !visible.has(id)`. Only the last of those
   * is off-screen and therefore self-pausing; a whole-canvas collapse and the group tier both
   * leave the node ON SCREEN, where `visibility` alone would keep it painting.
   */
  it('drives contentVisibility from the same `hidden` prop as visibility', () => {
    expect(src).toMatch(/contentVisibility:\s*hidden\s*\?\s*'hidden'\s*:\s*undefined/);
    expect(src).toMatch(/visibility:\s*hidden\s*\?\s*'hidden'\s*:\s*undefined/);
  });

  it('still never uses display to hide a node', () => {
    // Matches the STYLE object only; the file's prose explains why display:none is banned.
    expect(src).not.toMatch(/display:\s*hidden\s*\?/);
  });
});

describe('layer 4 — a pane hidden by MAXIMIZE pauses its terminal', () => {
  const src = read('components/Panes/SplitPane.tsx');

  /**
   * Found by sweeping for the defect CLASS rather than stopping at the three sites that
   * were noticed first. The maximized pane's sibling keeps `position: absolute` at
   * 100%x100%, so it is still intersecting the viewport and `visibility: hidden` alone left
   * it repainting for as long as the pane stayed maximized.
   */
  it('gives the hidden sibling content-visibility, not just visibility', () => {
    const style = src.slice(src.indexOf('const hiddenStyle'), src.indexOf('const pane1Style'));
    expect(style).toMatch(/visibility:\s*'hidden'/);
    expect(style).toMatch(/contentVisibility:\s*'hidden'/);
    // The box must survive, or FitAddon measures a collapsed sibling on the way back.
    expect(style).toMatch(/width:\s*'100%'/);
    expect(style).toMatch(/height:\s*'100%'/);
  });

  it('reads the style object it claims to read', () => {
    expect(src.indexOf('const hiddenStyle')).toBeGreaterThan(-1);
    expect(src.indexOf('const pane1Style')).toBeGreaterThan(src.indexOf('const hiddenStyle'));
  });
});

// Mutation check: these readers must really be able to fail, or a renamed selector would
// turn every assertion above into a confusing "no rule" error instead of a real one.
describe('the source readers can fail', () => {
  const css = read('components/TerminalContainer.css');
  it('throws on a selector that is not there', () => {
    expect(() => ruleBody(css, '.no-such-rule')).toThrow();
    expect(() => groupedRuleBody(css, '.no-such-rule')).toThrow();
  });
  it('distinguishes the two tab-content rules', () => {
    expect(ruleBody(css, '.tab-content')).not.toEqual(ruleBody(css, '.tab-content.active'));
  });
});
