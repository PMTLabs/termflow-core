/**
 * @jest-environment jsdom
 *
 * The BRIDGE announces every PTY resize as `pty:resize`.
 *
 * This is the link that was missing, and the reason this file exists rather than more
 * coverage on the helper or on the tracker. Both ENDS were already tested:
 * `RunningActivityTracker` was proven to suppress the repaint burst when a `pty:resize`
 * arrives, and it arrived in that test because the test dispatched it by hand. Nothing
 * asserted that anything in the running app ever dispatches one — and nothing did, because
 * the only dispatcher sat in `TerminalService.resizeTerminal`, whose sole caller is the
 * `onResize` prop `TerminalDisplay` discards as vestigial (spec §6.1 / §17 R2).
 *
 * So the suppression was dead in production for as long as the engine has owned the resize
 * path, with a green test over it the whole time. Zooming in Canvas Mode re-tiers nodes,
 * re-fits them and SIGWINCHes their PTYs; ConPTY answers with a full repaint; the tracker
 * read that as new activity and rang the unseen bell on idle terminals.
 *
 * Delete the `emitPtyResize` call from either function below and these tests fail. That is
 * the whole point of testing HERE: a test on `emitPtyResize` itself would prove the helper
 * dispatches, which was never in doubt, and would keep passing with nothing calling it.
 */

// Must be hoisted before any imports of the module under test.
const invokeMock = jest.fn((_cmd: string, _args?: any) => Promise.resolve(undefined));

jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invokeMock(...args),
}));

jest.mock('@tauri-apps/api/event', () => ({
  listen: jest.fn(() => Promise.resolve(() => {})),
}));

jest.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: jest.fn(() => ({ label: 'main' })),
}));

Object.defineProperty(global, 'localStorage', {
  value: { getItem: jest.fn(() => null), setItem: jest.fn() },
  writable: true,
});

// Import AFTER mocks are set up
import tauriBridge from '../tauri-bridge';

interface ResizeDetail { processId: string; cols: number; rows: number }

/** Collect every `pty:resize` fired while `run` executes. */
async function captureResizeEvents(run: () => Promise<void>): Promise<ResizeDetail[]> {
  const seen: ResizeDetail[] = [];
  const handler = (e: Event) => seen.push((e as CustomEvent).detail as ResizeDetail);
  window.addEventListener('pty:resize', handler);
  try {
    await run();
  } finally {
    window.removeEventListener('pty:resize', handler);
  }
  return seen;
}

beforeEach(() => {
  invokeMock.mockClear();
});

describe('tauriBridge resize — pty:resize announcement', () => {
  it('resizeTerminal dispatches pty:resize carrying the processId and the new grid', async () => {
    const seen = await captureResizeEvents(async () => {
      await tauriBridge.resizeTerminal('pc-abc123', 158, 35);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ processId: 'pc-abc123', cols: 158, rows: 35 });
  });

  it('resizePty — the alias — dispatches it too', async () => {
    const seen = await captureResizeEvents(async () => {
      await tauriBridge.resizePty('pc-abc123', 120, 40);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ processId: 'pc-abc123', cols: 120, rows: 40 });
  });

  /**
   * BEFORE the round-trip, so anything bracing for the SIGWINCH is armed when the redraw
   * comes back rather than a round-trip late. Asserted by ordering the announcement against
   * the `invoke` call rather than by asserting both happened — "both happened" passes with
   * the emit moved into the `.then()`, which is exactly the regression that matters.
   */
  it('announces BEFORE the backend round-trip, not after', async () => {
    const order: string[] = [];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'resize_terminal') order.push('invoke');
      return Promise.resolve(undefined);
    });
    const handler = () => order.push('event');
    window.addEventListener('pty:resize', handler);
    try {
      await tauriBridge.resizeTerminal('pc-abc123', 100, 30);
    } finally {
      window.removeEventListener('pty:resize', handler);
    }

    expect(order).toEqual(['event', 'invoke']);
  });

  /**
   * A failing resize must still have announced. The tracker's job is to brace for a repaint,
   * and a backend that rejected the call may already have resized the PTY (or be about to) —
   * swallowing the announcement on the error path would leave the burst unsuppressed in
   * exactly the case with the least information.
   */
  it('still announces when the backend call rejects', async () => {
    invokeMock.mockImplementation(() => Promise.reject(new Error('no such terminal')));

    const seen: ResizeDetail[] = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail as ResizeDetail);
    window.addEventListener('pty:resize', handler);
    try {
      await expect(tauriBridge.resizeTerminal('pc-gone', 80, 24)).rejects.toThrow();
    } finally {
      window.removeEventListener('pty:resize', handler);
    }

    expect(seen).toHaveLength(1);
  });
});
