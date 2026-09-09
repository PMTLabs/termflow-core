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

  it('keeps the zoom-1 identity transition inert', () => {
    expect(spacingTransitionPan({ dx: 0, dy: 0 }, 1, 'toRaw')).toEqual({ dx: 0, dy: 0 });
    expect(spacingTransitionPan({ dx: 0, dy: 0 }, 1, 'toDisplay')).toEqual({ dx: 0, dy: 0 });
  });
});
