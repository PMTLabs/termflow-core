import {
  isRunningFromEvents,
  computeRunningTabIds,
  computeRunningTerminalIds,
  computeUnseenUpdate,
  canvasIsShowing,
  overlaySuppressedTerminal,
  isEchoChunk,
  isSubmitInput,
  shouldCountForRunning,
  WINDOW_MS,
  MIN_CHUNKS,
  MIN_BYTES,
  ECHO_WINDOW_MS,
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

/**
 * The per-PANE sibling of `computeRunningTabIds` — Req 8 (plan/020 §2). Stops one resolution
 * step earlier (processId -> terminalId, not all the way to tabId), so a two-pane tab with
 * only one pane busy can say exactly which one.
 */
describe('computeRunningTerminalIds', () => {
  it('two panes of one tab, only one busy -> exactly one terminalId returned', () => {
    // Both p1 and p2 belong to tab tb-1 (one two-pane tab), but only p1 is producing output.
    const resolveTerminal = (pid: string) => (pid === 'p1' ? 'tm-1' : pid === 'p2' ? 'tm-2' : null);
    expect(computeRunningTerminalIds(['p1'], resolveTerminal)).toEqual(['tm-1']);
  });

  it('drops processIds that do not resolve to a terminal', () => {
    const resolveTerminal = (pid: string) => (pid === 'p1' ? 'tm-1' : null);
    expect(computeRunningTerminalIds(['p1', 'p2'], resolveTerminal)).toEqual(['tm-1']);
  });

  it('de-duplicates when the same terminal is reported twice', () => {
    const resolveTerminal = () => 'tm-1';
    expect(computeRunningTerminalIds(['p1', 'p2'], resolveTerminal)).toEqual(['tm-1']);
  });

  it('includes multiple distinct terminals', () => {
    const resolveTerminal = (pid: string) => (pid === 'p1' ? 'tm-1' : 'tm-2');
    expect(computeRunningTerminalIds(['p1', 'p2'], resolveTerminal).sort()).toEqual(['tm-1', 'tm-2']);
  });

  it('returns nothing for an empty input', () => {
    expect(computeRunningTerminalIds([], () => 'tm-1')).toEqual([]);
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

  describe('mute (isSourceMuted)', () => {
    it('does NOT flag a muted source but STILL advances its mark (no backlog ring on unmute)', () => {
      const mutedTab = (_pid: string, tabId: string) => tabId === 'tb-1';
      const { toFlag, marks } = computeUnseenUpdate(
        [out('p1', 100)], resolve, null, new Set(), new Map(), SETTLED_NOW, DEBOUNCE, mutedTab);
      expect(toFlag).toEqual([]);
      // Mark advanced so this same output can never ring once the tab is unmuted.
      expect(marks.get('p1')).toBe(100);
    });

    it('suppresses only the muted source; an unmuted sibling tab still flags', () => {
      const mutedTab = (_pid: string, tabId: string) => tabId === 'tb-1';
      const { toFlag } = computeUnseenUpdate(
        [out('p1', 100), out('p2', 200)], resolve, null, new Set(), new Map(), SETTLED_NOW, DEBOUNCE, mutedTab);
      // p1 → tb-1 (muted) suppressed; p2 → tb-2 (unmuted) still flags.
      expect(toFlag).toEqual(['tb-2']);
    });

    it('pane-level: two processes of the SAME tab, only the muted pane is suppressed', () => {
      // p1 and p2 both resolve to tb-1; the predicate mutes only p1 (per-pane).
      const sameTab = (_pid: string) => 'tb-1';
      const mutedPane = (pid: string, _tabId: string) => pid === 'p1';
      const { toFlag } = computeUnseenUpdate(
        [out('p1', 100), out('p2', 200)], sameTab, null, new Set(), new Map(), SETTLED_NOW, DEBOUNCE, mutedPane);
      // p1 (muted pane) suppressed, but p2 (unmuted sibling) still flags the tab.
      expect(toFlag).toEqual(['tb-1']);
    });

    it('when ALL of a tab\'s sources are muted, the tab is silent', () => {
      const sameTab = (_pid: string) => 'tb-1';
      const allMuted = () => true;
      const { toFlag, marks } = computeUnseenUpdate(
        [out('p1', 100), out('p2', 200)], sameTab, null, new Set(), new Map(), SETTLED_NOW, DEBOUNCE, allMuted);
      expect(toFlag).toEqual([]);
      // marks still advance for both so nothing rings on unmute.
      expect(marks.get('p1')).toBe(100);
      expect(marks.get('p2')).toBe(200);
    });

    it('defaults to un-muted when no predicate is supplied (back-compat)', () => {
      const { toFlag } = computeUnseenUpdate(
        [out('p1', 100)], resolve, null, new Set(), new Map(), SETTLED_NOW, DEBOUNCE);
      expect(toFlag).toEqual(['tb-1']);
    });
  });
});

describe('isEchoChunk (typing echo / line-repaint detection)', () => {
  it('treats output right after a keystroke as echo, regardless of size', () => {
    expect(isEchoChunk(10)).toBe(true);
    expect(isEchoChunk(ECHO_WINDOW_MS - 1)).toBe(true);
    // A large PSReadLine line-repaint landing in the window is STILL echo (no size cap).
    expect(isEchoChunk(0)).toBe(true);
  });
  it('includes the window boundary exactly (<=)', () => {
    expect(isEchoChunk(ECHO_WINDOW_MS)).toBe(true); // exactly 250ms after the keystroke
  });
  it('is not echo when it arrives after the echo window', () => {
    expect(isEchoChunk(ECHO_WINDOW_MS + 1)).toBe(false);
  });
  it('is not echo when there was no recent input (Infinity gap)', () => {
    expect(isEchoChunk(Infinity)).toBe(false);
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

describe('shouldCountForRunning (echo/line-repaint excluded from the running-rate buffer)', () => {
  it('excludes a chunk arriving right after a keystroke', () => {
    expect(shouldCountForRunning(1000, 995)).toBe(false); // 5ms after input
  });
  it('excludes a LARGE chunk right after a keystroke (PSReadLine line-repaint, not real output)', () => {
    expect(shouldCountForRunning(1000, 1000)).toBe(false); // 0ms after input, any size
  });
  it('counts real output that arrives long after the last keystroke', () => {
    expect(shouldCountForRunning(1000, 1000 - (ECHO_WINDOW_MS + 1))).toBe(true);
  });
  it('counts output after a submit (lastInputAt reset to -Infinity)', () => {
    expect(shouldCountForRunning(1000, -Infinity)).toBe(true);
  });
});

describe('canvasIsShowing — the D1a notification regression', () => {
  // Local copies: the fixtures above are scoped to the `computeUnseenUpdate` describe.
  const out = (processId: string, newest: number) => ({ processId, newest });
  const DEBOUNCE = 2000;
  const SETTLED_NOW = 10000;
  const tabs = [
    { id: 'tb-work', shellType: 'pwsh' },
    { id: 'tb-canvas', shellType: 'canvas' },
    { id: 'tb-settings', shellType: 'settings' },
  ];

  it('is true only while the CANVAS tab is the active one', () => {
    expect(canvasIsShowing(tabs, 'tb-canvas')).toBe(true);
    expect(canvasIsShowing(tabs, 'tb-work')).toBe(false);
    // Settings is also a virtual tab, and it is NOT the canvas: it shows no terminals at all,
    // so output behind it really is unseen and must keep ringing.
    expect(canvasIsShowing(tabs, 'tb-settings')).toBe(false);
  });

  it('is false with no active tab, and for an id that is not in the list', () => {
    expect(canvasIsShowing(tabs, null)).toBe(false);
    expect(canvasIsShowing(tabs, 'tb-gone')).toBe(false);
    expect(canvasIsShowing([], 'tb-canvas')).toBe(false);
  });

  /**
   * The SUPPRESSION MECHANISM, stated end to end: a suppressed source is not flagged, but its
   * mark still advances so the same output cannot ring in arrears once suppression lifts.
   *
   * The predicate here is a stand-in (`() => true`), and deliberately so — WHICH sources are
   * suppressed is the caller's business, and it has changed: `canvasIsShowing` was briefly the
   * whole answer, which silenced every terminal for as long as the canvas stayed open
   * (`plan/021` R3). See `overlaySuppressedTerminal` below for the rule that replaced it. The
   * mechanism this exercises is unaffected either way.
   */
  it('flags nothing while the canvas is up, but still accounts for the output', () => {
    const resolve = () => 'tb-work';
    const marks = new Map<string, number>();
    const suppressed = computeUnseenUpdate(
      [out('p1', 100)], resolve, 'tb-canvas', new Set(), marks, SETTLED_NOW, DEBOUNCE,
      () => true,
    );
    expect(suppressed.toFlag).toEqual([]);
    expect(suppressed.marks.get('p1')).toBe(100);

    // Leaving the canvas must not then ring for output already watched go by.
    const after = computeUnseenUpdate(
      [out('p1', 100)], resolve, 'tb-work2', new Set(), suppressed.marks, SETTLED_NOW, DEBOUNCE,
    );
    expect(after.toFlag).toEqual([]);
  });

  it('still flags normally once the canvas is not the active tab', () => {
    // Paired with the case above so "never flags" cannot pass both.
    const { toFlag } = computeUnseenUpdate(
      [out('p1', 100)], () => 'tb-work', 'tb-other', new Set(), new Map(), SETTLED_NOW, DEBOUNCE,
      () => false,
    );
    expect(toFlag).toEqual(['tb-work']);
  });
});

/**
 * `plan/021` R3 + R4 — how wide the canvas suppression is allowed to be.
 *
 * R3 was the blackout: "the canvas tab is active" suppressed every terminal in the window.
 * R4 is the replacement: exactly the one terminal shown in the overlay at 1:1.
 */
describe('overlaySuppressedTerminal', () => {
  const tabs = [
    { id: 'tb-work', shellType: 'pwsh' },
    { id: 'tb-canvas', shellType: 'canvas' },
  ];

  it('names the overlaid terminal while the canvas is on screen', () => {
    expect(overlaySuppressedTerminal(tabs, 'tb-canvas', 'tm-7')).toBe('tm-7');
  });

  it('suppresses NOTHING when the canvas is open with no overlay (R3)', () => {
    // The regression: every terminal in the window went silent for as long as the canvas was
    // up. A canvas node is a preview — often a few percent of natural size, and not painting
    // at all below the `live` tier — so it is not "seen".
    expect(overlaySuppressedTerminal(tabs, 'tb-canvas', null)).toBeNull();
  });

  it('suppresses nothing once the user has left the canvas, even with an overlay remembered', () => {
    // The subtle half. `overlayId` deliberately SURVIVES a tab switch (`plan/020` §4), so a
    // rule keyed on it alone keeps a terminal silent long after the user stopped looking at
    // it. Both conditions have to hold.
    expect(overlaySuppressedTerminal(tabs, 'tb-work', 'tm-7')).toBeNull();
    expect(overlaySuppressedTerminal(tabs, null, 'tm-7')).toBeNull();
  });

  it('is not fooled by another virtual tab', () => {
    const withSettings = [...tabs, { id: 'tb-settings', shellType: 'settings' }];
    // Settings shows no terminals at all, so nothing behind it is "seen".
    expect(overlaySuppressedTerminal(withSettings, 'tb-settings', 'tm-7')).toBeNull();
  });
});
