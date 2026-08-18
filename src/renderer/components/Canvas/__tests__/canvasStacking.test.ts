import fs from 'fs';
import path from 'path';
import { readSource } from '../../../utils/readSource';

/**
 * What keeps Canvas Mode's paint honest, now that it is a TAB rather than an overlay.
 *
 * As an overlay it sat at `z-index: 900` and that number was a real cross-file invariant:
 * the tab-mode DOM stayed mounted and PAINTING underneath, so every floating widget a
 * terminal owns competed with the canvas directly — `.terminal-display`'s
 * `isolation: isolate` did not contain ScrollToBottomButton, TerminalSearchBar or
 * CommandSuggestPopup, because those are its SIBLINGS inside
 * `.terminal-display-wrapper`. At the original z-index 5, a scroll-to-bottom button left
 * over from tab mode painted on top of the canvas and stayed clickable.
 *
 * The canvas now sits INSIDE `.tab-content`, and the thing that makes the whole class of
 * bug unreachable is one rule in a different file: an inactive tab is `opacity: 0`, which
 * makes its entire subtree fully transparent AND gives it its own stacking context, so
 * nothing in another tab can paint over the canvas at any z-index at all.
 *
 * That is a load-bearing property of TerminalContainer.css that nothing in the canvas
 * directory states, and weakening it (to `visibility` alone, say, which a descendant can
 * override with `visibility: visible`) would silently bring the old bug back in its new
 * form. So it is DERIVED from the real stylesheet here rather than trusted.
 */

const RENDERER = path.resolve(__dirname, '../../..');

const read = (rel: string) => readSource(path.join(RENDERER, rel));

/** Every `z-index: N` DECLARATION in a file. Prose mentions of z-index in comments
 *  have no colon and are correctly ignored. */
function zIndexesIn(file: string): number[] {
  return [...readSource(file).matchAll(/z-index:\s*(-?\d+)/g)].map((m) => Number(m[1]));
}

/**
 * The declaration block of a rule, matched on the WHOLE selector.
 *
 * Deliberately not a `new RegExp(selector)` — every selector here is full of regex
 * metacharacters (`.`, and `.tab-content.active` twice over), and an unescaped one either
 * throws or, worse, matches something else. Splitting the stylesheet into rules and
 * comparing selectors as strings has no escaping problem to get wrong. Matching the whole
 * selector also stops `.tab-content` from silently reading `.tab-content.active`'s body.
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

describe('an inactive tab cannot paint over the canvas', () => {
  const css = read('components/TerminalContainer.css');

  it('makes inactive tab content fully transparent, inert and hidden', () => {
    const body = ruleBody(css, '.tab-content');
    // `opacity: 0` is the one that matters and the one most likely to be "tidied" away:
    // it is the only one of the three a descendant cannot override, and the only one that
    // establishes a stacking context. The other two are kept because they also stop the
    // subtree taking clicks and focus.
    expect(body).toMatch(/opacity:\s*0/);
    expect(body).toMatch(/visibility:\s*hidden/);
    expect(body).toMatch(/pointer-events:\s*none/);
  });

  it('restores all three on the active tab', () => {
    const body = ruleBody(css, '.tab-content.active');
    expect(body).toMatch(/opacity:\s*1/);
    expect(body).toMatch(/visibility:\s*visible/);
    expect(body).toMatch(/pointer-events:\s*auto/);
  });

  // Mutation check: the reader must really be able to fail. Without this, renaming
  // `.tab-content` would leave two assertions that throw a confusing "no rule" error
  // instead of a meaningful one — and a body-matcher bug would be invisible.
  it('reads the rule bodies it claims to read', () => {
    expect(() => ruleBody(css, '.no-such-rule')).toThrow();
    expect(ruleBody(css, '.tab-content')).not.toEqual(ruleBody(css, '.tab-content.active'));
  });
});

describe('Canvas Mode stays inside its tab', () => {
  const css = read('components/Canvas/Canvas.css');

  /**
   * The two suites are coupled, and this is the coupling. The isolation above only covers
   * the canvas while the canvas is a TAB CHILD; making `.canvas-mode` fixed, or lifting it
   * out of the flow with a z-index, puts it back into competition with the whole app and
   * silently re-creates the need for the 900-level invariant this file used to police.
   *
   * So: no z-index at all. It would also be actively harmful — a stacking context here
   * traps canvas-owned chrome (Task 18's edge layer, Task 23's minimap) inside it.
   */
  it('declares no z-index and is not fixed', () => {
    const body = ruleBody(css, '.canvas-mode');
    expect(body).not.toMatch(/z-index:/);
    expect(body).not.toMatch(/position:\s*fixed/);
    expect(body).toMatch(/position:\s*absolute/);
  });

  // The overlay needed `.app-body { position: relative }` to avoid covering the title bar.
  // A tab does not, and leaving a rule in Canvas.css that mutates app-level layout for a
  // reason that no longer exists is how stylesheets accumulate haunted cruft.
  it('no longer reaches out of its own directory to position the app body', () => {
    expect(css).not.toMatch(/\.app-body\s*\{/);
  });
});

