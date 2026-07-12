import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';
// The jest moduleNameMapper points @xterm/xterm at our mock; importing the mock
// class directly lets us reach into the recorded reset()/write() calls and drive
// the captured bridge callbacks.
import { Terminal as MockTerminal } from '../__mocks__/xterm';

// ---------------------------------------------------------------------------
// Controllable fake bridge
//
// Records the onData/onExit callbacks so a test can push chunks at a precise
// moment (e.g. mid-hydration). getSnapshot/getHistory/resize are deferred via
// pending promises so a test can interleave a pushed chunk BETWEEN subscribe and
// the synchronous snapshot-commit. write() is recorded for the input path.
// ---------------------------------------------------------------------------
interface FakeBridge extends TerminalBridge {
  // Drive these to simulate backend output / process exit.
  pushData(processId: string, data: string): void;
  pushExit(processId: string, code: number): void;
  // Call counts / recorded args.
  onDataCount: number;
  onExitCount: number;
  resizeCalls: Array<[string, number, number]>;
  writeCalls: Array<[string, string]>;
  // The most-recently-registered disposables (so tests can assert dispose).
  lastDataDisposed: () => boolean;
}

interface FakeBridgeOptions {
  // What getSnapshot resolves to (when a function). Use a function so each call
  // can be controlled; `undefined` means "no getSnapshot on the bridge".
  snapshot?: () => Promise<{ snapshot: string }>;
  // What getHistory resolves to. `undefined` means "no getHistory on the bridge".
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
// Live output is coalesced (LIVE_WRITE_COALESCE_MS = 16ms in TerminalEngine), so a write
// pushed via the bridge lands on xterm one frame later. Await this past that window
// before asserting term.written for LIVE (post-hydration) chunks.
const flushLive = () => new Promise<void>((r) => setTimeout(r, 30));

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
});

// ---------------------------------------------------------------------------
// 1. snapshot present → reset() then write(snapshot); a chunk pushed DURING the
//    snapshot await is dropped (it lands in pendingOutput which the snapshot path
//    clears).
// ---------------------------------------------------------------------------
test('snapshot present: reset+write(snapshot); mid-await chunk dropped', async () => {
  // Resolve the snapshot on a deferred promise so we can push a chunk while the
  // hydration coroutine is awaiting it.
  let resolveSnap!: (v: { snapshot: string }) => void;
  const snapPromise = new Promise<{ snapshot: string }>((res) => {
    resolveSnap = res;
  });
  const bridge = makeFakeBridge({ snapshot: () => snapPromise });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h1' });
  engine.mount(makeContainer());
  engine.attach('p1');

  const term = mockTerm('h1');

  // While hydrating (snapshot not yet resolved), a live chunk must BUFFER.
  bridge.pushData('p1', 'LIVE-DURING-AWAIT');
  expect(term.written).not.toContain('LIVE-DURING-AWAIT'); // buffered, not written

  // Now resolve the snapshot and let the synchronous commit run.
  resolveSnap({ snapshot: 'SNAP' });
  await flush();

  // reset() ran (resetCount bumped) and the snapshot was written after reset.
  // (The mock's reset() clears `written`, so after reset the array starts fresh.)
  expect(term.resetCount).toBe(1);
  expect(term.written).toEqual(['SNAP']);
  // The buffered chunk was dropped (already reflected in snapshot).
  expect(term.written).not.toContain('LIVE-DURING-AWAIT');
  expect(terminalCache.get('h1')!.pendingOutput).toEqual([]);
  expect(terminalCache.get('h1')!.lastHydratedProcessId).toBe('p1');
  expect(terminalCache.get('h1')!.hydrating).toBe(false);
});

