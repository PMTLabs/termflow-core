import { moveSelection, placePopup } from './suggestLogic';

describe('moveSelection', () => {
  it('clamps at both ends', () => {
    expect(moveSelection(3, 0, 'up')).toBe(0);
    expect(moveSelection(3, 2, 'down')).toBe(2);
  });
  it('moves within range', () => {
    expect(moveSelection(3, 0, 'down')).toBe(1);
    expect(moveSelection(3, 2, 'up')).toBe(1);
  });
  it('empty list pins to 0', () => {
    expect(moveSelection(0, 5, 'down')).toBe(0);
  });
});

describe('placePopup', () => {
  const anchor = { left: 100, top: 40, cellHeight: 20 };
  it('places below the cursor line when it fits', () => {
    expect(placePopup(anchor, 200, 100, 800, 600)).toEqual({ left: 100, top: 62 });
  });
  it('flips above the cursor when below overflows', () => {
    expect(placePopup(anchor, 200, 100, 800, 120)).toEqual({ left: 100, top: 0 });
  });
  it('clamps left so the popup stays inside the pane', () => {
    expect(placePopup({ ...anchor, left: 700 }, 200, 100, 800, 600).left).toBe(600);
  });
  it('null anchor falls back to bottom-left', () => {
    expect(placePopup(null, 200, 100, 800, 600)).toEqual({ left: 8, top: 492 });
  });
});
