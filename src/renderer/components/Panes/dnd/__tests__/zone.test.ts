import { computeZone } from '../zone';

const rect = { left: 0, top: 0, width: 100, height: 100 };

describe('computeZone (30% edge bands)', () => {
  it('center', () => expect(computeZone(rect, 50, 50)).toBe('center'));
  it('left', () => expect(computeZone(rect, 10, 50)).toBe('left'));
  it('right', () => expect(computeZone(rect, 90, 50)).toBe('right'));
  it('top', () => expect(computeZone(rect, 50, 10)).toBe('top'));
  it('bottom', () => expect(computeZone(rect, 50, 90)).toBe('bottom'));
  it('corner resolves to nearest edge (left beats top at 10,15)', () =>
    expect(computeZone(rect, 10, 15)).toBe('left'));
  it('respects rect offset', () =>
    expect(computeZone({ left: 200, top: 0, width: 100, height: 100 }, 290, 50)).toBe('right'));
});
