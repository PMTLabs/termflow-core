import { TerminalEngine } from '../TerminalEngine';
import { terminalCache, HYDRATION_BUFFER_CAP_BYTES } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
// The jest moduleNameMapper points @xterm/xterm at our mock; importing the mock
// class directly lets us reach into the recorded reset()/write() calls and drive
// the captured bridge callbacks.
import { Terminal as MockTerminal } from '../__mocks__/xterm';

// ---------------------------------------------------------------------------
// Controllable fake bridge (copied from hydration.test.ts — per-file helper pattern)
// ---------------------------------------------------------------------------
interface FakeBridge extends TerminalBridge {
  pushData(processId: string, data: string): void;
  pushExit(processId: string, code: number): void;
  onDataCount: number;
  onExitCount: number;
  resizeCalls: Array<[string, number, number]>;
  writeCalls: Array<[string, string]>;
  lastDataDisposed: () => boolean;
}

interface FakeBridgeOptions {
  snapshot?: () => Promise<{ snapshot: string }>;
  history?: () => Promise<{ raw: string }>;
}

function makeFakeBridge(opts: FakeBridgeOptions = {}): FakeBridge {
  const dataCbs = new Map<string, Array<(data: string) => void>>();
  const exitCbs = new Map<string, Array<(code: number) => void>>();
  let dataDisposed = false;

  const bridge: FakeBridge = {
    onDataCount: 0,
    onExitCount: 0,
    resizeCalls: [],
    writeCalls: [],
    lastDataDisposed: () => dataDisposed,

    onData(processId, cb): Disposable {
      bridge.onDataCount += 1;
      const list = dataCbs.get(processId) ?? [];
      list.push(cb);
      dataCbs.set(processId, list);
      dataDisposed = false;
      return {
        dispose() {
          const cur = dataCbs.get(processId) ?? [];
          dataCbs.set(processId, cur.filter((c) => c !== cb));
          dataDisposed = true;
        },
      };
    },
    onExit(processId, cb): Disposable {
      bridge.onExitCount += 1;
      const list = exitCbs.get(processId) ?? [];
      list.push(cb);
      exitCbs.set(processId, list);
      return {
        dispose() {
          const cur = exitCbs.get(processId) ?? [];
          exitCbs.set(processId, cur.filter((c) => c !== cb));
        },
      };
    },
    write(processId, data) {
      bridge.writeCalls.push([processId, data]);
    },
    resize(processId, cols, rows) {
      bridge.resizeCalls.push([processId, cols, rows]);
    },

    pushData(processId, data) {
      (dataCbs.get(processId) ?? []).forEach((cb) => cb(data));
    },
    pushExit(processId, code) {
      (exitCbs.get(processId) ?? []).forEach((cb) => cb(code));
    },
  };

  if (opts.snapshot) {
    bridge.getSnapshot = (processId, cols, rows) =>
      opts.snapshot!().then((r) => ({ ...r, rows, cols }));
  }
  if (opts.history) {
    bridge.getHistory = () => opts.history!();
  }

  return bridge;
}

// jsdom gives us a real element; force a usable size so the >50px guards pass.
function makeContainer(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

function mockTerm(cacheKey: string): MockTerminal {
  const entry = terminalCache.get(cacheKey);
  if (!entry) throw new Error('no cache entry');
  return entry.terminal as unknown as MockTerminal;
}

// Let pending microtasks (the hydration coroutine's awaits) flush.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
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
});

// ---------------------------------------------------------------------------
// Generation test 1: stale hydration from a previous engine cannot clobber
// the current paint.
// ---------------------------------------------------------------------------
it('a stale hydration from a previous engine instance cannot clobber the current paint', async () => {
  // Engine A's snapshot resolves LAST (stale); engine B's resolves first (fresh).
  const resolvers: Array<(v: { snapshot: string }) => void> = [];
  const bridge = makeFakeBridge({
    snapshot: () => new Promise((r) => resolvers.push(r)),
  });

  const engineA = new TerminalEngine(bridge, { cacheKey: 'gen1' });
  engineA.mount(makeContainer());
  engineA.attach('p1');
  await flush(); // A's hydrate is now awaiting resolvers[0]
  engineA.unmount();

  // Remount under a NEW engine instance (same cacheKey) — e.g. pane re-created.
  const engineB = new TerminalEngine(bridge, { cacheKey: 'gen1' });
  engineB.mount(makeContainer());
  engineB.attach('p1'); // re-raises the gate, runs its own hydrate
  await flush();

  resolvers[1]({ snapshot: 'FRESH' }); // B commits
  await flush();
  bridge.pushData('p1', 'LIVE-AFTER'); // gate must be down → written live

  resolvers[0]({ snapshot: 'STALE' }); // A's slow run finally resolves
  await flush();
  // LIVE-AFTER is coalesced (LIVE_WRITE_COALESCE_MS=16ms); wait past the window so the
  // buffered live write lands before asserting.
  await new Promise<void>((r) => setTimeout(r, 30));

  const term = mockTerm('gen1');
  expect(term.written).toEqual(['FRESH', 'LIVE-AFTER']); // STALE never painted
  expect(term.resetCount).toBe(1); // only B's commit reset
  expect(terminalCache.get('gen1')!.hydrating).toBe(false);
});

// ---------------------------------------------------------------------------
// Generation test 2: pendingOutput cap during a hydration that never completes.
// ---------------------------------------------------------------------------
it('caps pendingOutput during a hydration that never completes', async () => {
  const bridge = makeFakeBridge({
    snapshot: () => new Promise(() => {}), // hangs forever
  });
  const engine = new TerminalEngine(bridge, { cacheKey: 'gen2' });
  engine.mount(makeContainer());
  engine.attach('p1');
  await flush();

  const chunk = 'x'.repeat(1_000_000);
  for (let i = 0; i < 6; i += 1) bridge.pushData('p1', chunk);

  const entry = terminalCache.get('gen2')!;
  const total = entry.pendingOutput.reduce((n, s) => n + s.length, 0);
  expect(total).toBeLessThanOrEqual(HYDRATION_BUFFER_CAP_BYTES); // tail kept, oldest dropped
  // Tail kept (newest chunks survive), oldest dropped — not the reverse.
  expect(entry.pendingOutput[entry.pendingOutput.length - 1]).toBe(chunk);
  expect(entry.pendingOutput.length).toBeLessThan(6);
  expect(entry.pendingOutputBytes).toBe(total);
});
