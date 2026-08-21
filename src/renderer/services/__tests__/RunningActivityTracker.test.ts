/**
 * @jest-environment jsdom
 */
import {
  EVAL_INTERVAL_MS,
  RESIZE_COOLDOWN_MS,
  VIEW_CHANGE_COOLDOWN_MS,
  STARTUP_COOLDOWN_MS,
  UNSEEN_DEBOUNCE_MS,
} from '../runningActivity';

// --- Mocks for the tracker's collaborators -------------------------------
const dispatch = jest.fn();
// Mutable store state so unseen tests can vary activeTabId / already-unseen tabs.
// (Prefixed `mock*` so jest's hoisted factory may reference it.)
const mockTabsState: { activeTabId: string | null; tabs: Array<{ id: string; hasUnseenOutput?: boolean; notifyMuted?: boolean; shellType?: string | null }> } = {
  activeTabId: null,
  tabs: [],
};
// Canvas view state. Only `overlayId` reaches the tracker — it is the one terminal the user
// may be watching at 1:1, and therefore the only one whose own busy→idle must not notify.
const mockCanvasState: { overlayId: string | null } = { overlayId: null };
// Holder so tests can fire the store-change callback the tracker subscribes with.
const mockStoreSub: { cb: (() => void) | null } = { cb: null };
jest.mock('../../store', () => ({
  store: {
    dispatch: (action: unknown) => dispatch(action),
    getState: () => ({ panes: { treesByTabId: {} }, tabs: mockTabsState, canvas: mockCanvasState }),
    subscribe: (cb: () => void) => {
      mockStoreSub.cb = cb;
      return () => { mockStoreSub.cb = null; };
    },
  },
}));
jest.mock('../../store/slices/tabsSlice', () => ({
  setRunningActivity: (payload: { tabIds: string[]; terminalIds: string[] }) =>
    ({ type: 'tabs/setRunningActivity', payload }),
  markUnseenOutput: (payload: { tabId: string }) => ({ type: 'tabs/markUnseenOutput', payload }),
  markTabSeen: (payload: { tabId: string }) => ({ type: 'tabs/markTabSeen', payload }),
}));
// terminalId is derived from processId in the mock: p1→tm-1, p2→tm-2, p3→tm-3, and back again.
// Both directions are needed: the tracker resolves output (processId → terminalId) to find a
// tab, and resolves the overlaid terminal (terminalId → processId) to advance its unseen mark.
jest.mock('../TerminalService', () => ({
  terminalService: {
    getTerminalIdForProcess: (pid: string) =>
      pid === 'p1' ? 'tm-1' : pid === 'p2' ? 'tm-2' : pid === 'p3' ? 'tm-3' : undefined,
    getProcessId: (tid: string) =>
      tid === 'tm-1' ? 'p1' : tid === 'tm-2' ? 'p2' : tid === 'tm-3' ? 'p3' : undefined,
  },
}));
// terminalId → tabId: tm-1→tb-1, tm-2→tb-2, tm-3→tb-3. Gated by mockPaneTree.ready so
// tests can simulate a pane tree that seeds late (resolves to null, then to a tabId).
const mockPaneTree = { ready: true };
// Per-terminal pane-level mute the tracker consults (isTerminalMuted). Tests toggle it.
const mockMutedTerminals = new Set<string>();
jest.mock('../../store/slices/paneTreeOps', () => ({
  findTabIdByTerminalId: (_trees: unknown, terminalId: string) => {
    if (!mockPaneTree.ready) return null;
    return terminalId === 'tm-1' ? 'tb-1'
      : terminalId === 'tm-2' ? 'tb-2'
      : terminalId === 'tm-3' ? 'tb-3'
      : null;
  },
  isTerminalMuted: (_trees: unknown, terminalId: string) => mockMutedTerminals.has(terminalId),
}));

import { runningActivityTracker } from '../RunningActivityTracker';

function emitData(processId: string, bytes: number): void {
  window.dispatchEvent(
    new CustomEvent('pty:data', { detail: { processId, data: 'x'.repeat(bytes) } }),
  );
}

function emitInput(processId: string, data: string): void {
  window.dispatchEvent(
    new CustomEvent('pty:input', { detail: { processId, data, t: Date.now() } }),
  );
}

function emitExit(processId: string, terminalId?: string): void {
  // Real pty:exit events carry the resolved terminalId (TerminalService removes the
  // processId→terminalId mapping before dispatching), so the tracker resolves the
  // exiting tab from the event rather than the now-stale mapping.
  window.dispatchEvent(
    new CustomEvent('pty:exit', { detail: { processId, exitCode: 0, terminalId } }),
  );
}

