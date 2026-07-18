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
