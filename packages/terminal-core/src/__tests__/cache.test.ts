import { terminalCache, cleanupTerminalCache, MAX_TERMINAL_CACHE_ENTRIES, setAgentColorLock } from '../cache';
import type { TerminalCacheEntry } from '../cache';
import { TerminalEngine } from '../TerminalEngine';
import type { TerminalBridge, Disposable } from '../types';

function fakeEntry() {
  const disposed: string[] = [];
  const entry = {
    terminal: { dispose: () => disposed.push('term') },
    fitAddon: {},
    webglAddon: { dispose: () => disposed.push('webgl') },
    useWebGL: true,
    hydrating: false,
    pendingOutput: [],
    disposables: [() => disposed.push('d1')],
    dataDisposable: { dispose: () => disposed.push('data') },
    exitDisposable: { dispose: () => disposed.push('exit') },
  } as unknown as TerminalCacheEntry;
  return { entry, disposed };
}

afterEach(() => {
  terminalCache.clear();
});

test('cleanupTerminalCache disposes webgl, disposables, R1 subscriptions, terminal then removes entry', () => {
  const { entry, disposed } = fakeEntry();
  terminalCache.set('t1', entry);

  cleanupTerminalCache('t1');

  // Order matches the legacy renderer teardown (webgl → disposables → terminal),
  // with the §17 R1 cache-lifetime subscriptions disposed before the terminal teardown.
  expect(disposed).toEqual(['webgl', 'd1', 'data', 'exit', 'term']);
  expect(terminalCache.has('t1')).toBe(false);
});

test('cleanupTerminalCache is a no-op for an unknown key', () => {
  expect(() => cleanupTerminalCache('missing')).not.toThrow();
});

test('setAgentColorLock toggles agentColorLocked on cached entries and skips unknown ids', () => {
  const { entry } = fakeEntry();
  terminalCache.set('t-lock', entry);

  setAgentColorLock(['t-lock'], true);
  expect(terminalCache.get('t-lock')!.agentColorLocked).toBe(true);

  setAgentColorLock(['t-lock'], false);
  expect(terminalCache.get('t-lock')!.agentColorLocked).toBe(false);

  // A not-yet-cached terminal is skipped, not created.
  expect(() => setAgentColorLock(['missing'], true)).not.toThrow();
  expect(terminalCache.has('missing')).toBe(false);
});

test('cleanupTerminalCache works when R1 subscriptions are absent', () => {
  const disposed: string[] = [];
  const entry = {
    terminal: { dispose: () => disposed.push('term') },
    fitAddon: {},
    webglAddon: null,
    useWebGL: false,
    hydrating: false,
    pendingOutput: [],
    disposables: [() => disposed.push('d1')],
  } as unknown as TerminalCacheEntry;
  terminalCache.set('t2', entry);

  cleanupTerminalCache('t2');

  expect(disposed).toEqual(['d1', 'term']);
  expect(terminalCache.has('t2')).toBe(false);
});

test('cleanupTerminalCache: a throwing webglAddon.dispose() still tears down the terminal and removes the entry', () => {
  const disposed: string[] = [];
  const entry = {
    terminal: { dispose: () => disposed.push('term') },
    fitAddon: {},
    webglAddon: {
      dispose: () => {
        throw new Error('boom');
      },
    },
    useWebGL: true,
    hydrating: false,
    pendingOutput: [],
    disposables: [() => disposed.push('d1')],
  } as unknown as TerminalCacheEntry;
  terminalCache.set('t3', entry);

  // The defensive try/catch around webglAddon.dispose() must not abort cleanup.
  expect(() => cleanupTerminalCache('t3')).not.toThrow();

  expect(disposed).toContain('term');
  expect(terminalCache.has('t3')).toBe(false);
});

test('cleanupTerminalCache: a throwing local disposable still lets data/exit subs + terminal dispose and removes the entry', () => {
  const disposed: string[] = [];
  const entry = {
    terminal: { dispose: () => disposed.push('term') },
    fitAddon: {},
    webglAddon: null,
    useWebGL: false,
    hydrating: false,
    pendingOutput: [],
    // The first local disposable throws; the guarded loop must still run the
    // remaining disposable and let the §17 R1 subs + terminal tear down.
    disposables: [
      () => {
        throw new Error('boom');
      },
      () => disposed.push('d2'),
    ],
    dataDisposable: { dispose: () => disposed.push('data') },
    exitDisposable: { dispose: () => disposed.push('exit') },
  } as unknown as TerminalCacheEntry;
  terminalCache.set('t4', entry);

  expect(() => cleanupTerminalCache('t4')).not.toThrow();

  // The throwing disposable must not strand the cache-lifetime data/exit subs.
  expect(disposed).toEqual(['d2', 'data', 'exit', 'term']);
  expect(terminalCache.has('t4')).toBe(false);
});

// ---------------------------------------------------------------------------
// LRU cap tests — helpers copied from hydration.test.ts
// ---------------------------------------------------------------------------

function makeFakeBridge(): TerminalBridge {
  return {
    onData(_processId: string, _cb: (data: string) => void): Disposable {
      return { dispose() {} };
    },
    onExit(_processId: string, _cb: (code: number) => void): Disposable {
      return { dispose() {} };
    },
    write(_processId: string, _data: string): void {},
    resize(_processId: string, _cols: number, _rows: number): void {},
  };
}

function makeContainer(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  if (typeof (global as any).ResizeObserver === 'undefined') {
    (global as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    };
  }
});

it('evicts the least-recently-mounted DISCONNECTED entries beyond the cap', () => {
  for (let i = 0; i < 60; i += 1) {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: `cap-${i}` });
    const el = makeContainer();
    engine.mount(el);
    engine.unmount();
    el.remove(); // simulates React removing the pane container
  }
  expect(terminalCache.size).toBeLessThanOrEqual(50);
  expect(terminalCache.has('cap-0')).toBe(false); // oldest evicted
  expect(terminalCache.has('cap-59')).toBe(true); // newest kept
});

it('never evicts an entry whose element is still in the DOM', () => {
  const keep = new TerminalEngine(makeFakeBridge(), { cacheKey: 'cap-live' });
  keep.mount(makeContainer()); // stays connected
  for (let i = 0; i < 60; i += 1) {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: `cap2-${i}` });
    const el = makeContainer();
    engine.mount(el);
    engine.unmount();
    el.remove();
  }
  expect(terminalCache.has('cap-live')).toBe(true);
  expect(terminalCache.size).toBeLessThanOrEqual(MAX_TERMINAL_CACHE_ENTRIES);
});