/** Settle interval: long enough for output to debounce into the unseen bell. */
const SETTLE_MS = UNSEEN_DEBOUNCE_MS + EVAL_INTERVAL_MS;

/** Simulate a Redux store change (e.g. activeTabId switch) reaching the tracker. */
function switchActiveTab(tabId: string | null): void {
  mockTabsState.activeTabId = tabId;
  mockStoreSub.cb?.();
}

/** Emit a synchronized redraw-style burst on every terminal at once. */
function burstAllTerminals(): void {
  for (let i = 0; i < 5; i++) {
    emitData('p1', 4);
    emitData('p2', 4);
  }
}

/** Collect the full {tabIds, terminalIds} payloads of every setRunningActivity dispatch so far. */
function runningActivityPayloads(): Array<{ tabIds: string[]; terminalIds: string[] }> {
  return dispatch.mock.calls
    .map(([action]) => action)
    .filter((a: any) => a?.type === 'tabs/setRunningActivity')
    .map((a: any) => ({
      tabIds: [...a.payload.tabIds].sort(),
      terminalIds: [...a.payload.terminalIds].sort(),
    }));
}

/** Collect just the tabId payloads of every setRunningActivity dispatch so far. */
function runningPayloads(): string[][] {
  return runningActivityPayloads().map((p) => p.tabIds);
}

/** Collect the tabIds of every markUnseenOutput dispatch so far. */
function unseenTabIds(): string[] {
  return dispatch.mock.calls
    .map(([action]) => action)
    .filter((a: any) => a?.type === 'tabs/markUnseenOutput')
    .map((a: any) => a.payload.tabId);
}

describe('RunningActivityTracker resize handling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    dispatch.mockClear();
    mockTabsState.activeTabId = null;
    mockTabsState.tabs = [];
    mockPaneTree.ready = true;
    mockMutedTerminals.clear();
    mockCanvasState.overlayId = null;
    runningActivityTracker.start(0); // no startup grace — steady-state behavior
  });

  afterEach(() => {
    runningActivityTracker.stop();
    jest.useRealTimers();
  });

  it('flags both tabs running for a synchronized burst when no resize occurred (control)', () => {
    burstAllTerminals();
    jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    expect(runningPayloads()).toContainEqual(['tb-1', 'tb-2']);
  });

  it('does NOT flag tabs running for a burst caused by a window resize', () => {
    window.dispatchEvent(new Event('resize'));
    burstAllTerminals(); // SIGWINCH redraw burst on every terminal
    jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    // The redraw burst is dropped: no tab is ever marked running.
    expect(runningPayloads().every(p => p.length === 0)).toBe(true);
  });

  // Req 8 (plan/020 §2): the tracker must publish BOTH levels in the SAME dispatch — the
  // tab-level tabIds (unchanged) and the new per-terminal terminalIds Canvas Mode needs.
  it('dispatches per-terminal runningTerminalIds alongside tab-level tabIds, in ONE action', () => {
    burstAllTerminals();
    jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    const payload = runningActivityPayloads().find((p) => p.tabIds.length > 0);
    expect(payload).toBeDefined();
    expect(payload!.tabIds).toEqual(['tb-1', 'tb-2']);
    // p1→tm-1 and p2→tm-2 are the only two terminals with output in this burst.
    expect(payload!.terminalIds).toEqual(['tm-1', 'tm-2']);
  });

  it('recovers and flags running again once the resize cooldown has elapsed', () => {
    window.dispatchEvent(new Event('resize'));
    burstAllTerminals();
    jest.advanceTimersByTime(EVAL_INTERVAL_MS); // still in cooldown → suppressed
    dispatch.mockClear();

    // Let the cooldown expire with no further output, then a fresh real burst.
    jest.advanceTimersByTime(RESIZE_COOLDOWN_MS);
    burstAllTerminals();
    jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    expect(runningPayloads()).toContainEqual(['tb-1', 'tb-2']);
  });
});

