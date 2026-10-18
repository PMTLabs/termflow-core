import { TAB_NAME_COLORS } from '../titleColor';

describe('TAB_NAME_COLORS palette', () => {
  it('holds the 20 preset colours in order', () => {
    expect(TAB_NAME_COLORS.map((c) => c.hex)).toEqual([
      '#FF2A2A', '#22C55E', '#2B7FFF', '#FFE600', '#FF7700',
      '#9D4EDD', '#00F0FF', '#FF2E93', '#A3FF00', '#0096C7',
      '#D97724', '#FF6B6B', '#B5B867', '#818CF8', '#FF85C0',
      '#8CE99A', '#E08AFF', '#FFCA80', '#94A3B8', '#F8FAFC',
    ]);
  });

  it('has unique hexes and non-empty names (both are used as React keys / tooltips)', () => {
    expect(new Set(TAB_NAME_COLORS.map((c) => c.hex)).size).toBe(TAB_NAME_COLORS.length);
    for (const c of TAB_NAME_COLORS) expect(c.name.trim()).not.toBe('');
  });
});
