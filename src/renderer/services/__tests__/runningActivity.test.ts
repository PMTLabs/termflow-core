import {
  isRunningFromEvents,
  computeRunningTabIds,
  computeUnseenUpdate,
  isEchoChunk,
  isSubmitInput,
  shouldCountForRunning,
  WINDOW_MS,
  MIN_CHUNKS,
  MIN_BYTES,
  ECHO_WINDOW_MS,
  ECHO_MAX_BYTES,
} from '../runningActivity';

const opts = { windowMs: WINDOW_MS, minChunks: MIN_CHUNKS, minBytes: MIN_BYTES };

describe('isRunningFromEvents', () => {
  it('is running for a fast spinner-rate stream (>= MIN_CHUNKS in window)', () => {
    const events = [100, 200, 300, 400, 500, 600].map(t => ({ t, bytes: 4 }));
    expect(isRunningFromEvents(events, 1000, opts)).toBe(true);
  });

  it('is idle for a ~1/sec status-line clock (below thresholds)', () => {
    const events = [{ t: 0, bytes: 8 }, { t: 1000, bytes: 8 }, { t: 2000, bytes: 8 }];
    // window [1500,2500] contains only the t=2000 event → 1 chunk, 8 bytes
    expect(isRunningFromEvents(events, 2500, opts)).toBe(false);
  });

  it('is running for a single large chunk (>= MIN_BYTES)', () => {
    expect(isRunningFromEvents([{ t: 900, bytes: 600 }], 1000, opts)).toBe(true);
  });

  it('is idle once the window has drained after a burst (hysteresis stop)', () => {
    const events = [0, 100, 200, 300, 400].map(t => ({ t, bytes: 4 }));
    // now=1500, window [500,1500] contains none → idle
    expect(isRunningFromEvents(events, 1500, opts)).toBe(false);
  });

  it('is idle for no events', () => {
    expect(isRunningFromEvents([], 1000, opts)).toBe(false);
  });

  it('includes an event exactly at the window boundary (t == now - windowMs)', () => {
    // cutoff = 1000 - 1000 = 0; the t=0 event is included (left-closed window).
    expect(isRunningFromEvents([{ t: 0, bytes: 600 }], 1000, opts)).toBe(true);
  });
});

describe('computeRunningTabIds', () => {
  it('maps running processes to tabs and de-duplicates same-tab terminals', () => {
    const resolve = (pid: string) => (pid === 'p1' || pid === 'p2' ? 'tb-1' : 'tb-2');
    expect(computeRunningTabIds(['p1', 'p2'], resolve).sort()).toEqual(['tb-1']);
  });

  it('drops processes with no owning tab (resolver returns null)', () => {
    const resolve = (pid: string) => (pid === 'p1' ? 'tb-1' : null);
    expect(computeRunningTabIds(['p1', 'p2'], resolve)).toEqual(['tb-1']);
  });

  it('includes multiple distinct tabs', () => {
    const resolve = (pid: string) => (pid === 'p1' ? 'tb-1' : 'tb-2');
    expect(computeRunningTabIds(['p1', 'p2'], resolve).sort()).toEqual(['tb-1', 'tb-2']);
  });
});