// ---------------------------------------------------------------------------
// 2. snapshot empty → no reset; a chunk pushed during hydration is FLUSHED
//    (written) after.
// ---------------------------------------------------------------------------
test('snapshot empty: no reset; mid-hydration chunk flushed after', async () => {
  let resolveSnap!: (v: { snapshot: string }) => void;
  const snapPromise = new Promise<{ snapshot: string }>((res) => {
    resolveSnap = res;
  });
  const bridge = makeFakeBridge({ snapshot: () => snapPromise });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h2' });
  engine.mount(makeContainer());
  engine.attach('p1');

  const term = mockTerm('h2');

  bridge.pushData('p1', 'BUFFERED');
  expect(term.written).not.toContain('BUFFERED');

  resolveSnap({ snapshot: '' }); // empty snapshot
  await flush();

  expect(term.resetCount).toBe(0); // no reset on empty snapshot
  expect(term.written).toEqual(['BUFFERED']); // flushed exactly once
  expect(terminalCache.get('h2')!.pendingOutput).toEqual([]);
  expect(terminalCache.get('h2')!.hydrating).toBe(false);
});

// ---------------------------------------------------------------------------
// 3. getSnapshot throws → getHistory replayed (reset+write raw), then pending
//    appended.
// ---------------------------------------------------------------------------
test('getSnapshot throws: history replayed then pending appended', async () => {
  const bridge = makeFakeBridge({
    snapshot: () => Promise.reject(new Error('snap boom')),
    history: () => Promise.resolve({ raw: 'HISTORY' }),
  });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h3' });
  engine.mount(makeContainer());
  engine.attach('p1');

  const term = mockTerm('h3');

  // Push a chunk before the rejection settles — buffers while hydrating.
  bridge.pushData('p1', 'PENDING');

  await flush();

  // History replay reset+wrote raw, then the non-duplicated pending was appended.
  expect(term.resetCount).toBe(1);
  // After reset() the written array is cleared, so it should contain raw then pending.
  expect(term.written).toEqual(['HISTORY', 'PENDING']);
  expect(terminalCache.get('h3')!.hydrating).toBe(false);
  expect(terminalCache.get('h3')!.lastHydratedProcessId).toBe('p1');
});

// ---------------------------------------------------------------------------
// 4. mid-hydration chunk buffered then flushed EXACTLY ONCE (no duplication).
// ---------------------------------------------------------------------------
test('mid-hydration chunk flushed exactly once (no duplication)', async () => {
  let resolveSnap!: (v: { snapshot: string }) => void;
  const snapPromise = new Promise<{ snapshot: string }>((res) => {
    resolveSnap = res;
  });
  const bridge = makeFakeBridge({ snapshot: () => snapPromise });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h4' });
  engine.mount(makeContainer());
  engine.attach('p1');

  const term = mockTerm('h4');

  bridge.pushData('p1', 'ONCE');
  resolveSnap({ snapshot: '' }); // empty → flush path
  await flush();

  // Exactly one occurrence of the chunk in the written log.
  const count = term.written.filter((w) => w === 'ONCE').length;
  expect(count).toBe(1);
});

// ---------------------------------------------------------------------------
// 5. cache-lifetime delivery: subscription survives unmount(); torn down by
//    dispose()/cleanupTerminalCache.
// ---------------------------------------------------------------------------
test('cache-lifetime delivery: survives unmount, torn down by dispose', async () => {
  const bridge = makeFakeBridge({ snapshot: () => Promise.resolve({ snapshot: '' }) });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h5' });
  engine.mount(makeContainer());
  engine.attach('p1');
  await flush(); // finish hydration so hydrating=false

  const term = mockTerm('h5');

  // Delivery works while mounted.
  bridge.pushData('p1', 'A');
  await flushLive();
  expect(term.written).toContain('A');

  // Unmount must NOT dispose the cache-lifetime subscription.
  engine.unmount();
  expect(terminalCache.has('h5')).toBe(true);
  expect(bridge.lastDataDisposed()).toBe(false);

  // Output STILL flows to the cached terminal after unmount (background delivery).
  bridge.pushData('p1', 'B');
  await flushLive();
  expect(term.written).toContain('B');

  // dispose() tears everything down via cleanupTerminalCache.
  engine.dispose();
  expect(terminalCache.has('h5')).toBe(false);
  expect(bridge.lastDataDisposed()).toBe(true);

  // Pushing after dispose does nothing (callback was removed).
  const before = term.written.length;
  bridge.pushData('p1', 'C');
  expect(term.written.length).toBe(before);
});

