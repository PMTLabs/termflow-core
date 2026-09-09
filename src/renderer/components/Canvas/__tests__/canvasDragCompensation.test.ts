import { spacingTransitionPan } from '../canvasDragCompensation';

describe('spacingTransitionPan', () => {
  it('would fail if the toRaw transition lost the negation required by panBy', () => {
    // Removing a +30/-12 world offset at z=3 moves the rect -90/+36 screen pixels. panBy
    // negates its input, so this must ask it for the opposite displacement.
    expect(spacingTransitionPan({ dx: 30, dy: -12 }, 3, 'toRaw')).toEqual({ dx: -90, dy: 36 });
  });

  it('would fail if the toDisplay transition did not restore the new live offset', () => {
    expect(spacingTransitionPan({ dx: 30, dy: -12 }, 3, 'toDisplay')).toEqual({ dx: 90, dy: -36 });
  });

  it('uses the supplied zoom for nonzero offsets across the real zoom range', () => {
    // A hard-coded `* 3` passes the fixtures above but fails both ends of the real range.
    expect(spacingTransitionPan({ dx: 7, dy: -4 }, 1, 'toRaw')).toEqual({ dx: -7, dy: 4 });
    const high = spacingTransitionPan({ dx: -4, dy: 7 }, 6.35, 'toDisplay');
    expect(high.dx).toBeCloseTo(-25.4);
    expect(high.dy).toBeCloseTo(44.45);
  });
});
