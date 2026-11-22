import {
  terminalCache,
  cleanupTerminalCache,
  MAX_TERMINAL_CACHE_ENTRIES,
  setAgentColorLock,
  refreshGlyphAtlases,
  getTerminalScreenFingerprint,
  areTerminalScreenFingerprintsEqual,
  hasTerminalPendingWrites,
  flushTerminalLiveWrites,
  drainTerminalWrites,
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

describe('getTerminalScreenFingerprint & areTerminalScreenFingerprintsEqual', () => {
  test('returns null for unknown terminal or hydrating terminal', () => {
    expect(getTerminalScreenFingerprint('unknown-terminal')).toBeNull();

    const hydratingEntry = {
      terminal: { rows: 24, cols: 80, buffer: { active: { type: 'normal', baseY: 0, length: 24, getLine: () => undefined } } },
      hydrating: true,
    } as unknown as TerminalCacheEntry;
    terminalCache.set('t-hydrating', hydratingEntry);
    expect(getTerminalScreenFingerprint('t-hydrating')).toBeNull();
  });

  test('returns null when terminal has pending writes or coalesced buffer', () => {
    const entry = {
      terminal: { rows: 24, cols: 80, buffer: { active: { type: 'normal', baseY: 0, length: 24, getLine: () => undefined } } },
      hydrating: false,
      liveWriteBuf: 'pending text',
    } as unknown as TerminalCacheEntry;
    terminalCache.set('t-pending', entry);
    expect(hasTerminalPendingWrites('t-pending')).toBe(true);
    expect(getTerminalScreenFingerprint('t-pending')).toBeNull();

    // After flush, pending writes are cleared
    entry.liveWriteBuf = '';
    expect(hasTerminalPendingWrites('t-pending')).toBe(false);
  });

  test('captures visible rows, buffer type, and geometry', () => {
    const lines = ['user@host:~$ ', '', ''];
    let nullCellReused = false;
    const mockNullCell = {};
    const mockTerm = {
      rows: 3,
      cols: 80,
      buffer: {
        active: {
          type: 'normal',
          baseY: 0,
          length: 3,
          getNullCell: () => mockNullCell,
          getLine: (idx: number) => ({
            length: lines[idx]?.length ?? 0,
            translateToString: (trim?: boolean, start?: number, end?: number) => (trim ? lines[idx]?.trimEnd() ?? '' : lines[idx] ?? ''),
            getCell: (_col: number, cell?: any) => {
              if (cell === mockNullCell) nullCellReused = true;
              return {
                getFgColor: () => 7,
                getBgColor: () => 0,
                isBold: () => false,
                isItalic: () => false,
              };
            },
          }),
        },
      },
    };
    terminalCache.set('t-visible', {
      terminal: mockTerm,
      hydrating: false,
    } as unknown as TerminalCacheEntry);

    const fp = getTerminalScreenFingerprint('t-visible');
    expect(fp).not.toBeNull();
    expect(fp?.terminalId).toBe('t-visible');
    expect(fp?.bufferType).toBe('normal');
    expect(fp?.cols).toBe(80);
    expect(fp?.rows).toBe(3);
    expect(fp?.lines).toEqual(['user@host:~$', '', '']);
    expect(fp?.attrHash).toBeDefined();
    expect(nullCellReused).toBe(true);
  });

  test('areTerminalScreenFingerprintsEqual checks every field independently', () => {
    const fp1 = {
      terminalId: 't1',
      bufferType: 'normal' as const,
      cols: 80,
      rows: 24,
      length: 24,
      baseY: 0,
      lines: ['prompt $'],
      attrHash: 12345,
    };

    expect(areTerminalScreenFingerprintsEqual(fp1, { ...fp1 })).toBe(true);
    // Independently varied fields
    expect(areTerminalScreenFingerprintsEqual(fp1, { ...fp1, terminalId: 't2' })).toBe(false);
    expect(areTerminalScreenFingerprintsEqual(fp1, { ...fp1, bufferType: 'alternate' as const })).toBe(false);
    expect(areTerminalScreenFingerprintsEqual(fp1, { ...fp1, cols: 120 })).toBe(false);
    expect(areTerminalScreenFingerprintsEqual(fp1, { ...fp1, rows: 40 })).toBe(false);
    expect(areTerminalScreenFingerprintsEqual(fp1, { ...fp1, length: 30 })).toBe(false);
    expect(areTerminalScreenFingerprintsEqual(fp1, { ...fp1, baseY: 6 })).toBe(false);
    expect(areTerminalScreenFingerprintsEqual(fp1, { ...fp1, attrHash: 99999 })).toBe(false);
    expect(areTerminalScreenFingerprintsEqual(fp1, { ...fp1, lines: ['prompt $', 'extra line'] })).toBe(false);
    expect(areTerminalScreenFingerprintsEqual(fp1, { ...fp1, lines: ['different text'] })).toBe(false);
    expect(areTerminalScreenFingerprintsEqual(fp1, null)).toBe(false);
    expect(areTerminalScreenFingerprintsEqual(null, fp1)).toBe(false);
    expect(areTerminalScreenFingerprintsEqual(undefined, fp1)).toBe(false);
  });

  test('differentiates all rendering-significant cell attributes and color modes', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const { Terminal: RealTerminal } = require(
      path.resolve(__dirname, '../../../../node_modules/@xterm/xterm/lib/xterm.js'),
    );
    const runSequence = async (seq: string): Promise<number> => {
      const term = new RealTerminal({ cols: 10, rows: 2, allowProposedApi: true });
      terminalCache.set('t-seq', {
        terminal: term,
        hydrating: false,
      } as unknown as TerminalCacheEntry);
      await new Promise<void>((resolve) => term.write(seq, () => resolve()));
      const fp = getTerminalScreenFingerprint('t-seq');
      term.dispose();
      return fp!.attrHash!;
    };

    const hashPlain = await runSequence('hello');
    const hashInverse = await runSequence('\x1b[7mhello\x1b[0m');
    const hashUnderline = await runSequence('\x1b[4mhello\x1b[0m');
    const hashDim = await runSequence('\x1b[2mhello\x1b[0m');
    const hashBold = await runSequence('\x1b[1mhello\x1b[0m');
    const hashItalic = await runSequence('\x1b[3mhello\x1b[0m');
    const hashPalette = await runSequence('\x1b[38;5;1mhello\x1b[0m');
    const hashRGB = await runSequence('\x1b[38;2;0;0;1mhello\x1b[0m');

    const hashes = [
      hashPlain,
      hashInverse,
      hashUnderline,
      hashDim,
      hashBold,
      hashItalic,
      hashPalette,
      hashRGB,
    ];
    // Every single hash must be uniquely distinct
    const unique = new Set(hashes);
    expect(unique.size).toBe(hashes.length);
  });

  test('drainTerminalWrites flushes liveWriteBuf and waits for parser callback', async () => {
    let written = '';
    const mockTerm = {
      write: (data: string, cb?: () => void) => {
        written += data;
        if (cb) cb();
      },
    };
    terminalCache.set('t-drain', {
      terminal: mockTerm,
      liveWriteBuf: 'unflushed chunk',
    } as unknown as TerminalCacheEntry);

    let drained = false;
    drainTerminalWrites('t-drain', () => {
      drained = true;
    });

    expect(written).toContain('unflushed chunk');
    expect(drained).toBe(true);
  });
});

