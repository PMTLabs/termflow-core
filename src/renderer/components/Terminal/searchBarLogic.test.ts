import { formatMatchCount, isQueryValid } from './searchBarLogic';

describe('formatMatchCount', () => {
  it('shows "0 of 0" when there are no matches', () => {
    expect(formatMatchCount({ resultIndex: -1, resultCount: 0 })).toBe('0 of 0');
  });

  it('shows one-based index of count', () => {
    expect(formatMatchCount({ resultIndex: 0, resultCount: 5 })).toBe('1 of 5');
    expect(formatMatchCount({ resultIndex: 4, resultCount: 5 })).toBe('5 of 5');
  });

  it('guards a negative index when count is positive', () => {
    expect(formatMatchCount({ resultIndex: -1, resultCount: 3 })).toBe('0 of 3');
  });
});

describe('isQueryValid', () => {
  it('treats any non-empty plain query as valid', () => {
    expect(isQueryValid('foo', false)).toBe(true);
  });

  it('treats empty query as valid (it just clears)', () => {
    expect(isQueryValid('', false)).toBe(true);
    expect(isQueryValid('', true)).toBe(true);
  });

  it('validates regex syntax when regex mode is on', () => {
    expect(isQueryValid('foo.*bar', true)).toBe(true);
    expect(isQueryValid('foo(', true)).toBe(false);
    expect(isQueryValid('[a-z', true)).toBe(false);
  });
});
