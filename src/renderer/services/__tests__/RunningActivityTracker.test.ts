/**
 * @jest-environment jsdom
 */
import {
  EVAL_INTERVAL_MS,
  RESIZE_COOLDOWN_MS,
  STARTUP_COOLDOWN_MS,
  UNSEEN_DEBOUNCE_MS,
} from '../runningActivity';

// --- Mocks for the tracker's collaborators -------------------------------
const dispatch = jest.fn();
// Mutable store state so unseen tests can vary activeTabId / already-unseen tabs.
// (Prefixed `mock*` so jest's hoisted factory may reference it.)
const mockTabsState: { activeTabId: string | null; tabs: Array<{ id: string; hasUnseenOutput?: boolean }> } = {
  activeTabId: null,
  tabs: [],
};
// Holder so tests can fire the store-change callback the tracker subscribes with.
const mockStoreSub: { cb: (() => void) | null } = { cb: null };
jest.mock('../../store', () => ({
  store: {
    dispatch: (action: unknown) => dispatch(action),
    getState: () => ({ panes: { treesByTabId: {} }, tabs: mockTabsState }),
    subscribe: (cb: () => void) => {
      mockStoreSub.cb = cb;
      return () => { mockStoreSub.cb = null; };
    },
  },
}));
jest.mock('../../store/slices/tabsSlice', () => ({
  setRunningTabs: (ids: string[]) => ({ type: 'tabs/setRunningTabs', payload: ids }),
  markUnseenOutput: (payload: { tabId: string }) => ({ type: 'tabs/markUnseenOutput', payload }),
}));
// terminalId is derived from processId in the mock: p1→tm-1, p2→tm-2, p3→tm-3.
jest.mock('../TerminalService', () => ({
  terminalService: {
    getTerminalIdForProcess: (pid: string) =>
      pid === 'p1' ? 'tm-1' : pid === 'p2' ? 'tm-2' : pid === 'p3' ? 'tm-3' : undefined,
  },
}));
// terminalId → tabId: tm-1→tb-1, tm-2→tb-2, tm-3→tb-3. Gated by mockPaneTree.ready so
// tests can simulate a pane tree that seeds late (resolves to null, then to a tabId).
const mockPaneTree = { ready: true };
jest.mock('../../store/slices/paneTreeOps', () => ({
  findTabIdByTerminalId: (_trees: unknown, terminalId: string) => {
    if (!mockPaneTree.ready) return null;
    return terminalId === 'tm-1' ? 'tb-1'
      : terminalId === 'tm-2' ? 'tb-2'
      : terminalId === 'tm-3' ? 'tb-3'
      : null;
  },
}));

import { runningActivityTracker } from '../RunningActivityTracker';

function emitData(processId: string, bytes: number): void {
  window.dispatchEvent(
    new CustomEvent('pty:data', { detail: { processId, data: 'x'.repeat(bytes) } }),
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

/** Collect the tabId payloads of every setRunningTabs dispatch so far. */
function runningPayloads(): string[][] {
  return dispatch.mock.calls
    .map(([action]) => action)
    .filter((a: any) => a?.type === 'tabs/setRunningTabs')
    .map((a: any) => [...a.payload].sort());
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
