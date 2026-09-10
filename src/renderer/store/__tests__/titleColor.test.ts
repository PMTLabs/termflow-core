import { tabTitleColor, terminalTitleColor, titleColorStyle } from '../titleColor';

const RED = '#ff5f56';
const GREEN = '#27c93f';

/**
 * `tb-a` is a SPLIT of two panes and `tb-b` a single terminal, so the terminal lookup has to walk
 * a nested tree in one case and a bare leaf in the other — the two shapes that broke
 * `findTabIdByTerminalId`'s predecessor.
 */
const state = () => ({
  tabs: {
    tabs: [
      { id: 'tb-a', title: 'api', titleColor: RED },
      { id: 'tb-b', title: 'web', titleColor: GREEN },
      { id: 'tb-c', title: 'plain' },
    ],
  },
  panes: {
    treesByTabId: {
      'tb-a': {
        id: 'pn-1', type: 'split', direction: 'horizontal', children: [
          { id: 'pn-2', type: 'terminal', terminalId: 'tm-1', name: 'server' },
          { id: 'pn-3', type: 'terminal', terminalId: 'tm-2', name: 'worker' },
        ],
      },
      'tb-b': { id: 'pn-4', type: 'terminal', terminalId: 'tm-3', name: 'vite' },
      'tb-c': { id: 'pn-5', type: 'terminal', terminalId: 'tm-4', name: 'shell' },
    },
  },
}) as never;

describe('tabTitleColor', () => {
  it('reads each tab\'s own colour, and nothing for a tab without one', () => {
    expect(tabTitleColor(state(), 'tb-a')).toBe(RED);
    // A second, DIFFERENT colour: a selector returning one constant passes a single-tab check.
    expect(tabTitleColor(state(), 'tb-b')).toBe(GREEN);
    expect(tabTitleColor(state(), 'tb-c')).toBeUndefined();
  });

  it('is undefined for a missing or absent tab id rather than throwing', () => {
    expect(tabTitleColor(state(), undefined)).toBeUndefined();
    expect(tabTitleColor(state(), 'tb-gone')).toBeUndefined();
  });
});

describe('terminalTitleColor', () => {
  it('resolves a terminal to its OWNING tab\'s colour, through a split and a bare leaf', () => {
    // Both panes of the split tab, so this cannot pass by matching only the first leaf.
    expect(terminalTitleColor(state(), 'tm-1')).toBe(RED);
    expect(terminalTitleColor(state(), 'tm-2')).toBe(RED);
    // A different tab AND a different colour.
    expect(terminalTitleColor(state(), 'tm-3')).toBe(GREEN);
  });

  it('is undefined for a terminal whose tab has no colour, and for an unknown terminal', () => {
    expect(terminalTitleColor(state(), 'tm-4')).toBeUndefined();
    expect(terminalTitleColor(state(), 'tm-gone')).toBeUndefined();
    expect(terminalTitleColor(state(), undefined)).toBeUndefined();
  });
});

describe('titleColorStyle', () => {
  /**
   * The single home for the "omit the property entirely" rule. Every title surface depends on it:
   * emitting `{ color: undefined }` would still be an inline style object, and the point is that
   * an uncoloured tab leaves the stylesheet in charge.
   */
  it('yields a style object only when there is a colour', () => {
    expect(titleColorStyle(RED)).toEqual({ color: RED });
    expect(titleColorStyle(undefined)).toBeUndefined();
    // An empty string is not a colour; treating it as one would emit `color: ""`.
    expect(titleColorStyle('')).toBeUndefined();
  });
});