describe('RunningActivityTracker unseen-output marking (bell)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    dispatch.mockClear();
    mockTabsState.activeTabId = null;
    mockTabsState.tabs = [];
    mockPaneTree.ready = true;
    mockMutedTerminals.clear();
    mockCanvasState.overlayId = null;
    runningActivityTracker.start(0); // no startup grace — steady-state behavior
  });

  afterEach(() => {
    runningActivityTracker.stop();
    jest.useRealTimers();
  });

  it('marks an inactive tab unseen once its single output chunk has settled', () => {
    emitData('p1', 4); // one small chunk → not "running", but is unseen output
    jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    // Within the debounce window the bell must NOT show yet.
    expect(unseenTabIds()).not.toContain('tb-1');
    jest.advanceTimersByTime(SETTLE_MS); // let it settle past UNSEEN_DEBOUNCE_MS
    expect(unseenTabIds()).toContain('tb-1');
    // And it is NOT flagged running (the bell only shows once idle).
    expect(runningPayloads().every(p => !p.includes('tb-1'))).toBe(true);
  });

  it('does NOT mark unseen while output keeps streaming (debounce keeps resetting)', () => {
    // A chunk every EVAL_INTERVAL_MS (< debounce) — never idle long enough to settle.
    for (let i = 0; i < 8; i++) {
      emitData('p1', 4);
      jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    }
    expect(unseenTabIds()).toEqual([]); // still streaming → no bell, no flicker
    jest.advanceTimersByTime(SETTLE_MS); // output stops → settles → bell
    expect(unseenTabIds()).toContain('tb-1');
  });

  it('does NOT mark the active tab unseen', () => {
    mockTabsState.activeTabId = 'tb-1';
    emitData('p1', 4);
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).not.toContain('tb-1');
  });

  it('does NOT re-dispatch for a tab already flagged unseen', () => {
    mockTabsState.tabs = [{ id: 'tb-1', hasUnseenOutput: true }];
    emitData('p1', 4);
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).not.toContain('tb-1');
  });

  it('does NOT mark unseen during the resize cooldown (no SIGWINCH false positives)', () => {
    window.dispatchEvent(new Event('resize'));
    burstAllTerminals(); // redraw burst on every terminal — dropped while suppressed
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).toEqual([]);
  });

  it('does NOT ring the bell for startup/restore output within the startup grace, then resumes', () => {
    // App start/restore: restored inactive tabs spawn their PTYs and print prompts /
    // reattach repaints right after the tracker starts. That startup burst must not
    // ring the bell (nothing was missed on a fresh start).
    runningActivityTracker.stop(); // undo beforeEach's grace-less start
    dispatch.mockClear();
    runningActivityTracker.start(STARTUP_COOLDOWN_MS); // arm the startup grace

    emitData('p1', 4); // restored tab's startup output
    jest.advanceTimersByTime(SETTLE_MS); // would normally settle into the bell
    expect(unseenTabIds()).not.toContain('tb-1');

    // Once the grace elapses, genuine new background output rings normally.
    jest.advanceTimersByTime(STARTUP_COOLDOWN_MS);
    emitData('p1', 4);
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).toContain('tb-1');
  });

  it('does NOT mark unseen after a visibility-regain reconnect burst (remote→local switch)', () => {
    // App becomes visible again (RDP reconnect / un-minimize); ConPTY repaints every
    // TUI at once. That synchronized burst must not ring the bell on quiet tabs.
    document.dispatchEvent(new Event('visibilitychange')); // jsdom default state is 'visible'
    burstAllTerminals();
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).toEqual([]);
  });

  it('does NOT mark unseen after a session-reconnect burst (RDP↔console switch)', () => {
    // The OS session-change path: the backend (session_notify.rs) detects
    // WM_WTSSESSION_CHANGE — which the DOM visibilitychange event does NOT cover —
    // and calls notifyReconnectBurst(). The ensuing ConPTY repaint of every TUI must
    // not ring the bell on the quiet tabs.
    runningActivityTracker.notifyReconnectBurst();
    burstAllTerminals();
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).toEqual([]);
  });

  it('does NOT mark unseen after a Canvas Mode relocation burst', () => {
    // Entering or leaving Canvas Mode moves every terminal between two differently-sized
    // boxes, SIGWINCHing every PTY at once. Tam reported the visible half of this: switching
    // to the canvas tab lit the running sweep across the strip and popped a notification, for
    // output nobody typed. Same event class as a window resize, same suppression.
    runningActivityTracker.notifyViewChangeBurst();
    burstAllTerminals();
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).toEqual([]);
  });

  // The window has to outlast the whole chain, not just the fit. A relocation waits on a
  // DEBOUNCED resize and a backend round-trip before the TUI starts redrawing, so a
  // window-resize-length window closes before the output it exists to swallow arrives —
  // which is the shape of the bug Tam reported: suppression that suppressed nothing.
  it('outlasts a plain window-resize cooldown', () => {
    expect(VIEW_CHANGE_COOLDOWN_MS).toBeGreaterThan(RESIZE_COOLDOWN_MS * 2);

    runningActivityTracker.notifyViewChangeBurst();
    jest.advanceTimersByTime(RESIZE_COOLDOWN_MS + 1);   // a resize window would be over here
    burstAllTerminals();
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).toEqual([]);
  });

  // The pair that stops the case above from being satisfiable by a tracker that suppresses
  // everything forever: real output AFTER the burst window must still be seen.
  it('resumes marking once the relocation burst has settled', () => {
    runningActivityTracker.notifyViewChangeBurst();
    jest.advanceTimersByTime(VIEW_CHANGE_COOLDOWN_MS + 1);
    emitData('p2', 4);
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).not.toEqual([]);
  });

  // The general rule, and the one that covers causes nobody has enumerated: EVERY renderer
  // resize goes through TerminalService, which publishes this. Tam hit it by font-zooming a
  // terminal inside the canvas overlay — a resize the relocation hooks knew nothing about.
  it('does NOT mark unseen after a PTY resize announced by TerminalService', () => {
    window.dispatchEvent(new CustomEvent('pty:resize', {
      detail: { processId: 'p2', terminalId: 'tm-2', cols: 120, rows: 40 },
    }));
    burstAllTerminals();
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).toEqual([]);
  });

  // Pairs with it: the listener must be attached to the event the service actually sends, not
  // to a name this test invented. A typo either side passes the case above only because
  // nothing was suppressed AND nothing was emitted — so emit first, then check it is seen.
  it('still marks unseen for output with no resize before it', () => {
    emitData('p2', 4);
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).not.toEqual([]);
  });

  it('suppresses the bell when many tabs settle in the same tick (repaint-burst signature)', () => {
    // A desktop reattach (RDP↔console switch / un-minimize / resize) repaints every TUI
    // at once, so all inactive tabs settle together and would flag in ONE tick. Flagging
    // >= BURST_TAB_THRESHOLD (3) tabs simultaneously is a repaint, not genuine per-tab
    // activity — suppress the whole batch. This is the trigger-independent backstop that
    // catches the OS session switch the Page Visibility / WTS signals can miss.
    emitData('p1', 4);
    emitData('p2', 4);
    emitData('p3', 4);
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).toEqual([]);
    // And the suppressed output must not ring on a later tick either (marks advanced).
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).toEqual([]);
  });

  it('still rings when only a couple tabs settle together (below the burst threshold)', () => {
    // Genuine activity on a small number of tabs must NOT be mistaken for a repaint.
    emitData('p1', 4);
    emitData('p2', 4);
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds().sort()).toEqual(['tb-1', 'tb-2']);
  });

  it('start() is idempotent — a single stop() fully halts evaluation', () => {
    runningActivityTracker.start(); // second start while already running
    runningActivityTracker.stop();  // one stop should clear the (single) timer
    dispatch.mockClear();
    emitData('p1', 4);
    jest.advanceTimersByTime(SETTLE_MS);
    // If start() had created a second interval, this would still dispatch.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('flags a tab only once for the same settled output across ticks (high-water mark)', () => {
    emitData('p1', 4);
    jest.advanceTimersByTime(SETTLE_MS);       // settles → flag once
    jest.advanceTimersByTime(EVAL_INTERVAL_MS); // another tick, no new output
    // The single output chunk must produce exactly one markUnseenOutput dispatch.
    expect(unseenTabIds().filter(id => id === 'tb-1')).toEqual(['tb-1']);
  });

  it('marks unseen immediately when a process prints then exits (exit settles it)', () => {
    emitData('p1', 4);
    emitExit('p1', 'tm-1'); // exit before the debounce elapses
    // A process exit settles its final output now, so the bell rings without waiting
    // out the debounce — otherwise a one-shot command would never ring it.
    expect(unseenTabIds()).toContain('tb-1');
  });

  it('retries an unresolved process until its pane tree seeds (late seeding)', () => {
    mockPaneTree.ready = false; // pane tree not seeded yet → resolveTab returns null
    emitData('p1', 4);
    jest.advanceTimersByTime(SETTLE_MS); // settled but unresolved → no flag, mark not advanced
    expect(unseenTabIds()).not.toContain('tb-1');
    mockPaneTree.ready = true; // tree seeds
    jest.advanceTimersByTime(EVAL_INTERVAL_MS); // next tick → now resolves → flag
    expect(unseenTabIds()).toContain('tb-1');
  });

  it('does NOT bell a tab whose output was seen live, even if the user switches away before a tick', () => {
    // tb-1 is active; output prints there while the user is watching.
    switchActiveTab('tb-1');
    emitData('p1', 4);
    // User switches to tb-2 BEFORE the output settles (the sub-tick focus race).
    switchActiveTab('tb-2');
    jest.advanceTimersByTime(SETTLE_MS);
    // The output was on-screen on tb-1 → must not ring the bell on tb-1.
    expect(unseenTabIds()).not.toContain('tb-1');
  });

  it('does NOT re-bell a tab that was focused (flag cleared) then left again', () => {
    // tb-1 inactive output settles and flags it; user focuses tb-1 (Redux clears the
    // flag) then leaves to tb-2 — the same output must not ring the bell a second time.
    emitData('p1', 4);
    jest.advanceTimersByTime(SETTLE_MS); // flagged once
    dispatch.mockClear();
    switchActiveTab('tb-1'); // focus → (Redux would clear hasUnseenOutput)
    switchActiveTab('tb-2'); // leave again
    jest.advanceTimersByTime(SETTLE_MS);
    expect(unseenTabIds()).not.toContain('tb-1');
  });
});

