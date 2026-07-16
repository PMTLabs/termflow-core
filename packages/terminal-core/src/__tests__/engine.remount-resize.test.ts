/**
 * engine.remount-resize.test.ts
 *
 * Spec 045 §3.5 — "surviving pane does not reflow after a sibling pane closes".
 *
 * WHAT ACTUALLY BREAKS (proven here, and NOT what the task brief hypothesised):
 *
 * Closing a pane collapses the split, so React remounts the survivor's
 * <TerminalDisplay> into a NEW container div and constructs a FRESH
 * TerminalEngine on the same cacheKey. mount() takes the REATTACH path:
 *
 *   TerminalEngine.ts:644   cached.disposables.forEach(dispose)  // kills onResize
 *   TerminalEngine.ts:650   container.appendChild(existingElement)
 *   TerminalEngine.ts:651   fit.fit()                            // <-- resizes xterm
 *   TerminalEngine.ts:890   boundTerm.onResize(...)              // <-- re-wired 240 lines LATER
 *
 * The :651 fit measures the NEW (post-collapse) box and resizes xterm correctly.
 * But at that instant NO onResize listener is attached — the previous mount's was
 * disposed by unmount() (:2741) and/or by :644, and the new one is not wired until
 * :890. So the resize event is ORPHANED and scheduleBackendResize() is never called.
 *
 * Every later fit is then a genuine no-op, because xterm is ALREADY at the right
 * size (FitAddon.fit() only calls term.resize() when the proposed dims differ):
 *   - the rAF settle-fit  (:1611)
 *   - the ResizeObserver's initial callback on observe() (:1637/:1657)
 *
 * And attach() cannot rescue it: the pane collapse does not change the processId,
 * so hydrate() hits its "already hydrated" guard (:1842) and returns BEFORE the
 * pre-hydration bridge.resize (:1873).
 *
 * Net result: xterm = correct size, PTY = STALE size. The shell keeps wrapping its
 * output at the old width until something forces a size CHANGE (a manual window
 * resize), which is exactly the reported symptom.
 *
 * The engine's own source already names this failure mode, in the comment on
 * flushBackendResize() (:2110): "remount won't re-fit when xterm is already the
 * right size, so the PTY would wrap output at the old width".
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
import { Terminal as MockTerminal } from '../__mocks__/xterm';
import { FitAddon as MockFitAddon } from '../__mocks__/addon-fit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A container that reports a real box. `offsetParent` is forced non-null because
 * jsdom always reports null there, and healOnce() treats null as "pane hidden".
 */
function makeContainer(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  document.body.appendChild(el);
  return el;
}

interface FakeBridgeOptions {
  resize?: (processId: string, cols: number, rows: number) => void | Promise<void>;
  getSnapshot?: (
    processId: string,
    cols: number,
    rows: number,
  ) => Promise<{ snapshot: string; cols: number; rows: number }>;
  getSize?: (processId: string) => Promise<{ cols: number; rows: number }>;
}

function makeFakeBridge(opts: FakeBridgeOptions = {}): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: opts.resize ?? (() => {}),
    getSnapshot: opts.getSnapshot,
    getSize: opts.getSize,
  };
}

beforeEach(() => {
  terminalCache.clear();
  if (typeof (global as any).ResizeObserver === 'undefined') {
    (global as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    };
  }
});

afterEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// THE DEFECT
//
// Simulates a pane collapse: the survivor's engine is unmounted and a fresh
// engine on the SAME cacheKey is mounted into a NEW, WIDER container (the pane
// grew to fill the closed sibling's space). The reattach fit measures 160 cols.
//
// xterm reaches 160 locally. The PTY must reach 160 too — otherwise the shell
// wraps at 80 and the pane renders broken text until a manual window resize.
// ---------------------------------------------------------------------------

