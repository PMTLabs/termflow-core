import {
  parseEntry,
  sumOthers,
  headroom,
  selfKey,
  setLedgerWindowId,
  publishOwnUsage,
  otherWindowsUsage,
  clearOwnUsage,
  resetLedgerForTests,
  startLedgerHeartbeat,
  HEARTBEAT_MS,
  LEDGER_PREFIX,
  STALE_MS,
  GLOBAL_WEBGL_CEILING,
} from '../webglLedger';

/**
 * The ledger's whole job is to answer "may this window take one more WebGL context?"
 * against a ceiling the browser enforces by EVICTION rather than refusal — so a wrong
 * answer is silent in both directions, and only one of them is safe.
 *
 * Over-count a sibling  -> this window paints on the DOM renderer. Slower, correct.
 * Under-count a sibling -> this window takes a context that kills a live terminal's.
 *
 * Every test below is written to pin that asymmetry, not just the arithmetic.
 */

afterEach(() => {
  resetLedgerForTests();
  localStorage.clear();
});

describe('parseEntry', () => {
  it('reads a well-formed entry', () => {
    expect(parseEntry('{"n":3,"ts":1000}')).toEqual({ n: 3, ts: 1000 });
  });

  // Written by a DIFFERENT PROCESS, possibly a different version, possibly mid-write.
  // A throw here would land in the render-policy path.
  it.each([
    ['null input', null],
    ['empty', ''],
    ['not json', '{oops'],
    ['not an object', '42'],
    ['missing ts', '{"n":3}'],
    ['missing n', '{"ts":3}'],
    ['n not a number', '{"n":"3","ts":1}'],
    ['negative n', '{"n":-2,"ts":1}'],
    ['NaN', '{"n":null,"ts":1}'],
  ])('rejects %s without throwing', (_label, raw) => {
    expect(parseEntry(raw as string | null)).toBeNull();
  });

  it('floors a fractional count rather than trusting it', () => {
    expect(parseEntry('{"n":2.9,"ts":1}')).toEqual({ n: 2, ts: 1 });
  });
});

describe('sumOthers', () => {
  const now = 100_000;
  const fresh = (n: number) => JSON.stringify({ n, ts: now - 1000 });

  it('adds up every other window', () => {
    const entries = [
      [`${LEDGER_PREFIX}a`, fresh(4)],
      [`${LEDGER_PREFIX}b`, fresh(5)],
    ] as const;
    expect(sumOthers(entries, `${LEDGER_PREFIX}self`, now)).toBe(9);
  });

  it('excludes this window, which is counted directly instead', () => {
    const entries = [
      [`${LEDGER_PREFIX}self`, fresh(12)],
      [`${LEDGER_PREFIX}b`, fresh(2)],
    ] as const;
    expect(sumOthers(entries, `${LEDGER_PREFIX}self`, now)).toBe(2);
  });

  it('ignores keys that are not ours', () => {
    const entries = [
      ['auto-terminal-state', fresh(99)],
      [`${LEDGER_PREFIX}b`, fresh(3)],
    ] as const;
    expect(sumOthers(entries, `${LEDGER_PREFIX}self`, now)).toBe(3);
  });

  // A window that stopped heartbeating is GONE, and its contexts died with it. This is the
  // one place staleness moves towards under-counting, so the heartbeat is what keeps a live
  // holder out of it.
  it('drops an entry that has gone stale', () => {
    const entries = [[`${LEDGER_PREFIX}dead`, JSON.stringify({ n: 8, ts: now - STALE_MS - 1 })]] as const;
    expect(sumOthers(entries, `${LEDGER_PREFIX}self`, now)).toBe(0);
  });

  it('keeps an entry right at the staleness boundary', () => {
    const entries = [[`${LEDGER_PREFIX}live`, JSON.stringify({ n: 8, ts: now - STALE_MS })]] as const;
    expect(sumOthers(entries, `${LEDGER_PREFIX}self`, now)).toBe(8);
  });

  // Processes do not share a clock. A sibling whose ts is slightly in the future is the
  // freshest possible entry, not an invalid one.
  it('trusts an entry with a future timestamp (clock skew between processes)', () => {
    const entries = [[`${LEDGER_PREFIX}skew`, JSON.stringify({ n: 6, ts: now + 5000 })]] as const;
    expect(sumOthers(entries, `${LEDGER_PREFIX}self`, now)).toBe(6);
  });

  /**
   * THE ASYMMETRY. A sibling wrote something we cannot read — a newer schema, a truncated
   * write. It is still holding contexts. Scoring it 0 is the mistake that evicts a live
   * terminal, so an unreadable entry costs us budget rather than being free.
   */
  it('charges for an unparseable sibling instead of treating it as absent', () => {
    const entries = [[`${LEDGER_PREFIX}weird`, '{not-json']] as const;
    expect(sumOthers(entries, `${LEDGER_PREFIX}self`, now)).toBe(1);
    expect(sumOthers(entries, `${LEDGER_PREFIX}self`, now, STALE_MS, 3)).toBe(3);
  });
});

