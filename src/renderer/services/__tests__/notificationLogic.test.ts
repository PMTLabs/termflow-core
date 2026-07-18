import { shouldNotify, NOTIF_SETTLE_MS } from '../notificationLogic';

describe('shouldNotify (notification startup/burst gate)', () => {
  it('suppresses an event whose causal output predates the startup settle window', () => {
    // Restore/TUI output at t=5s must not notify even though its Redux bell transition
    // (which lags ~2s behind the output) fires after a naive 4s wall-clock gate.
    expect(shouldNotify(5000, { settleUntil: 6000, burstUntil: 0 })).toBe(false);
  });

  it('suppresses an event whose causal output falls in a burst window', () => {
    expect(shouldNotify(10000, { settleUntil: 6000, burstUntil: 12000 })).toBe(false);
  });

  it('allows an event after settle and outside any burst', () => {
    expect(shouldNotify(7000, { settleUntil: 6000, burstUntil: 0 })).toBe(true);
  });

  it('compares against the CAUSAL time (boundary inclusive)', () => {
    expect(shouldNotify(6000, { settleUntil: 6000, burstUntil: 6000 })).toBe(true);
  });

  it('exposes a positive default stabilization window', () => {
    expect(NOTIF_SETTLE_MS).toBeGreaterThan(0);
  });
});