// ---------------------------------------------------------------------------
// 6. idempotent attach: attach('p') twice → onData subscribed exactly once; no
//    double-write of a subsequent chunk.
// ---------------------------------------------------------------------------
test('idempotent attach: subscribe once, single delivery', async () => {
  const bridge = makeFakeBridge({ snapshot: () => Promise.resolve({ snapshot: 'S' }) });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h6' });
  engine.mount(makeContainer());

  engine.attach('p1');
  await flush(); // hydration done → lastHydratedProcessId='p1'
  engine.attach('p1'); // second attach: must be a no-op (idempotent)
  await flush();

  expect(bridge.onDataCount).toBe(1);
  expect(bridge.onExitCount).toBe(1);

  const term = mockTerm('h6');
  const before = term.written.length;
  bridge.pushData('p1', 'X');
  await flushLive();
  // Exactly one write of X (single live subscription).
  expect(term.written.length).toBe(before + 1);
  expect(term.written.filter((w) => w === 'X').length).toBe(1);
});

// ---------------------------------------------------------------------------
// 6a. double-attach to the SAME processId while hydration is in flight: the
//     redundant second attach must NOT fire a second getSnapshot (one in-flight
//     hydration already covers it). Mirrors the wrapper's [terminalId]+[processId]
//     effects both calling attach(processId) on first mount.
// ---------------------------------------------------------------------------
test('double attach (same pid, mid-flight): getSnapshot called exactly once', async () => {
  // Deferred snapshot so the SECOND attach lands while hydration is still awaiting.
  let resolveSnap!: (v: { snapshot: string }) => void;
  const snapPromise = new Promise<{ snapshot: string }>((res) => {
    resolveSnap = res;
  });
  let snapshotCalls = 0;
  const bridge = makeFakeBridge({
    snapshot: () => {
      snapshotCalls += 1;
      return snapPromise;
    },
  });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h6a' });
  engine.mount(makeContainer());

  // Two synchronous attaches to the SAME processId, before the first resolves.
  // (getSnapshot itself is reached only after the awaited pre-hydration resize,
  // so it hasn't fired yet at this synchronous point — we assert the total below.)
  engine.attach('p1');
  engine.attach('p1');

  // Resolve and let the single hydration commit.
  resolveSnap({ snapshot: 'SNAP' });
  await flush();

  // The second attach short-circuited: exactly ONE snapshot fetch total (had it
  // re-hydrated, a second getSnapshot RPC would have fired → snapshotCalls === 2).
  expect(snapshotCalls).toBe(1);

  const term = mockTerm('h6a');
  // Exactly one hydration commit: reset once, snapshot written once.
  expect(term.resetCount).toBe(1);
  expect(term.written).toEqual(['SNAP']);
  // Subscribed exactly once (needsSubscribe guard).
  expect(bridge.onDataCount).toBe(1);
  expect(terminalCache.get('h6a')!.lastHydratedProcessId).toBe('p1');
});

// ---------------------------------------------------------------------------
// 6b. re-target attach (processId changed): prior subs disposed, re-subscribed,
//     re-hydrated against the new process. Old-process output stops; new flows.
// ---------------------------------------------------------------------------
test('re-target attach: disposes prior subs, re-subscribes + re-hydrates', async () => {
  const bridge = makeFakeBridge({ snapshot: () => Promise.resolve({ snapshot: '' }) });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h6b' });
  engine.mount(makeContainer());

  engine.attach('p1');
  await flush();
  expect(bridge.onDataCount).toBe(1);

  // Re-target to a new processId.
  engine.attach('p2');
  await flush();

  // Prior sub disposed + a fresh one created (2 total onData subscriptions).
  expect(bridge.onDataCount).toBe(2);
  expect(terminalCache.get('h6b')!.processId).toBe('p2');
  expect(terminalCache.get('h6b')!.lastHydratedProcessId).toBe('p2');

  const term = mockTerm('h6b');
  const before = term.written.length;
  // Output for the OLD process no longer reaches us (its cb was disposed).
  bridge.pushData('p1', 'OLD');
  expect(term.written.length).toBe(before);
  // Output for the NEW process flows.
  bridge.pushData('p2', 'NEW');
  await flushLive();
  expect(term.written).toContain('NEW');
});

