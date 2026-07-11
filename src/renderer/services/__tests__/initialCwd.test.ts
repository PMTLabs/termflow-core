import { setInitialCwd, takeInitialCwd } from '../initialCwd';

describe('initialCwd registry', () => {
  it('returns a stored cwd exactly once, then undefined', () => {
    setInitialCwd('tm-1', 'D:\\sources\\demo');
    expect(takeInitialCwd('tm-1')).toBe('D:\\sources\\demo');
    expect(takeInitialCwd('tm-1')).toBeUndefined();
  });

  it('returns undefined for an unknown id', () => {
    expect(takeInitialCwd('tm-unknown')).toBeUndefined();
  });
});
