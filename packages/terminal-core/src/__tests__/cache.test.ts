import {
  terminalCache,
  cleanupTerminalCache,
  MAX_TERMINAL_CACHE_ENTRIES,
  setAgentColorLock,
  refreshGlyphAtlases,
} from '../cache';
import type { TerminalCacheEntry } from '../cache';
import {
  countActiveWebGLAddons,
  getQuarantinedWebGLAddonCount,
  releaseFromWebGLQuarantine,
} from '../renderPolicy';
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
    containerDisposables: [],
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
    containerDisposables: [],
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
    containerDisposables: [],
  } as unknown as TerminalCacheEntry;
  terminalCache.set('t3', entry);
  // Captured BEFORE cleanup: rev 11 nulls `entry.webglAddon` on the failure path
  // like every sibling site, so reading it afterwards would hand `release` a null.
  const wedged = entry.webglAddon;

  // The defensive try/catch around webglAddon.dispose() must not abort cleanup.
  expect(() => cleanupTerminalCache('t3')).not.toThrow();

  expect(disposed).toContain('term');
  expect(terminalCache.has('t3')).toBe(false);

  // ...and the addon it could not dispose is QUARANTINED, not dropped (review 136).
  // This test already arranged the exact failure it needed; up to rev 8 it asserted
  // only that cleanup survived it, and was blind to the invariant that matters.
  // Retention — the remedy resetTerminalRendering and disableWebGLGlobally use — is
  // not available here, because the entry is deleted three statements later.
  expect(getQuarantinedWebGLAddonCount()).toBe(1);
  // The COUNT, not the call: a spy on quarantineWebGLAddon would repeat the same
  // blindness. This is what ORPHAN's `live === reachable + quarantined` asserts, and
  // it is what a later webglAllowedAtCreation() actually consults.
  expect(countActiveWebGLAddons()).toBe(1);

  // The entry's own field is cleared too, so nothing can later "dispose" it into a
  // false success, and a throwing terminal.dispose() cannot leave it double-counted.
  expect(entry.webglAddon).toBeNull();

  releaseFromWebGLQuarantine(wedged);
  expect(countActiveWebGLAddons()).toBe(0);
});

test('cleanupTerminalCache disposes protocolDisposables (backlog 003)', () => {
  const disposed: string[] = [];
  const entry = {
    terminal: { dispose: () => disposed.push('term') },
    fitAddon: {},
    webglAddon: null,
    useWebGL: false,
    hydrating: false,
    pendingOutput: [],
    disposables: [() => disposed.push('d1')],
    containerDisposables: [],
    protocolDisposables: [() => disposed.push('proto1'), () => disposed.push('proto2')],
  } as unknown as TerminalCacheEntry;
  terminalCache.set('t-proto', entry);

  cleanupTerminalCache('t-proto');

  expect(disposed).toEqual(['d1', 'proto1', 'proto2', 'term']);
  expect(terminalCache.has('t-proto')).toBe(false);
});

