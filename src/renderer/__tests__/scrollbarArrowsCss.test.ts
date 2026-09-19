/**
 * The scrollbar ▲/▼ glyphs are drawn by TerminalDisplay.css — and ONLY the glyphs (plan 046).
 *
 * The patched xterm scrollbar (patches/xterm-scrollbar-arrows-patch.js) creates the two `.scra`
 * button nodes but, with VS Code's codicon class stripped, they arrive empty: the triangle comes
 * from the `::before` rules below. Their colour does NOT come from here — the patched Viewport
 * injects `.scra { color: <scheme foreground> }` alongside the thumb colours, so the arrows
 * recolour with the scheme. An app rule that set `color` on `.scra` would win the cascade over
 * that injected rule (it is a plain `.xterm …` selector) and freeze the arrows on one colour for
 * every scheme, which is the regression this test exists to catch.
 *
 * jsdom has no cascade, so the stylesheet text is the only place this can be asked.
 */
import fs from 'fs';
import path from 'path';

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'Terminal', 'TerminalDisplay.css'),
  'utf8',
);

/** Comments stripped first: a block comment has no braces and would be swallowed into a selector. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** `[selector, declarations]` for every rule whose selector mentions the arrow glyph node. */
const arrowRules = [...RULES.matchAll(/([^{}]*\.scra[^{}]*)\{([^}]*)\}/g)]
  .map((m) => [m[1].trim(), m[2]] as const);

const ARROW = '.terminal-display .xterm .xterm-scrollable-element > .scrollbar > .scra';

describe('scrollbar arrow glyphs', () => {
  it('draws an up-pointing triangle for ▲ and a down-pointing one for ▼, in currentColor', () => {
    const up = arrowRules.find(([sel]) => sel === `${ARROW}.scra-up::before`);
    const down = arrowRules.find(([sel]) => sel === `${ARROW}.scra-down::before`);
    expect(up).toBeDefined();
    expect(down).toBeDefined();
    // A CSS-border triangle points AWAY from the coloured border: bottom border → points up.
    expect(up![1]).toMatch(/border-bottom:\s*\d+px solid currentColor/);
    expect(down![1]).toMatch(/border-top:\s*\d+px solid currentColor/);
    // The shared base gives both the transparent side borders and centres the box.
    const base = arrowRules.find(([sel]) => sel === `${ARROW}::before`);
    expect(base).toBeDefined();
    expect(base![1]).toMatch(/border-left:\s*\d+px solid transparent/);
    expect(base![1]).toMatch(/border-right:\s*\d+px solid transparent/);
    expect(base![1]).toMatch(/content:\s*''/);
  });

  it('is scoped to .terminal-display, so it beats xterm.css and reaches Canvas nodes too', () => {
    // xterm.css styles `.xterm .xterm-scrollable-element > .scrollbar > .scra` (0,3,0); one
    // more class wins. Both the pane and the Canvas node host carry `.terminal-display`
    // (design 012 D17), which is what makes the same rule follow a relocated terminal.
    expect(arrowRules.length).toBeGreaterThan(0);
    for (const [sel] of arrowRules) expect(sel.startsWith(ARROW)).toBe(true);
  });

  it('never sets the arrow colour itself — that is the theme service\'s job', () => {
    for (const [sel, decl] of arrowRules) {
      // `border-*-color`/`currentColor` are fine; a bare `color:` declaration is the defect.
      expect({ sel, sets: /(^|[\s;])color\s*:/.test(decl) }).toEqual({ sel, sets: false });
    }
  });
});