/**
 * The orientation chrome (`plan/013` Task 23) — the minimap and the edge beacons.
 *
 * Both are rendered into `CanvasViewport`'s `overlay` slot: inside `.canvas-viewport`, and
 * deliberately OUTSIDE `.canvas-world`. That placement is what makes their z-indexes mean
 * anything at all, and it is derived here rather than trusted, because moving either one back
 * into the world would be a one-line change that looks harmless.
 */
describe('orientation chrome paints above the world it describes', () => {
  const css = read('components/Canvas/Canvas.css');
  const zOf = (selector: string): number => {
    const m = /z-index:\s*(-?\d+)/.exec(ruleBody(css, selector));
    if (!m) throw new Error(`no z-index in ${selector}`);
    return Number(m[1]);
  };

  it('keeps the minimap above the beacons', () => {
    // A beacon clamped into the bottom-right corner lands exactly on the minimap. Ordered the
    // other way it covers a 168x112 click target with a 22px one, and the minimap stops
    // working in precisely the situation — something running off screen — that put it there.
    expect(zOf('.canvas-beacon')).toBeLessThan(zOf('.canvas-minimap'));
  });

  it('keeps both above `.canvas-world`, which claims no z-index of its own', () => {
    // `.canvas-world` sets `will-change: transform`, so it is a stacking context at level 0 and
    // nothing inside it can outrank a positive sibling. Give it a z-index and that stops being
    // true — the nodes would paint over the chrome that is supposed to point AT them.
    expect(ruleBody(css, '.canvas-world')).not.toMatch(/z-index:/);
    expect(zOf('.canvas-beacon')).toBeGreaterThan(0);
    expect(zOf('.canvas-minimap')).toBeGreaterThan(0);
  });

  it('leaves the minimap box UNSIZED here, because its size is a projection input', () => {
    // `MINIMAP_W`/`MINIMAP_H` are arguments to `minimapTransform`, and the element takes them
    // inline from the same constants. A width in this file would be a second source of truth
    // for the projection, and the symptom — content scaled for a box of a different size —
    // is silent: the map still draws, just wrong.
    const body = ruleBody(css, '.canvas-minimap');
    expect(body).not.toMatch(/(^|;)\s*width:/);
    expect(body).not.toMatch(/(^|;)\s*height:/);
  });
});

/**
 * A modal cannot escape an ancestor stacking context, so its z-index is only worth what its
 * ancestors allow. `ConfirmDialog` declares `z-index: 9999` and still painted behind Canvas
 * Mode's overlay at 900, because `TabManager` renders it inside `.title-bar-tabs`
 * (`position: relative; z-index: 100`).
 *
 * The fix is structural, not numeric: an app-level modal must be a child of `<body>`. This
 * derives the rule from the real files rather than listing the components by hand — a new
 * dialog is covered the day its stylesheet is written.
 */
describe('app-level modals escape their caller', () => {
  const UI = path.join(RENDERER, 'components/UI');

  /** Stylesheets declaring a full-viewport overlay in the 1000+ tier. */
  function overlayStylesheets(): string[] {
    return fs.readdirSync(UI)
      .filter((n) => n.endsWith('.css'))
      .filter((n) => {
        const css = readSource(path.join(UI, n));
        return /position:\s*fixed/.test(css) && zIndexesIn(path.join(UI, n)).some((z) => z >= 1000);
      });
  }

  it('found the overlay stylesheets it is meant to police', () => {
    const found = overlayStylesheets();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain('ConfirmDialog.css');
  });

  it('renders every one of them through a portal', () => {
    const offenders: string[] = [];
    for (const css of overlayStylesheets()) {
      const tsx = path.join(UI, css.replace(/\.css$/, '.tsx'));
      if (!fs.existsSync(tsx)) continue;
      if (!/createPortal/.test(readSource(tsx))) offenders.push(path.basename(tsx));
    }
    expect(offenders).toEqual([]);
  });
});