// ---------------------------------------------------------------------------
// 7. Input modes appended to the snapshot (backend /snapshot) are re-asserted on
//    the fresh xterm, so an agent CLI that was ALREADY running when this window
//    (re)hydrated still suppresses command capture / the suggest popup. Without
//    the appended modes a window reload mid-codex-session leaked its prompts.
// ---------------------------------------------------------------------------
test('snapshot-appended focus mode suppresses command capture after rehydration', async () => {
  const bridge = makeFakeBridge({
    // codex screen content + the backend's input-mode restore tail.
    snapshot: () => Promise.resolve({ snapshot: '> codex ui\x1b[?1004h' }),
  });
  const submitted: string[] = [];
  const engine = new TerminalEngine(bridge, {
    cacheKey: 'h7',
    commandSuggestions: () => true,
    onCommandSubmitted: (c: string) => submitted.push(c),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  engine.mount(makeContainer());
  engine.attach('p1');
  await flush();

  const term = mockTerm('h7');
  expect(term.modes.sendFocusMode).toBe(true); // mode replayed from snapshot

  // User types into the still-running CLI: nothing may reach history.
  term.__setLine(0, '> ');
  term.__setCursor(2, 0);
  term.emitData('c');
  term.__setLine(0, '> cd demo');
  term.__setCursor(9, 0);
  term.emitData('\r');
  expect(submitted).toEqual([]);
});

// ---------------------------------------------------------------------------
// 7. stale-entry safety: the onData callback resolves the entry via
//    terminalCache.get(cacheKey) AT CALL TIME, so swapping the entry's terminal
//    routes writes to the CURRENT one.
// ---------------------------------------------------------------------------
test('stale-entry safety: onData re-gets entry at call time', async () => {
  const bridge = makeFakeBridge({ snapshot: () => Promise.resolve({ snapshot: '' }) });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h7' });
  engine.mount(makeContainer());
  engine.attach('p1');
  await flush();

  // Simulate the mount-reuse path replacing the entry OBJECT with a fresh terminal
  // (the cache-lifetime subscription was captured before this swap).
  const oldEntry = terminalCache.get('h7')!;
  const newTerm = new MockTerminal({});
  terminalCache.set('h7', {
    ...oldEntry,
    terminal: newTerm as any,
    pendingOutput: [],
    hydrating: false,
  });

  bridge.pushData('p1', 'NEW');
  await flushLive();

  // The write went to the CURRENT terminal, not the stale one captured at subscribe.
  expect(newTerm.written).toContain('NEW');
  expect((oldEntry.terminal as unknown as MockTerminal).written).not.toContain('NEW');
});

// ---------------------------------------------------------------------------
// Exit banner fires exactly once (R1 #3).
// ---------------------------------------------------------------------------
test('exit banner written exactly once', async () => {
  const bridge = makeFakeBridge({ snapshot: () => Promise.resolve({ snapshot: '' }) });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h8' });
  engine.mount(makeContainer());
  engine.attach('p1');
  await flush();

  const term = mockTerm('h8');
  bridge.pushExit('p1', 0);

  const banners = term.written.filter((w) => w === '\r\n[Process exited with code 0]\r\n');
  expect(banners.length).toBe(1);
});

// ---------------------------------------------------------------------------
// One-shot protocol handshakes inside chunks the snapshot path DROPS must still
// reach protocol state. ConPTY sends CSI ?9001h (Win32-Input-Mode) as the FIRST
// output chunk of every Windows session — it races hydration, buffers into
// pendingOutput, and the snapshot commit then discards it (a snapshot reproduces
// screen CONTENT, never mode side-effects). The handshake never repeats, so
// without applying it before the drop the whole session is stuck on legacy
// encoding. (Live bug: found in manual acceptance testing of PR #2 — every
// fresh Windows tab lost the handshake this way.)
// ---------------------------------------------------------------------------
function hydrationKeyEvent(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown', key: 'a', ctrlKey: false, altKey: false,
    shiftKey: false, metaKey: false, repeat: false,
    preventDefault() {}, stopPropagation() {},
    ...over,
  } as unknown as KeyboardEvent;
}

test('win32 ?9001h handshake dropped by snapshot hydration still enables Win32-Input-Mode', async () => {
  let resolveSnap!: (v: { snapshot: string }) => void;
  const snapPromise = new Promise<{ snapshot: string }>((res) => {
    resolveSnap = res;
  });
  const bridge = makeFakeBridge({ snapshot: () => snapPromise });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h10', isWindows: true });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('h10');

  // ConPTY's real first chunk (captured live): handshake + focus mode + clear.
  bridge.pushData('p1', '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J');

  // Snapshot resolves NON-empty (the backend parser already consumed that chunk),
  // so the snapshot branch drops pendingOutput without parsing it.
  resolveSnap({ snapshot: 'PS D:\\> ' });
  await flush();
  expect(terminalCache.get('h10')!.pendingOutput).toEqual([]); // dropped, as designed

  // …but the protocol state must have been applied BEFORE the drop: Shift+Enter
  // now encodes as a Win32-Input-Mode record, not the legacy LF shim.
  const handled = term.keyHandler!(hydrationKeyEvent({ key: 'Enter', keyCode: 13, shiftKey: true }));
  expect(handled).toBe(false);
  expect(bridge.writeCalls).toContainEqual(['p1', '\x1b[13;28;13;1;16;1_']);
  expect(bridge.writeCalls).not.toContainEqual(['p1', '\n']); // LF shim must NOT fire
});

test('dropped-chunk handshake scan preserves order: ?9001h then ?9001l -> stays legacy', async () => {
  let resolveSnap!: (v: { snapshot: string }) => void;
  const snapPromise = new Promise<{ snapshot: string }>((res) => {
    resolveSnap = res;
  });
  const bridge = makeFakeBridge({ snapshot: () => snapPromise });

  const engine = new TerminalEngine(bridge, { cacheKey: 'h11', isWindows: true });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm('h11');

  // Both the enable AND a later disable land in the dropped window: last wins.
  bridge.pushData('p1', '\x1b[?9001h\x1b[2J');
  bridge.pushData('p1', '\x1b[?9001l');

  resolveSnap({ snapshot: 'PS D:\\> ' });
  await flush();

  // Shift+Enter falls back to the LF shim (legacy path) — no Win32 record.
  const handled = term.keyHandler!(hydrationKeyEvent({ key: 'Enter', keyCode: 13, shiftKey: true }));
  expect(handled).toBe(false);
  expect(bridge.writeCalls).toContainEqual(['p1', '\n']);
  expect(bridge.writeCalls).not.toContainEqual(['p1', '\x1b[13;28;13;1;16;1_']);
});

// ---------------------------------------------------------------------------
// No-getSnapshot bridge degrades gracefully (snapshot path skipped → flush pending).
// ---------------------------------------------------------------------------
test('bridge without getSnapshot degrades to pending flush (no reset)', async () => {
  const bridge = makeFakeBridge(); // no snapshot, no history

  const engine = new TerminalEngine(bridge, { cacheKey: 'h9' });
  engine.mount(makeContainer());
  engine.attach('p1');

  const term = mockTerm('h9');
  bridge.pushData('p1', 'NOSNAP');
  await flush();

  expect(term.resetCount).toBe(0);
  expect(term.written).toEqual(['NOSNAP']);
  expect(terminalCache.get('h9')!.lastHydratedProcessId).toBe('p1');
});
