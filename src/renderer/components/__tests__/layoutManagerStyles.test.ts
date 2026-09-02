/**
 * Style tripwires for the Layout Manager, from the PR #65 GUI pass.
 *
 * CSS has no compiler and no runtime assertion here — jsdom does not apply
 * stylesheets, and these components cannot be mounted under the root Jest config
 * anyway (see `layoutManagerWiring.test.ts`'s header). So these read the
 * stylesheet as text, the same technique that file uses for the component.
 *
 * What makes them worth having is that two of the three GUI-pass defects were
 * INVARIANTS between rules rather than wrong values in one rule: a container
 * hovering into its own buttons' colour, and a selector that matched an element
 * type nobody had thought about. Both are invisible in a diff of either rule
 * alone, and both are cheap to state as a property.
 */
import * as path from 'path';
import { readSource } from '../../utils/readSource';

/** Comments stripped: they quote the very selectors and values under test, and a
 *  regex cannot tell a rule from a sentence describing one. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const LAYOUT_CSS = strip(readSource(path.join(__dirname, '..', 'LayoutManager.css')));
const CONFIRM_CSS = strip(readSource(path.join(__dirname, '..', 'UI', 'ConfirmDialog.css')));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The body of the rule whose selector list is EXACTLY `selector`. Anchored on
 *  `{` so `.btn-secondary` never matches `.btn-secondary:hover`. */
function ruleBody(css: string, selector: string): string {
  const m = css.match(new RegExp(`(?:^|})\\s*${escapeRe(selector)}\\s*\\{([^}]*)\\}`, 'm'));
  if (!m) throw new Error(`no rule with selector exactly "${selector}"`);
  return m[1];
}

function decl(css: string, selector: string, prop: string): string {
  const body = ruleBody(css, selector);
  const m = body.match(new RegExp(`(?:^|;)\\s*${escapeRe(prop)}\\s*:([^;]*)`, 'm'));
  if (!m) throw new Error(`rule "${selector}" declares no ${prop}`);
  return m[1].trim();
}

/**
 * Resolve `var(--name, #fallback)` to the colour it actually paints, by looking
 * `--name` up in this file's own `:root` block and falling back to the literal
 * when it is not declared there.
 *
 * Comparing the raw `var(...)` TEXT would be a weak oracle: two rules can name
 * different variables that resolve to the same colour, which is exactly the
 * shape of the bug (`--bg-row-hover` and `--bg-hover` are different names, and
 * the whole question is whether they are different COLOURS).
 */
function resolveColour(css: string, value: string): string {
  const m = value.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
  if (!m) return value.toLowerCase();
  const [, name, fallback] = m;
  const root = css.match(/:root\s*\{([\s\S]*?)\}/);
  const declared = root?.[1].match(new RegExp(`(?:^|;)\\s*${escapeRe(name)}\\s*:([^;]*)`, 'm'));
  return (declared?.[1] ?? fallback ?? '').trim().toLowerCase();
}

const colour = (css: string, selector: string, prop = 'background') =>
  resolveColour(css, decl(css, selector, prop));