test('a pane-collapse remount pushes the survivor\'s NEW size to the backend PTY', async () => {
  jest.useFakeTimers();

  const resizeCalls: Array<[number, number]> = [];
  const bridge = makeFakeBridge({
    resize: (_pid, c, r) => {
      resizeCalls.push([c, r]);
    },
    getSnapshot: async () => ({ snapshot: '', cols: 80, rows: 24 }),
  });

  const cacheKey = 'collapse-survivor';

  // --- First mount: the pane as it exists BEFORE the sibling closes (80 cols).
  const engine1 = new TerminalEngine(bridge, { cacheKey });
  engine1.mount(makeContainer(400, 600));
  engine1.attach('pid-1');
  await jest.runAllTimersAsync();

  const entry = terminalCache.get(cacheKey)!;
  const mockTerm = entry.terminal as unknown as MockTerminal;
  expect(mockTerm.cols).toBe(80);
  // Baseline: the pre-hydration resize told the PTY 80x24.
  expect(resizeCalls).toContainEqual([80, 24]);
  resizeCalls.length = 0;

  // --- The sibling pane closes. React unmounts this subtree and remounts the
  //     survivor into a NEW container that is now twice as wide.
  engine1.unmount();

  const fit = entry.fitAddon as unknown as MockFitAddon;
  // The reattach fit at :651 will now measure the settled post-collapse box.
  fit.setNextFit(160, 24);

  const engine2 = new TerminalEngine(bridge, { cacheKey });
  engine2.mount(makeContainer(800, 600));
  engine2.attach('pid-1'); // same process — the pane's shell is untouched by the collapse
  await jest.runAllTimersAsync();

  // The local xterm DID pick up the new geometry — rendering-side state is fine.
  expect(mockTerm.cols).toBe(160);

  // ...but the PTY must learn it too, or the shell keeps wrapping at 80 columns.
  // This is the defect: the :651 fit's resize event is orphaned, so the backend
  // is never told, and no later fit re-fires because xterm already reads 160.
  expect(resizeCalls).toContainEqual([160, 24]);
});

// ---------------------------------------------------------------------------
// WHY THE 035/036 HEAL WATCHDOG IS NOT A FIX FOR THIS
//
// The watchdog DOES notice this drift: it compares bridge.getSize() against xterm
// and re-pushes on a real mismatch. Measured against this exact scenario, it first
// pushes the corrected size only after ~1s (HEAL_INTERVAL_MS = 1000, plus a 700ms
// output-quiet gate via HEAL_SETTLE_MS). So it is an IDLE net for DRIFT, not a
// reflow path: for a full second the shell keeps emitting output wrapped to the
// OLD width into the already-widened xterm, and correcting the PTY afterwards does
// not re-wrap the mis-wrapped lines already sitting in the buffer.
//
// It also does nothing at all when the bridge has no getSize — startHealWatchdog
// self-gates on `typeof this.bridge.getSize !== 'function'` (:2207), and
// MainBridge.ts:46 makes getSize conditional on window.electronAPI.getTerminalSize.
//
// This test pins the REQUIREMENT: the collapse must reflow within one
// scheduleBackendResize debounce (120ms), not a second later via the watchdog.
// ---------------------------------------------------------------------------

test('a collapse reflows within one resize-debounce window, not via the 1s idle watchdog', async () => {
  jest.useFakeTimers();

  const resizeCalls: Array<[number, number]> = [];
  const bridge = makeFakeBridge({
    resize: (_pid, c, r) => {
      resizeCalls.push([c, r]);
    },
    getSnapshot: async () => ({ snapshot: '', cols: 80, rows: 24 }),
    // The backend is still at the pre-collapse size — this is the drift the
    // watchdog is supposed to notice.
    getSize: async () => ({ cols: 80, rows: 24 }),
  });

  const cacheKey = 'collapse-heal';

  const engine1 = new TerminalEngine(bridge, { cacheKey });
  engine1.mount(makeContainer(400, 600));
  engine1.attach('pid-1');
  await jest.advanceTimersByTimeAsync(300);

  const entry = terminalCache.get(cacheKey)!;
  const fit = entry.fitAddon as unknown as MockFitAddon;

  engine1.unmount();
  fit.setNextFit(160, 24);
  resizeCalls.length = 0;

  const engine2 = new TerminalEngine(bridge, { cacheKey });
  engine2.mount(makeContainer(800, 600));
  engine2.attach('pid-1');

  // One animation frame + the 120ms backend-resize debounce is the window in
  // which a correct implementation would have reflowed the pane.
  await jest.advanceTimersByTimeAsync(200);

  expect(resizeCalls).toContainEqual([160, 24]);

  engine2.unmount();
});
