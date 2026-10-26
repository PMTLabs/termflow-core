/**
 * engine.prompt-mark-listener.test.ts
 *
 * Plan 061: onPromptMark() subscribers hear the restored state on mount, and every
 * OSC 133 payload leaves one diagnostic line (accepted with its re-arm result, or
 * ignored).
 */

import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import type { TerminalBridge, Disposable } from '../types';

function makeFakeBridge(): TerminalBridge {
  const noopDisposable: Disposable = { dispose() {} };
  return {
    onData: () => noopDisposable,
    onExit: () => noopDisposable,
    write: () => {},
    resize: () => {},
  };
}

/** jsdom gives a real element; force a usable size so the >50px guards pass. */
function makeContainer(width = 800, height = 600): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-display-wrapper';
  const el = document.createElement('div');
  el.className = 'terminal-display';
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true });
  Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  wrapper.appendChild(el);
  document.body.appendChild(wrapper);
  return el;
}

/** Live (non-disposed) bottom-layer wash rows — the visible ended-region marks. */
function liveWashRows(term: any): number[] {
  return term.decorations
    .filter((d: any) => !d.disposed && d.options.layer === 'bottom')
    .map((d: any) => (d.options.marker as { line: number }).line)
    .sort((a: number, b: number) => a - b);
}

let prevRO: unknown;

beforeEach(() => {
  terminalCache.clear();
  prevRO = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  };
});

afterEach(() => {
  terminalCache.clear();
  document.body.innerHTML = '';
  if (prevRO === undefined) delete (globalThis as any).ResizeObserver;
  else (globalThis as any).ResizeObserver = prevRO;
});



it('a listener subscribed before mount() hears the state restored from the cache entry', () => {
  const first = new TerminalEngine(makeFakeBridge(), { cacheKey: 'pm-restore' });
  first.mount(makeContainer());
  const term = terminalCache.get('pm-restore')!.terminal as any;
  term.oscHandlers[133]('A'); // host kind lands in the cache entry
  first.unmount();

  const second = new TerminalEngine(makeFakeBridge(), { cacheKey: 'pm-restore' });
  const states: Array<{ seen: boolean; kind: string }> = [];
  second.onPromptMark((s) => states.push({ ...s }));
  expect(states).toEqual([{ seen: false, kind: 'local' }]); // defaults, pre-mount
  second.mount(makeContainer());
  expect(states[states.length - 1]).toEqual({ seen: true, kind: 'host' });
});

describe('OSC 133 diagnostics', () => {
  function engineWithDiag() {
    const lines: string[] = [];
    const engine = new TerminalEngine(makeFakeBridge(), {
      cacheKey: `pm-diag-${lines.length}-${Math.random()}`,
      onDiag: (f: () => string) => lines.push(f()),
    } as any);
    engine.mount(makeContainer());
    const term = (terminalCache.get((engine as any).cacheKey)!.terminal) as any;
    lines.length = 0;
    return { term, lines };
  }

  it('an accepted mark logs its payload, kind and re-arm result', () => {
    const { term, lines } = engineWithDiag();
    term.oscHandlers[133]('A;aid=42');
    expect(lines.filter((l) => l.includes('osc133'))).toEqual([
      '[TERM-DIAG] prompt mark source=osc133 payload="A;aid=42" kind=host rearmed=true',
    ]);
  });

  it.each(['B', 'D;0', ''])('an ignored payload %j logs that it was ignored', (payload) => {
    const { term, lines } = engineWithDiag();
    term.oscHandlers[133](payload);
    expect(lines.filter((l) => l.includes('osc133'))).toEqual([
      `[TERM-DIAG] osc133 ignored payload=${JSON.stringify(payload)} (not a prompt start)`,
    ]);
  });
});
