/**
 * hydrate() with a RESTORE replay (a snapshot flagged `prefixOnly`, with an `anchorRow`).
 *
 * Two defects lived here:
 *   1. The replay was written as it came, leaving xterm's cursor on the last viewport row while
 *      ConPTY believed the prompt was on row 1: the first keystroke repainted the top of the pane.
 *      The replay is now placed so the cursor ends on the row ConPTY was told (the placement itself
 *      is pinned against the real parser in restoreReplay.test.ts; here: that hydrate() applies it).
 *   2. Everything the shell printed while hydrating was dropped as "already reflected in the
 *      snapshot". A prefix-only snapshot reflects NOTHING the shell printed, so that output (its
 *      first prompt, ConPTY's startup positioning) must be written after the replay.
 */
import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import { wrapRestoreReplay } from '../restoreReplay';
import type { TerminalBridge, TerminalSnapshot, Disposable } from '../types';
import { Terminal as MockTerminal } from '../__mocks__/xterm';

interface FakeBridge extends TerminalBridge {
  pushData(processId: string, data: string): void;
}

function makeFakeBridge(snapshot: () => Promise<Partial<TerminalSnapshot>>): FakeBridge {
  const dataCbs = new Map<string, Array<(data: string) => void>>();
  const bridge: FakeBridge = {
    onData(processId, cb): Disposable {
      dataCbs.set(processId, [...(dataCbs.get(processId) ?? []), cb]);
      return { dispose() { dataCbs.set(processId, (dataCbs.get(processId) ?? []).filter((c) => c !== cb)); } };
    },
    onExit: () => ({ dispose() {} }),
    write: () => {},
    resize: () => {},
    getSnapshot: (_pid, cols, rows) =>
      snapshot().then((r) => ({ snapshot: '', ...r, rows, cols }) as TerminalSnapshot),
    pushData(processId, data) {
      (dataCbs.get(processId) ?? []).forEach((cb) => cb(data));
    },
  };
  return bridge;
}

function makeContainer(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  document.body.appendChild(el);
  return el;
}

const mockTerm = (key: string) => terminalCache.get(key)!.terminal as unknown as MockTerminal;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

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
afterEach(() => terminalCache.clear());

/** Start hydrating, push `live` chunks while the snapshot is outstanding, then resolve it. */
async function hydrateWith(key: string, snap: Partial<TerminalSnapshot>, live: string[]): Promise<MockTerminal> {
  let resolve!: (v: Partial<TerminalSnapshot>) => void;
  const pending = new Promise<Partial<TerminalSnapshot>>((r) => { resolve = r; });
  const bridge = makeFakeBridge(() => pending);
  const engine = new TerminalEngine(bridge, { cacheKey: key });
  engine.mount(makeContainer());
  engine.attach('p1');
  const term = mockTerm(key);
  for (const chunk of live) bridge.pushData('p1', chunk);
  expect(term.written).toEqual([]); // buffered while hydrating, not written yet
  resolve(snap);
  await flush();
  return term;
}

test('a restore replay is placed on the anchor row, in the pane`s own size', async () => {
  const term = await hydrateWith('rr1', { snapshot: 'HISTORY+DIVIDER', prefixOnly: true, anchorRow: 18 }, []);
  expect(term.resetCount).toBe(1);
  expect(term.written).toEqual([wrapRestoreReplay('HISTORY+DIVIDER', 18, term.rows)]);
  expect(terminalCache.get('rr1')!.lastHydratedProcessId).toBe('p1');
  expect(terminalCache.get('rr1')!.hydrating).toBe(false);
});

test('a restore replay with no anchor is written as it comes (the unchanged behaviour)', async () => {
  const term = await hydrateWith('rr2', { snapshot: 'HISTORY+DIVIDER', prefixOnly: true }, []);
  expect(term.written).toEqual(['HISTORY+DIVIDER']);
});

test('output the shell printed while hydrating is KEPT after a prefix-only replay, in order', async () => {
  const term = await hydrateWith(
    'rr3',
    { snapshot: 'HISTORY', prefixOnly: true, anchorRow: 24 },
    ['\x1b[24;1H', 'PS D:\\src> '],
  );
  expect(term.written).toEqual([wrapRestoreReplay('HISTORY', 24, term.rows), '\x1b[24;1HPS D:\\src> ']);
  const entry = terminalCache.get('rr3')!;
  expect(entry.pendingOutput).toEqual([]);
  expect(entry.pendingOutputBytes).toBe(0);
});

test('output arriving AFTER hydration still follows the replay', async () => {
  let resolve!: (v: Partial<TerminalSnapshot>) => void;
  const pending = new Promise<Partial<TerminalSnapshot>>((r) => { resolve = r; });
  const bridge = makeFakeBridge(() => pending);
  const engine = new TerminalEngine(bridge, { cacheKey: 'rr4' });
  engine.mount(makeContainer());
  engine.attach('p1');
  resolve({ snapshot: 'HISTORY', prefixOnly: true, anchorRow: 5 });
  await flush();
  bridge.pushData('p1', 'LATER');
  await new Promise<void>((r) => setTimeout(r, 30)); // live output is coalesced for a frame
  const term = mockTerm('rr4');
  expect(term.written[0]).toBe(wrapRestoreReplay('HISTORY', 5, term.rows));
  expect(term.written.join('')).toContain('LATER');
});

test('a SCREEN snapshot is unchanged: written verbatim, buffered output dropped as already reflected', async () => {
  // The default path every non-restore hydration takes. An anchor on a snapshot that is not
  // flagged prefix-only is not a restore and is ignored.
  const term = await hydrateWith('rr5', { snapshot: 'SCREEN', anchorRow: 9 }, ['LIVE-DURING-AWAIT']);
  expect(term.written).toEqual(['SCREEN']);
  expect(terminalCache.get('rr5')!.pendingOutput).toEqual([]);
});

test('an empty restore snapshot flushes buffered output without a reset (unchanged)', async () => {
  const term = await hydrateWith('rr6', { snapshot: '', prefixOnly: true, anchorRow: 9 }, ['BUFFERED']);
  expect(term.resetCount).toBe(0);
  expect(term.written).toEqual(['BUFFERED']);
});