describe('LayoutManager.css — the row must never hover into its buttons colour', () => {
  /**
   * The GUI-pass report was "when I hover on the row, the button and the
   * background are immersive". Nothing was dimming the buttons: `.layout-item:hover`
   * resolved to #37373d and `.btn-secondary` resolves to #37373d, so the row
   * simply became the buttons.
   *
   * Asserted as a RELATION, not as a literal. `expect(rowHover).toBe('#1f1f23')`
   * would pass for a future edit that moved `.btn-secondary` onto #1f1f23 —
   * re-creating the identical defect while the test stayed green. The property
   * is "these differ", so that is what is written down.
   */
  it('the row hover background differs from every background its own buttons wear', () => {
    const rowHover = colour(LAYOUT_CSS, '.layout-item:hover');
    expect(rowHover).toMatch(/^#[0-9a-f]{3,8}$/);

    const buttonColours = {
      'btn-secondary resting': colour(LAYOUT_CSS, '.btn-secondary'),
      'btn-secondary hover': colour(LAYOUT_CSS, '.btn-secondary:hover:not(:disabled)'),
      'btn-primary resting': colour(LAYOUT_CSS, '.btn-primary'),
      'btn-danger resting': colour(LAYOUT_CSS, '.btn-danger'),
    };
    // Every one is a real resolved colour, so a lookup that silently returned
    // '' cannot make the inequalities below pass vacuously.
    for (const [name, value] of Object.entries(buttonColours)) {
      expect(`${name}=${value}`).toMatch(/=#[0-9a-f]{3,8}$/);
      expect(`${name}:${value}`).not.toBe(`${name}:${rowHover}`);
    }
  });

  it('the row still visibly changes on hover — it differs from its own resting colour too', () => {
    // The paired positive. Without it, deleting the hover rule's background
    // entirely (or setting it equal to the resting colour) satisfies "differs
    // from the buttons" perfectly while removing the hover affordance.
    expect(colour(LAYOUT_CSS, '.layout-item:hover')).not.toBe(colour(LAYOUT_CSS, '.layout-item'));
  });
});

describe('LayoutManager.css — text-field chrome must not reach the radios', () => {
  /**
   * The scope radios rendered centred above their own labels because
   * `.form-group input` set `width: 100%` on them: Chromium honours width on a
   * native radio and stretches the control across the row, leaving the label
   * `<span>` no room.
   *
   * Pinned by TYPE rather than by `.scope-option`, because the class is the
   * selector: the next checkbox added under any form group inherits the same
   * text-field padding, border and background.
   */
  it('the width/padding rule excludes radios and checkboxes', () => {
    const sizingRule = LAYOUT_CSS.match(/\.form-group input([^,{]*),\s*\n\s*\.form-group textarea\s*\{/);
    expect(sizingRule).not.toBeNull();
    expect(sizingRule![1]).toContain(":not([type='radio'])");
    expect(sizingRule![1]).toContain(":not([type='checkbox'])");
  });

  it('the focus rule excludes them as well', () => {
    // A focus ring shaped for a text box is wrong on a radio for the same
    // reason the box itself is — and this half was written separately, so it
    // could be fixed separately and half-fixed just as easily.
    const focusRule = LAYOUT_CSS.match(/\.form-group input([^,{]*):focus,\s*\n\s*\.form-group textarea:focus\s*\{/);
    expect(focusRule).not.toBeNull();
    expect(focusRule![1]).toContain(":not([type='radio'])");
    expect(focusRule![1]).toContain(":not([type='checkbox'])");
  });

  /**
   * The other half of the same defect, and the half the first fix missed.
   *
   * `.form-group label` (0,1,1) outranks `.scope-option` (0,1,0), so as a
   * DESCENDANT selector it won the `display` fight and the option label was
   * never a flex row: its `gap` did nothing and — because JSX strips the
   * whitespace between the `<input>` and the `<span>` — the radio ended up
   * touching its own text. Removing `width: 100%` from the input rule fixed the
   * stacking without touching this.
   */
  it('the field-label rule is scoped to direct children, so it cannot reach the option labels', () => {
    expect(LAYOUT_CSS).toContain('.form-group > label {');
    const bare = [...LAYOUT_CSS.matchAll(/(?:^|[},])\s*\.form-group label\b/g)];
    expect(bare).toEqual([]);
  });

  it('the option label is therefore a real flex row with a real gap', () => {
    // Asserted rather than assumed: this rule was present and inert for the
    // whole of the previous fix, which is exactly why it needs an oracle.
    expect(decl(LAYOUT_CSS, '.scope-option', 'display')).toBe('flex');
    expect(decl(LAYOUT_CSS, '.scope-option', 'gap')).toMatch(/^\d+px$/);
    // Vertical centring is the same casualty. While `display: block` won, the
    // radio was an INLINE box sitting on the text baseline — which renders it
    // high against the text's optical middle. `align-items: center` was present
    // the whole time and inert; making the row a real flex row is what applies
    // it. Deliberately no manual `top`/`margin` nudge: an offset stacked on top
    // of working cross-axis centring would push it back off by that amount.
    expect(decl(LAYOUT_CSS, '.scope-option', 'align-items')).toBe('center');
  });

  it('the radio carries no UA margin to add unevenly to that gap', () => {
    expect(decl(LAYOUT_CSS, ".scope-option input[type='radio']", 'margin')).toBe('0');
  });

  it('leaves no OTHER bare `.form-group input` rule for the chrome to leak through', () => {
    // The census, not just the two known sites. Any `.form-group input` that is
    // not immediately followed by a `:not(` exclusion is a fresh leak.
    const bare = [...LAYOUT_CSS.matchAll(/\.form-group input(?!:not\()([^,{;]*)/g)]
      .map(m => `.form-group input${m[1]}`.trim());
    expect(bare).toEqual([]);
  });
});

describe('ConfirmDialog.css — footer buttons keep their labels on one line', () => {
  /**
   * "Switch anyway" broke across two lines inside its own button. The footer is
   * a flex row with no `flex-wrap`, so its only way to yield was to compress a
   * button below its label's natural width, and `white-space` defaulted to
   * `normal` so the label wrapped rather than overflowing.
   *
   * The width bump alone would not have fixed this — it only moves the
   * threshold, and the next longer label crosses it. These two declarations are
   * the actual property.
   */
  it('a footer button never shrinks below its own label', () => {
    expect(decl(CONFIRM_CSS, '.confirm-btn', 'flex-shrink')).toBe('0');
    expect(decl(CONFIRM_CSS, '.confirm-btn', 'white-space')).toBe('nowrap');
  });

  it('the footer wraps whole buttons when they genuinely do not fit', () => {
    // The escape hatch that makes `flex-shrink: 0` safe: without it, three
    // unshrinkable buttons in a too-narrow dialog overflow the rounded corner
    // instead of moving to a second line.
    expect(decl(CONFIRM_CSS, '.confirm-dialog-footer', 'flex-wrap')).toBe('wrap');
  });
});
