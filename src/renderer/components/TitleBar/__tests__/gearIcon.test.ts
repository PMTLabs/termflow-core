import fs from 'fs';
import path from 'path';

/**
 * The Settings gear must outgrow the window glyphs it sits beside.
 *
 * `TitleBar.css` sets `.window-control-btn svg { width: 12px }` for minimize/maximize/close,
 * which are 12-viewBox geometric glyphs. The gear is a 24-viewBox Feather-style icon — the same
 * family `SettingsPage`'s category nav uses — and rendered into 12px it is a smudge. The failure
 * is entirely silent: the button works, the icon is there, it is just illegible, and nobody
 * writes a bug report for "the gear looks a bit muddy".
 *
 * Derived from the stylesheet and the component rather than restated, because both halves can
 * drift independently: someone can change the base glyph size, or reauthor the gear at a
 * different viewBox, and either one alone re-breaks it.
 */

const dir = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(dir, 'TitleBar.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const GEAR = fs.readFileSync(path.join(dir, 'GearIcon.tsx'), 'utf8');
const BAR = fs.readFileSync(path.join(dir, 'TitleBar.tsx'), 'utf8');

const pxIn = (selector: string, prop: string): number => {
  const rule = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const body = rule.exec(CSS)?.[1];
  if (body === undefined) throw new Error(`no rule for "${selector}"`);
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(body);
  if (!m) throw new Error(`no ${prop} in "${selector}"`);
  return Number(m[1]);
};

describe('Settings gear sizing', () => {
  it('is authored at a 24 viewBox, like the other semantic icons', () => {
    expect(GEAR).toContain('viewBox="0 0 24 24"');
    // `currentColor` is what makes it inherit the button's hover/active/theme colour rather
    // than needing a rule per state.
    expect(GEAR).toContain('stroke="currentColor"');
  });

  it('overrides the 12px window-glyph size that would otherwise apply to it', () => {
    const glyph = pxIn('.window-control-btn svg', 'width');
    const gear = pxIn('.window-control-btn.settings svg', 'width');
    expect(gear).toBeGreaterThan(glyph);
    expect(pxIn('.window-control-btn.settings svg', 'height')).toBe(gear);
  });

  it('is rendered on BOTH platform paths, since macOS skips .window-controls entirely', () => {
    // macOS paints its own traffic lights and renders no minimize button, so the whole
    // `.window-controls` block is behind `!isMac`. A gear placed only inside it would simply
    // not exist on macOS — and nothing else in the suite would notice.
    const gears = BAR.match(/className="window-control-btn settings[^"]*"/g) ?? [];
    expect(gears).toHaveLength(2);
    expect(gears.some((c) => c.includes('is-mac'))).toBe(true);
    expect(gears.some((c) => !c.includes('is-mac'))).toBe(true);
  });

  it('carries an accessible name, since the icon has none', () => {
    // The svg is `aria-hidden`, so without this the button announces as unlabelled.
    expect(GEAR).toContain('aria-hidden="true"');
    expect(BAR).toContain('aria-label="Settings"');
  });
});
