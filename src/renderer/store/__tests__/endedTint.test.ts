import path from 'path';
import { readSource } from '../../utils/readSource';
/**
 * xterm's decoration backgroundColor takes no alpha (#RRGGBB only), so the marks
 * for an ended program's scrollback must be pre-blended against the pane's scheme
 * background. The wash uses the same 0.13 as the session-level pane overlay so
 * both scopes read as one feature; the rail is much stronger, because a 13% wash
 * is nearly invisible on some schemes and the rail is what makes it legible.
 */
import { blendEndedTint, endedRailColor } from '../endedTint';

describe('blendEndedTint', () => {
  it('lightens a dark background toward neutral', () => {
    // round(0 + 128*0.13) = round(16.64) = 17 = 0x11
    expect(blendEndedTint('#000000')).toBe('#111111');
  });

  it('darkens a light background toward neutral', () => {
    // round(255 + (128-255)*0.13) = round(238.49) = 238 = 0xee
    expect(blendEndedTint('#ffffff')).toBe('#eeeeee');
  });

  it('blends each channel independently', () => {
    // r: round(253 + (128-253)*0.13) = 237 = 0xed
    // g: round(246 + (128-246)*0.13) = 231 = 0xe7
    // b: round(227 + (128-227)*0.13) = 214 = 0xd6
    expect(blendEndedTint('#fdf6e3')).toBe('#ede7d6');
  });

  it('is a wash, not a repaint', () => {
    expect(blendEndedTint('#1e1e1e')).toBe('#2b2b2b');
  });

  it('always returns a 7-char #RRGGBB — xterm rejects anything else', () => {
    for (const bg of ['#000000', '#ffffff', '#1e1e1e', '#fdf6e3']) {
      expect(blendEndedTint(bg)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('accepts uppercase hex', () => {
    expect(blendEndedTint('#FFFFFF')).toBe('#eeeeee');
  });

  it('accepts a custom alpha', () => {
    expect(blendEndedTint('#000000', 0)).toBe('#000000');
  });

  it('returns undefined for a background it cannot parse, rather than guessing', () => {
    expect(blendEndedTint('rgb(0,0,0)')).toBeUndefined();
    expect(blendEndedTint('')).toBeUndefined();
    expect(blendEndedTint('#fff')).toBeUndefined();
  });
});

describe('endedRailColor', () => {
  it('pushes much further from the background than the wash — the rail must read', () => {
    // round(0 + 128*0.55) = round(70.4) = 70 = 0x46
    expect(endedRailColor('#000000')).toBe('#464646');
    expect(endedRailColor('#000000')).not.toBe(blendEndedTint('#000000'));
  });

  it('reads on a light scheme too', () => {
    // round(255 + (128-255)*0.55) = round(185.15) = 185 = 0xb9
    expect(endedRailColor('#ffffff')).toBe('#b9b9b9');
  });

  it('returns undefined for an unparseable background', () => {
    expect(endedRailColor('rgb(0,0,0)')).toBeUndefined();
  });
});

/**
 * The CSS twin of this module's constants — `plan/024` Req 4.
 *
 * An ended session is drawn in three places now: xterm decorations (this module, in JS, because
 * xterm's `backgroundColor` takes `#RRGGBB` with no alpha), the pane overlay, and the Canvas
 * node. The last two are CSS, and they used to hard-code `rgba(128, 128, 128, 0.13)` — the pane
 * literally, the canvas about to copy it. Three copies of one colour is how a feature ends up
 * looking like two different features depending on where you meet it.
 *
 * There is now one CSS custom property, `--ended-wash`, and this asserts it still agrees with the
 * JS constants beside it. Neither file can see the other, and nothing else would notice them
 * drifting: a canvas node washed at a different alpha from the pane showing the same terminal is
 * a bug you can only find by looking at both at once.
 *
 * Parsed out of the stylesheet rather than read from a live `getComputedStyle`, because the value
 * has to be right in the SOURCE — a jsdom render would only prove the var resolves.
 */
describe('the ended wash is one colour across JS and CSS', () => {
  const THEME = readSource(
    path.resolve(__dirname, '../../components/LayoutManager.css'),
  );

  const declaredWash = (): { r: number; g: number; b: number; a: number } => {
    const m = /--ended-wash:\s*rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(THEME);
    if (!m) throw new Error('--ended-wash is not declared in LayoutManager.css, or its shape changed');
    return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] };
  };

  it('uses the same neutral grey this module blends toward', () => {
    const { r, g, b } = declaredWash();
    // NEUTRAL is 0x80 on all three channels — a grey, which is the property that matters.
    expect([r, g, b]).toEqual([0x80, 0x80, 0x80]);
  });

  /**
   * Derived from the module's own output rather than from a repeated literal: blending white
   * toward NEUTRAL at WASH_ALPHA and comparing against the same blend at the CSS alpha proves the
   * two numbers agree without either file naming the other's constant.
   */
  it('uses the same alpha', () => {
    const { a } = declaredWash();
    const white = '#ffffff';
    expect(blendEndedTint(white, a)).toBe(blendEndedTint(white));
    // The guard on the guard: the comparison must be able to fail.
    expect(blendEndedTint(white, a + 0.2)).not.toBe(blendEndedTint(white));
  });

  // Both stylesheets must actually CONSUME the variable — declaring it and leaving the literals
  // in place would satisfy every assertion above and change nothing on screen.
  it.each([
    ['the pane overlay', '../../components/Panes/TerminalPane.css', '.pane-ended-overlay'],
    ['the canvas node', '../../components/Canvas/Canvas.css', '.canvas-node.ended'],
  ])('%s reads the variable rather than repeating the colour', (_name, file, selector) => {
    const css = readSource(path.resolve(__dirname, file));
    expect(css).toContain('var(--ended-wash');
    expect(css).toContain(selector);
  });
});