describe('RunningActivityTracker typing echo-cancel (sweep)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    dispatch.mockClear();
    mockTabsState.activeTabId = 'tb-1'; // user is typing in the active tab
    mockTabsState.tabs = [];
    mockPaneTree.ready = true;
    mockMutedTerminals.clear();
    runningActivityTracker.start(0); // no startup grace
  });
  afterEach(() => {
    runningActivityTracker.stop();
    jest.useRealTimers();
  });

  it('does NOT flag the tab running while the user types (echo suppressed)', () => {
    // Simulate typing "ls -la": each keystroke, then the shell echoes it back (1 byte).
    for (const ch of 'ls -la') {
      emitInput('p1', ch);
      emitData('p1', 1); // echo of that character, same instant → within echo window
    }
    jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    // Typing echo must not animate the sweep even though it's >= MIN_CHUNKS chunks.
    expect(runningPayloads().every(p => !p.includes('tb-1'))).toBe(true);
  });

  it('does NOT flag running while typing in PowerShell/PSReadLine (large per-keystroke line-repaints)', () => {
    // PSReadLine (the Windows default shell's line editor) re-renders the WHOLE input
    // line with syntax-highlighting VT sequences on every keystroke — 60-200+ bytes per
    // key, far above a 1-byte bash/cmd echo. Those repaints are still a consequence of
    // typing (echo), NOT autonomous program output, so they must not animate the sweep.
    for (const ch of 'git status') {
      emitInput('p1', ch);
      emitData('p1', 120); // PSReadLine line-repaint for this keystroke (>> old 48B cap)
    }
    jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    expect(runningPayloads().every(p => !p.includes('tb-1'))).toBe(true);
  });

  it('DOES flag the tab running for real command output after Enter (submit resets echo gate)', () => {
    for (const ch of 'ls') { emitInput('p1', ch); emitData('p1', 1); } // typed + echoed
    emitInput('p1', '\r'); // Enter submits → lastInputAt reset to -Infinity
    // The command now produces real output (not echo). Even small chunks count.
    emitData('p1', 4); emitData('p1', 4); emitData('p1', 4);
    jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    expect(runningPayloads()).toContainEqual(['tb-1']);
  });

  it('does NOT flag running for a large chunk right after a keystroke (line-repaint, pre-submit)', () => {
    // Before Enter, even a large chunk is a consequence of typing (a PSReadLine line-
    // repaint), NOT autonomous output — echo-cancel is time-based, so it is suppressed.
    // The same output AFTER Enter counts (see the submit-resets-gate test above).
    emitInput('p1', 'x');
    emitData('p1', 600); // large line-repaint within the echo window
    jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    expect(runningPayloads().every(p => !p.includes('tb-1'))).toBe(true);
  });

  it('does not echo-suppress output on a background tab the user is not typing in', () => {
    // p2/tb-2 gets output but no input events → never treated as echo.
    emitData('p2', 4); emitData('p2', 4); emitData('p2', 4);
    jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    expect(runningPayloads().some(p => p.includes('tb-2'))).toBe(true);
  });

  it('clears lastInputAt on process exit so a reused process id is not wrongly echo-suppressed', () => {
    emitInput('p1', 'a');        // records lastInputAt for p1 (recent, small)
    emitExit('p1', 'tm-1');      // exit must clear lastInputAt for p1
    // A new process reuses id p1 and immediately emits small output. If the exit had
    // NOT cleared lastInputAt, these would fall inside the echo window and be dropped
    // from the running buffer. With the fix, they count → the tab flips running.
    emitData('p1', 1); emitData('p1', 1); emitData('p1', 1);
    jest.advanceTimersByTime(EVAL_INTERVAL_MS);
    expect(runningPayloads()).toContainEqual(['tb-1']);
  });
});