test('cleanupTerminalCache: a throwing protocolDisposable still lets the rest tear down', () => {
  const disposed: string[] = [];
  const entry = {
    terminal: { dispose: () => disposed.push('term') },
    fitAddon: {},
    webglAddon: null,
    useWebGL: false,
    hydrating: false,
    pendingOutput: [],
    disposables: [],
    containerDisposables: [],
    protocolDisposables: [
      () => {
        throw new Error('boom');
      },
      () => disposed.push('proto2'),
    ],
  } as unknown as TerminalCacheEntry;
  terminalCache.set('t-proto-throw', entry);

  expect(() => cleanupTerminalCache('t-proto-throw')).not.toThrow();

  expect(disposed).toEqual(['proto2', 'term']);
  expect(terminalCache.has('t-proto-throw')).toBe(false);
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
    containerDisposables: [],
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

// --- mount()-end cache rebuild must not drop fields it doesn't explicitly list -----
//
// TerminalEngine's mount()-end rebuild (the delete-then-set that reorders the Map key
// for LRU) used to copy the cache entry field-by-field into a fresh object literal.
// Any TerminalCacheEntry field NOT named in that literal was silently dropped on every
// remount. agentColorLocked/lastSnapshot/lastDataAt/lastInputAt were the four fields
// missing from the literal (see terminal-cache-drops-fields-on-mount memory note).

it('a remount preserves agentColorLocked, lastSnapshot, lastDataAt and lastInputAt', () => {
  const cacheKey = 'field-preserve';

  const engine1 = new TerminalEngine(makeFakeBridge(), { cacheKey });
  engine1.mount(makeContainer());

  const beforeRemount = terminalCache.get(cacheKey)!;
  beforeRemount.agentColorLocked = true;
  beforeRemount.lastSnapshot = 'snapshot-marker';
  beforeRemount.lastDataAt = 111;
  beforeRemount.lastInputAt = 222;

  engine1.unmount();

  // A fresh engine on the SAME cacheKey (e.g. a tab switch) takes the reattach
  // path, which ends in the delete-then-set rebuild under test.
  const engine2 = new TerminalEngine(makeFakeBridge(), { cacheKey });
  engine2.mount(makeContainer());

  const afterRemount = terminalCache.get(cacheKey)!;
  expect(afterRemount.agentColorLocked).toBe(true);
  expect(afterRemount.lastSnapshot).toBe('snapshot-marker');
  expect(afterRemount.lastDataAt).toBe(111);
  expect(afterRemount.lastInputAt).toBe(222);

  engine2.unmount();
});

// --- refreshGlyphAtlases (standby/resume blank-text repair) ---------------------

function webglEntry(onClear: () => void) {
  return {
    webglAddon: { clearTextureAtlas: onClear },
    useWebGL: true,
  } as unknown as TerminalCacheEntry;
}

test('refreshGlyphAtlases clears the texture atlas on every WebGL terminal', () => {
  const cleared: string[] = [];
  terminalCache.set('g1', webglEntry(() => cleared.push('g1')));
  terminalCache.set('g2', webglEntry(() => cleared.push('g2')));

  refreshGlyphAtlases();

  expect(cleared).toEqual(['g1', 'g2']);
});

test('refreshGlyphAtlases skips terminals with no WebGL addon (DOM renderer / context already lost)', () => {
  terminalCache.set('dom', {
    webglAddon: null,
    useWebGL: false,
  } as unknown as TerminalCacheEntry);

  expect(() => refreshGlyphAtlases()).not.toThrow();
});

test('refreshGlyphAtlases: a throwing addon does not stop the remaining terminals', () => {
  const cleared: string[] = [];
  // Insertion order is iteration order, so the thrower runs first.
  terminalCache.set('bad', webglEntry(() => {
    throw new Error('context gone');
  }));
  terminalCache.set('good', webglEntry(() => cleared.push('good')));

  expect(() => refreshGlyphAtlases()).not.toThrow();
  expect(cleared).toEqual(['good']);
});

// ---------------------------------------------------------------------------
// rev 11 (pre-review `140`) — H1: a throwing terminal.dispose() must not strand
// the entry, and must not leave a quarantined addon double-counted.
// ---------------------------------------------------------------------------

test('cleanupTerminalCache: a throwing terminal.dispose() still removes the entry', () => {
  const entry = {
    terminal: { dispose: () => { throw new Error('test: addon manager threw'); } },
    fitAddon: {},
    webglAddon: null,
    useWebGL: false,
    hydrating: false,
    pendingOutput: [],
    disposables: [],
    containerDisposables: [],
  } as unknown as TerminalCacheEntry;
  terminalCache.set('t-term-throws', entry);

  // Every other teardown step in this function was already isolated; this one was
  // not, so the throw propagated and skipped the delete below it.
  expect(() => cleanupTerminalCache('t-term-throws')).not.toThrow();
  expect(terminalCache.has('t-term-throws')).toBe(false);
});

test('cleanupTerminalCache: a quarantined addon is not double-counted when terminal.dispose() throws', () => {
  // BOTH failures at once — the H1 scenario. Before rev 11 the entry survived (the
  // delete was skipped) still holding `webglAddon`, while the SAME addon sat in the
  // quarantine: countActiveWebGLAddons() counted it twice and ORPHAN broke upward.
  const wedged = { dispose: () => { throw new Error('test: driver wedged'); } };
  const entry = {
    terminal: { dispose: () => { throw new Error('test: addon manager threw'); } },
    fitAddon: {},
    webglAddon: wedged,
    useWebGL: true,
    hydrating: false,
    pendingOutput: [],
    disposables: [],
    containerDisposables: [],
  } as unknown as TerminalCacheEntry;
  terminalCache.set('t-both-throw', entry);
  expect(countActiveWebGLAddons()).toBe(1);

  expect(() => cleanupTerminalCache('t-both-throw')).not.toThrow();

  expect(terminalCache.has('t-both-throw')).toBe(false);
  expect(getQuarantinedWebGLAddonCount()).toBe(1);
  // ONE, not two. This is the assertion the finding is about.
  expect(countActiveWebGLAddons()).toBe(1);

  releaseFromWebGLQuarantine(wedged);
  expect(countActiveWebGLAddons()).toBe(0);
});