describe('computeUnseenUpdate', () => {
  const resolve = (pid: string) =>
    pid === 'p1' ? 'tb-1' : pid === 'p2' ? 'tb-2' : null;
  const out = (processId: string, newest: number) => ({ processId, newest });
  const DEBOUNCE = 2000;
  // `now` far enough past the small fixture timestamps that they count as settled.
  const SETTLED_NOW = 10000;

  it('flags inactive tabs that produced new (settled) output and advances their marks', () => {
    const { toFlag, marks } = computeUnseenUpdate(
      [out('p1', 100), out('p2', 200)], resolve, null, new Set(), new Map(), SETTLED_NOW, DEBOUNCE);
    expect(toFlag.sort()).toEqual(['tb-1', 'tb-2']);
    expect(marks.get('p1')).toBe(100);
    expect(marks.get('p2')).toBe(200);
  });

  it('does NOT flag while output is still streaming (within the debounce window)', () => {
    // newest is only 500ms old (< DEBOUNCE) → still settling, must not flag or advance.
    const { toFlag, marks } = computeUnseenUpdate(
      [out('p1', 9500)], resolve, null, new Set(), new Map(), SETTLED_NOW, DEBOUNCE);
    expect(toFlag).toEqual([]);
    expect(marks.has('p1')).toBe(false); // not advanced → retried once it settles
  });

  it('flags once output has been idle for the debounce threshold', () => {
    // newest exactly DEBOUNCE old → settled (now - newest === DEBOUNCE).
    const { toFlag } = computeUnseenUpdate(
      [out('p1', SETTLED_NOW - DEBOUNCE)], resolve, null, new Set(), new Map(), SETTLED_NOW, DEBOUNCE);
    expect(toFlag).toEqual(['tb-1']);
  });

  it('keeps waiting across ticks until fresh output stops resetting the debounce', () => {
    // Tick 1: last output 9800, now 10000 → 200ms old → not settled.
    let res = computeUnseenUpdate(
      [out('p1', 9800)], resolve, null, new Set(), new Map(), 10000, DEBOUNCE);
    expect(res.toFlag).toEqual([]);
    // Tick 2: same last output 9800, now 11801 → 2001ms old → settled → flag.
    res = computeUnseenUpdate(
      [out('p1', 9800)], resolve, null, new Set(), res.marks, 11801, DEBOUNCE);
    expect(res.toFlag).toEqual(['tb-1']);
  });

  it('skips the active tab but still advances its mark (output seen live)', () => {
    const { toFlag, marks } = computeUnseenUpdate(
      [out('p1', 100), out('p2', 200)], resolve, 'tb-2', new Set(), new Map(), SETTLED_NOW, DEBOUNCE);
    expect(toFlag).toEqual(['tb-1']);
    // tb-2 was active → not flagged, but its mark advances so the same output
    // never re-flags it later once the user switches away.
    expect(marks.get('p2')).toBe(200);
  });

  it('skips tabs already flagged unseen (no redundant re-dispatch)', () => {
    const { toFlag } = computeUnseenUpdate(
      [out('p1', 100), out('p2', 200)], resolve, null, new Set(['tb-1']), new Map(), SETTLED_NOW, DEBOUNCE);
    expect(toFlag).toEqual(['tb-2']);
  });

  it('does not re-flag when the newest output is not newer than the mark', () => {
    const marks = new Map([['p1', 100]]);
    const { toFlag } = computeUnseenUpdate(
      [out('p1', 100)], resolve, null, new Set(), marks, SETTLED_NOW, DEBOUNCE);
    expect(toFlag).toEqual([]);
  });

  it('flags again only when genuinely newer (settled) output arrives', () => {
    const marks = new Map([['p1', 100]]);
    const { toFlag, marks: next } = computeUnseenUpdate(
      [out('p1', 150)], resolve, null, new Set(), marks, SETTLED_NOW, DEBOUNCE);
    expect(toFlag).toEqual(['tb-1']);
    expect(next.get('p1')).toBe(150);
  });

  it('leaves unresolved processes un-marked so a later tick retries (late seeding)', () => {
    const notReady = (_pid: string) => null;
    const { toFlag, marks } = computeUnseenUpdate(
      [out('p1', 100)], notReady, null, new Set(), new Map(), SETTLED_NOW, DEBOUNCE);
    expect(toFlag).toEqual([]);
    expect(marks.has('p1')).toBe(false); // not advanced → retried next tick
  });

  it('de-duplicates multiple processes of the same tab', () => {
    const sameTab = (_pid: string) => 'tb-1';
    const { toFlag } = computeUnseenUpdate(
      [out('p1', 100), out('p2', 200)], sameTab, null, new Set(), new Map(), SETTLED_NOW, DEBOUNCE);
    expect(toFlag).toEqual(['tb-1']);
  });

  it('does not mutate the passed-in marks map', () => {
    const marks = new Map<string, number>();
    computeUnseenUpdate([out('p1', 100)], resolve, null, new Set(), marks, SETTLED_NOW, DEBOUNCE);
    expect(marks.size).toBe(0);
  });
});

describe('isEchoChunk (typing echo detection)', () => {
  it('treats a small chunk right after a keystroke as echo', () => {
    expect(isEchoChunk(1, 10)).toBe(true);
    expect(isEchoChunk(ECHO_MAX_BYTES, ECHO_WINDOW_MS - 1)).toBe(true);
  });
  it('is not echo when the chunk is larger than the echo size', () => {
    expect(isEchoChunk(ECHO_MAX_BYTES + 1, 10)).toBe(false);
  });
  it('includes both inclusive boundaries exactly (window and size are <=)', () => {
    expect(isEchoChunk(ECHO_MAX_BYTES, ECHO_WINDOW_MS)).toBe(true); // exactly 48B @ exactly 250ms
    expect(isEchoChunk(1, ECHO_WINDOW_MS)).toBe(true);
  });
  it('is not echo when it arrives after the echo window', () => {
    expect(isEchoChunk(1, ECHO_WINDOW_MS + 1)).toBe(false);
  });
  it('is not echo when there was no recent input (Infinity gap)', () => {
    expect(isEchoChunk(1, Infinity)).toBe(false);
  });
});

describe('isSubmitInput (Enter detection)', () => {
  it('recognizes bare Enter variants as a submit', () => {
    ['\r', '\n', '\r\n'].forEach(d => expect(isSubmitInput(d)).toBe(true));
  });
  it('printable typed text is not a submit', () => {
    expect(isSubmitInput('l')).toBe(false);
    expect(isSubmitInput('ls')).toBe(false);
  });
  it('a multi-char paste (even containing a newline) is not a bare submit', () => {
    expect(isSubmitInput('a\r\nb')).toBe(false);
  });
});

describe('shouldCountForRunning (echo excluded from the running-rate buffer)', () => {
  it('excludes an echo-sized chunk arriving right after a keystroke', () => {
    expect(shouldCountForRunning(1, 1000, 995)).toBe(false); // 5ms after input, tiny
  });
  it('counts real output that arrives long after the last keystroke', () => {
    expect(shouldCountForRunning(4, 1000, 1000 - (ECHO_WINDOW_MS + 1))).toBe(true);
  });
  it('counts a large chunk even right after a keystroke (not echo-sized)', () => {
    expect(shouldCountForRunning(ECHO_MAX_BYTES + 1, 1000, 1000)).toBe(true);
  });
  it('counts output after a submit (lastInputAt reset to -Infinity)', () => {
    expect(shouldCountForRunning(4, 1000, -Infinity)).toBe(true);
  });
});