describe('RunningActivityTracker activity:bell emission (notifications)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    dispatch.mockClear();
    mockTabsState.activeTabId = null; // no active tab → an inactive tab can bell
    mockTabsState.tabs = [];
    mockPaneTree.ready = true;
    mockMutedTerminals.clear();
    runningActivityTracker.start(0);
  });
  afterEach(() => {
    runningActivityTracker.stop();
    jest.useRealTimers();
  });

  it('emits activity:bell with the tabId and a causal time when it flags a tab unseen', () => {
    const bells: Array<{ tabId: string; causalTime: number }> = [];
    const h = (e: Event) => bells.push((e as CustomEvent).detail);
    window.addEventListener('activity:bell', h);
    emitData('p1', 4);
    jest.advanceTimersByTime(SETTLE_MS); // settle past the unseen debounce → flags tb-1
    window.removeEventListener('activity:bell', h);
    expect(bells.some((b) => b.tabId === 'tb-1' && typeof b.causalTime === 'number')).toBe(true);
  });

  it('does NOT emit activity:bell for output on the active tab', () => {
    mockTabsState.activeTabId = 'tb-1';
    const bells: unknown[] = [];
    const h = (e: Event) => bells.push((e as CustomEvent).detail);
    window.addEventListener('activity:bell', h);
    emitData('p1', 4);
    jest.advanceTimersByTime(SETTLE_MS);
    window.removeEventListener('activity:bell', h);
    expect(bells).toHaveLength(0); // active-tab output never rings the bell
  });

  it('emits activity:bell on the exit path (one-shot command prints then exits)', () => {
    const bells: Array<{ tabId: string; causalTime: number }> = [];
    const h = (e: Event) => bells.push((e as CustomEvent).detail);
    window.addEventListener('activity:bell', h);
    emitData('p1', 4);       // output, then...
    emitExit('p1', 'tm-1');  // ...exit settles it immediately → flagOnExit bells now
    window.removeEventListener('activity:bell', h);
    expect(bells.some((b) => b.tabId === 'tb-1' && typeof b.causalTime === 'number')).toBe(true);
  });

  describe('mute suppression', () => {
    const collect = () => {
      const bells: Array<{ tabId: string }> = [];
      const h = (e: Event) => bells.push((e as CustomEvent).detail);
      window.addEventListener('activity:bell', h);
      return { bells, done: () => window.removeEventListener('activity:bell', h) };
    };

    it('does NOT bell (settle path) when the tab is muted', () => {
      mockTabsState.tabs = [{ id: 'tb-1', notifyMuted: true }];
      const { bells, done } = collect();
      emitData('p1', 4);
      jest.advanceTimersByTime(SETTLE_MS);
      done();
      expect(bells).toHaveLength(0);
      // No Redux unseen flag either.
      expect(dispatch).not.toHaveBeenCalledWith({ type: 'tabs/markUnseenOutput', payload: { tabId: 'tb-1' } });
    });

    it('does NOT bell (settle path) when the pane/terminal is muted', () => {
      mockMutedTerminals.add('tm-1');
      const { bells, done } = collect();
      emitData('p1', 4);
      jest.advanceTimersByTime(SETTLE_MS);
      done();
      expect(bells).toHaveLength(0);
    });

    it('bells the UNMUTED terminal while the muted one stays silent', () => {
      mockMutedTerminals.add('tm-1'); // p1/tm-1/tb-1 muted; p2/tm-2/tb-2 not
      const { bells, done } = collect();
      emitData('p1', 4);
      emitData('p2', 4);
      jest.advanceTimersByTime(SETTLE_MS);
      done();
      expect(bells.map((b) => b.tabId)).toEqual(['tb-2']);
    });

    it('does NOT bell (exit path) when the tab is muted', () => {
      mockTabsState.tabs = [{ id: 'tb-1', notifyMuted: true }];
      const { bells, done } = collect();
      emitData('p1', 4);
      emitExit('p1', 'tm-1');
      done();
      expect(bells).toHaveLength(0);
    });

    it('does NOT bell (exit path) when the pane/terminal is muted', () => {
      mockMutedTerminals.add('tm-1');
      const { bells, done } = collect();
      emitData('p1', 4);
      emitExit('p1', 'tm-1');
      done();
      expect(bells).toHaveLength(0);
    });

    it('does NOT bell (exit path) for a muted pane even when the exit event omits terminalId', () => {
      // Regression (external review, agy finding 1): the exit gate must resolve the
      // terminalId from the processId and use THAT for the pane-mute check — using
      // the (undefined) event param would let a muted pane leak an exit bell.
      mockMutedTerminals.add('tm-1');
      const { bells, done } = collect();
      emitData('p1', 4);
      emitExit('p1', undefined); // event carried no terminalId
      done();
      expect(bells).toHaveLength(0);
    });
  });

  /**
   * `plan/021` R3 + R4.
   *
   * R3: suppression used to be "the canvas tab is active", full stop — a window-wide blackout
   * that silenced every terminal for as long as the canvas stayed open. R4 is the rule that
   * replaced it: exactly the one terminal shown in the OVERLAY, the single canvas surface
   * rendered at 1:1, goes quiet; everything else notifies as it always did.
   *
   * These are the first tests to reach this branch at all. The pure-function tests in
   * `runningActivity.test.ts` only ever exercised `computeUnseenUpdate` with a stand-in
   * predicate, so the tracker's own predicate — which is where both R3 and R4 live, on TWO
   * separate bell-emitting paths — had no coverage and the blanket suppression could have been
   * changed to anything without a test noticing.
   */
  describe('canvas overlay suppression', () => {
    const collect = () => {
      const bells: Array<{ tabId: string }> = [];
      const h = (e: Event) => bells.push((e as CustomEvent).detail);
      window.addEventListener('activity:bell', h);
      return { bells, done: () => window.removeEventListener('activity:bell', h) };
    };

    /** Put Canvas Mode on screen. It is a TAB, so it becomes the active one. */
    const showCanvas = (overlayId: string | null = null) => {
      mockTabsState.tabs = [
        { id: 'tb-canvas', shellType: 'canvas' },
        { id: 'tb-1' },
        { id: 'tb-2' },
      ];
      mockCanvasState.overlayId = overlayId;
      switchActiveTab('tb-canvas');
    };

    it('bells every terminal while the canvas is open with NO overlay (R3)', () => {
      // The regression itself. Under the old rule this produced silence, because no terminal
      // tab can be the active one once the canvas — itself a tab — is showing.
      showCanvas(null);
      const { bells, done } = collect();
      emitData('p1', 4);
      emitData('p2', 4);
      jest.advanceTimersByTime(SETTLE_MS);
      done();
      expect(bells.map((b) => b.tabId).sort()).toEqual(['tb-1', 'tb-2']);
    });

    it('bells on the exit path too while the canvas is open with no overlay (R3)', () => {
      showCanvas(null);
      const { bells, done } = collect();
      emitData('p1', 4);
      emitExit('p1', 'tm-1');
      done();
      expect(bells.map((b) => b.tabId)).toEqual(['tb-1']);
    });

    it('silences ONLY the overlaid terminal, and its neighbour still bells (R4)', () => {
      showCanvas('tm-1');
      const { bells, done } = collect();
      emitData('p1', 4); // the terminal on screen at 1:1
      emitData('p2', 4); // a background terminal
      jest.advanceTimersByTime(SETTLE_MS);
      done();
      expect(bells.map((b) => b.tabId)).toEqual(['tb-2']);
    });

    it('silences the overlaid terminal on the exit path, and its neighbour still bells (R4)', () => {
      // The exit path is a SECOND writer of the same bell. A suppression that lived only in
      // the settle path would leak a notification for the terminal the user is watching.
      showCanvas('tm-1');
      const { bells, done } = collect();
      emitData('p1', 4);
      emitExit('p1', 'tm-1');
      emitData('p2', 4);
      emitExit('p2', 'tm-2');
      done();
      expect(bells.map((b) => b.tabId)).toEqual(['tb-2']);
    });

    it('silences the overlaid terminal on exit even when the event omits terminalId', () => {
      // Same shape as the muted-pane regression above: the gate must resolve the terminalId
      // from the processId rather than trusting the event to carry one.
      showCanvas('tm-1');
      const { bells, done } = collect();
      emitData('p1', 4);
      emitExit('p1', undefined);
      done();
      expect(bells).toHaveLength(0);
    });

    it('stops suppressing once the user leaves the canvas, even though overlayId survives', () => {
      // `overlayId` is deliberately NOT cleared on the way out (`plan/020` §4) — it records
      // which node is enlarged, and that has to survive a tab switch. So the suppression
      // cannot be keyed on `overlayId` alone: the user is no longer looking at that terminal
      // once another tab is on screen, and it must ring again.
      showCanvas('tm-1');
      switchActiveTab('tb-2');            // away from the canvas; overlayId still 'tm-1'
      expect(mockCanvasState.overlayId).toBe('tm-1');
      const { bells, done } = collect();
      emitData('p1', 4);
      jest.advanceTimersByTime(SETTLE_MS);
      done();
      expect(bells.map((b) => b.tabId)).toEqual(['tb-1']);
    });

    it('keeps the mute rules working while an overlay is open', () => {
      // The two suppressions are independent; narrowing one must not disarm the other.
      showCanvas('tm-1');
      mockMutedTerminals.add('tm-2');
      const { bells, done } = collect();
      emitData('p1', 4); // overlaid  → silent
      emitData('p2', 4); // muted     → silent
      jest.advanceTimersByTime(SETTLE_MS);
      done();
      expect(bells).toHaveLength(0);
    });
  });

  /**
   * Opening a terminal in the overlay marks its tab READ — `plan/024` Req 2.
   *
   * The mirror image of the suppression above. Suppression stops the overlaid terminal GAINING
   * a bell; this clears one it already had. Both halves read the same
   * `overlaySuppressedTerminal`, on purpose: a version of "is the user watching this terminal"
   * that drifted between them would either bell a terminal being stared at or clear a bell for
   * one nobody is looking at.
   */
  describe('canvas overlay marks the terminal read', () => {
    const showCanvas = (overlayId: string | null = null) => {
      mockTabsState.tabs = [
        { id: 'tb-canvas', shellType: 'canvas' },
        { id: 'tb-1' },
        { id: 'tb-2' },
      ];
      mockCanvasState.overlayId = overlayId;
      switchActiveTab('tb-canvas');
    };
    const seenTabs = () => dispatch.mock.calls
      .map(([a]) => a)
      .filter((a) => a?.type === 'tabs/markTabSeen')
      .map((a) => a.payload.tabId);
    const collect = () => {
      const bells: Array<{ tabId: string }> = [];
      const h = (e: Event) => bells.push((e as CustomEvent).detail);
      window.addEventListener('activity:bell', h);
      return { bells, done: () => window.removeEventListener('activity:bell', h) };
    };

    it("clears the overlaid terminal's tab, without activating it", () => {
      showCanvas('tm-1');
      expect(seenTabs()).toEqual(['tb-1']);
      // The point of the feature: the canvas tab is still the active one. Clearing via
      // `setActiveTab` would have yanked the user off the canvas to do it.
      expect(mockTabsState.activeTabId).toBe('tb-canvas');
    });

    /**
     * The second condition of `overlaySuppressedTerminal`, and the subtle one: `overlayId` is
     * deliberately NOT cleared when the user leaves the canvas (`plan/020` §4). Keyed on it
     * alone, this would mark a terminal read every time the store changed for any reason, from
     * a tab the user cannot even see.
     */
    it('does not clear when the canvas is not on screen, though overlayId survives', () => {
      showCanvas('tm-1');
      dispatch.mockClear();
      switchActiveTab('tb-2');
      expect(mockCanvasState.overlayId).toBe('tm-1');
      expect(seenTabs()).toEqual([]);
    });

    // Edge-triggered. The store subscription fires on EVERY change; re-dispatching on each one
    // would churn the bell for the whole session the overlay is open.
    it('fires once per overlay, not once per store change', () => {
      showCanvas('tm-1');
      expect(seenTabs()).toEqual(['tb-1']);
      mockStoreSub.cb?.();
      mockStoreSub.cb?.();
      expect(seenTabs()).toEqual(['tb-1']);
    });

    it('clears the new tab when the overlay moves to another terminal', () => {
      showCanvas('tm-1');
      mockCanvasState.overlayId = 'tm-2';
      mockStoreSub.cb?.();
      expect(seenTabs()).toEqual(['tb-1', 'tb-2']);
    });

    // Closing the overlay is not an event that means anything was seen.
    it('does not clear anything when the overlay is dismissed', () => {
      showCanvas('tm-1');
      dispatch.mockClear();
      mockCanvasState.overlayId = null;
      mockStoreSub.cb?.();
      expect(seenTabs()).toEqual([]);
    });

    /**
     * The sub-tick race, and the reason the mark is advanced at all: output that arrived just
     * before the overlay opened has NOT cleared the debounce, so an overlay opened and closed
     * inside one eval interval would ring for output the user just read at 1:1.
     */
    it('does not re-ring for output that was already on screen when the overlay opened', () => {
      emitData('p1', 4);              // arrives first, still settling
      showCanvas('tm-1');             // ...and is read at full size
      switchActiveTab('tb-2');        // overlay closed again within the same tick
      const { bells, done } = collect();
      jest.advanceTimersByTime(SETTLE_MS);
      done();
      expect(bells).toHaveLength(0);
    });

    /**
     * The negative that keeps the case above honest. Marking to `now` instead of to the last
     * RECORDED output passes the case above and fails this one: it declares the future seen, so
     * a terminal that produced nothing while overlaid falls silent afterwards too.
     */
    it('still rings for output that arrived after the overlay was opened', () => {
      showCanvas('tm-1');             // nothing has been produced yet
      switchActiveTab('tb-2');        // and the user leaves again
      const { bells, done } = collect();
      emitData('p1', 4);              // only NOW does it produce something
      jest.advanceTimersByTime(SETTLE_MS);
      done();
      expect(bells.map((b) => b.tabId)).toEqual(['tb-1']);
    });

    // A node whose pane tree has not seeded yet resolves to no tab. Dispatching with a null
    // tabId would be a no-op in the reducer, but the retry it silently skips would not be.
    it('does nothing when the terminal resolves to no tab yet', () => {
      mockPaneTree.ready = false;
      showCanvas('tm-1');
      expect(seenTabs()).toEqual([]);
      mockPaneTree.ready = true;
    });
  });
});