describe('headroom', () => {
  it('is what is left of the ceiling after everyone is counted', () => {
    expect(headroom(4, 5, 16)).toBe(7);
  });

  it('never goes negative, so an overrun reads as "no room" not "room"', () => {
    expect(headroom(12, 12, 16)).toBe(0);
  });

  it('defaults to the measured browser ceiling', () => {
    expect(headroom(0, 0)).toBe(GLOBAL_WEBGL_CEILING);
  });
});

describe('storage shell', () => {
  it('is inert until this window has an identity', () => {
    expect(selfKey()).toBeNull();
    publishOwnUsage(5);
    expect(localStorage.length).toBe(0);
    expect(otherWindowsUsage()).toBe(0);
  });

  it('publishes under a namespaced key once named', () => {
    setLedgerWindowId('rel#w0');
    publishOwnUsage(3);
    expect(selfKey()).toBe(`${LEDGER_PREFIX}rel#w0`);
    expect(parseEntry(localStorage.getItem(`${LEDGER_PREFIX}rel#w0`))!.n).toBe(3);
  });

  it('sums siblings while excluding itself', () => {
    setLedgerWindowId('rel#w0');
    publishOwnUsage(3);
    localStorage.setItem(`${LEDGER_PREFIX}rel.alt#w0`, JSON.stringify({ n: 6, ts: Date.now() }));
    expect(otherWindowsUsage()).toBe(6);
  });

  // The heartbeat's entire purpose is refreshing `ts` when `n` has NOT moved; without the
  // force flag the skip would make a live holder age into staleness and be discounted.
  it('re-publishes an unchanged count only when forced', () => {
    setLedgerWindowId('rel#w0');
    publishOwnUsage(2);
    const first = localStorage.getItem(`${LEDGER_PREFIX}rel#w0`);
    publishOwnUsage(2);
    expect(localStorage.getItem(`${LEDGER_PREFIX}rel#w0`)).toBe(first);
    publishOwnUsage(2, true);
    expect(parseEntry(localStorage.getItem(`${LEDGER_PREFIX}rel#w0`))!.n).toBe(2);
  });

  it('clears its entry on teardown so siblings reclaim the budget at once', () => {
    setLedgerWindowId('rel#w0');
    publishOwnUsage(4);
    expect(localStorage.getItem(`${LEDGER_PREFIX}rel#w0`)).not.toBeNull();
    clearOwnUsage();
    expect(localStorage.getItem(`${LEDGER_PREFIX}rel#w0`)).toBeNull();
  });

  it('heartbeats a live holder but stays silent when it holds nothing', () => {
    jest.useFakeTimers();
    try {
      setLedgerWindowId('rel#w0');
      let count = 0;
      startLedgerHeartbeat(() => count);

      // Holds nothing: an absent entry and a zero entry both sum to 0 for siblings, so a
      // write here would be pure noise every HEARTBEAT_MS for the life of the process.
      jest.advanceTimersByTime(HEARTBEAT_MS * 3);
      expect(localStorage.getItem(`${LEDGER_PREFIX}rel#w0`)).toBeNull();

      // Holds contexts: the refresh is load-bearing. Without it the entry ages past
      // STALE_MS, siblings discount a window that is really holding contexts, and one of
      // them takes a context that evicts a live terminal's.
      count = 5;
      jest.advanceTimersByTime(HEARTBEAT_MS);
      expect(parseEntry(localStorage.getItem(`${LEDGER_PREFIX}rel#w0`))!.n).toBe(5);
    } finally {
      jest.useRealTimers();
    }
  });

  // After clearOwnUsage the cached "last published" must reset too, or the next publish of
  // the same count would be skipped and this window would stay invisible to its siblings.
  it('re-publishes the same count after a clear', () => {
    setLedgerWindowId('rel#w0');
    publishOwnUsage(4);
    clearOwnUsage();
    publishOwnUsage(4);
    expect(parseEntry(localStorage.getItem(`${LEDGER_PREFIX}rel#w0`))!.n).toBe(4);
  });
});
