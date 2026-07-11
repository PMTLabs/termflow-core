import { decideCtrlC, isCtrlCBurst } from '../TerminalEngine';

describe('decideCtrlC', () => {
  it('copies when smart routing is enabled and text is selected', () => {
    expect(decideCtrlC(true, true)).toBe('copy');
  });
  it('sends SIGINT when nothing is selected', () => {
    expect(decideCtrlC(false, true)).toBe('sigint');
  });
  it('sends SIGINT when smart routing is disabled, even with a selection', () => {
    expect(decideCtrlC(true, false)).toBe('sigint');
  });
});

describe('isCtrlCBurst', () => {
  it('is false for fewer than 3 presses', () => {
    expect(isCtrlCBurst([1000, 1500], 1600)).toBe(false);
  });
  it('is true for 3 presses within the 2s window', () => {
    expect(isCtrlCBurst([1000, 1500, 2000], 2000)).toBe(true);
  });
  it('ignores presses older than the window', () => {
    // The first press is 2.1s before `now`, so only 2 recent presses remain.
    expect(isCtrlCBurst([1000, 3000, 3050], 3100)).toBe(false);
  });
  it('counts 3 rapid presses spread across <2s as a burst', () => {
    expect(isCtrlCBurst([5000, 5800, 6900], 6900)).toBe(true);
  });
});
