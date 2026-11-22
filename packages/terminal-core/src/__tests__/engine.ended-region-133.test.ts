/**
 * engine.ended-region-133.test.ts
 *
 * Plan 061: OSC 133;A is a prompt render, so it must close one command's ended
 * region and open the next exactly as OSC 7 / 9;9 do (promptOscHeal calls
 * endedRegions.onPrompt()). A test that only watches command capture cannot see
 * that boundary, so these read the painted wash rows.
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

/** prompt -> a program ran for `height` rows -> prompt, via the given OSC call. */
function plantRegion(engine: TerminalEngine, term: any, prompt: () => void, height = 5): void {
  engine.setEndedRegionColors('#2a2a2a', '#7aa2f7');
  term.__setCursorLine(0);
  prompt();
  engine.markProgramActive();
  term.__setCursorLine(height);
  prompt();
}

const via133 = (term: any) => () => term.oscHandlers[133]('A');
const via7 = (term: any) => () => term.oscHandlers[7]('');

describe('plan 061: OSC 133;A closes and opens ended-region spans', () => {
  it('paints the same wash rows as OSC 7 for the same program run', () => {
    const e7 = new TerminalEngine(makeFakeBridge(), { cacheKey: 'er133-osc7' });
    e7.mount(makeContainer());
    const t7 = terminalCache.get('er133-osc7')!.terminal as any;
    plantRegion(e7, t7, via7(t7));
    const expected = liveWashRows(t7);
    expect(expected.length).toBeGreaterThan(0);

    const e133 = new TerminalEngine(makeFakeBridge(), { cacheKey: 'er133-osc133' });
    e133.mount(makeContainer());
    const t133 = terminalCache.get('er133-osc133')!.terminal as any;
    plantRegion(e133, t133, via133(t133));
    expect(liveWashRows(t133)).toEqual(expected);
  });

  it('a duplicate mark with no output between adds no region and keeps the open span', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'er133-dup' });
    engine.mount(makeContainer());
    const term = terminalCache.get('er133-dup')!.terminal as any;
    engine.setEndedRegionColors('#2a2a2a', '#7aa2f7');
    term.__setCursorLine(0);
    term.oscHandlers[133]('A');
    term.oscHandlers[133]('A'); // zero-height span: nothing to mark
    expect(liveWashRows(term)).toEqual([]);
    engine.markProgramActive();
    term.__setCursorLine(5);
    term.oscHandlers[133]('A'); // the program's region closes here
    expect(liveWashRows(term).length).toBeGreaterThan(0);
  });

  it('non-prompt 133 payloads close nothing', () => {
    const engine = new TerminalEngine(makeFakeBridge(), { cacheKey: 'er133-nonprompt' });
    engine.mount(makeContainer());
    const term = terminalCache.get('er133-nonprompt')!.terminal as any;
    engine.setEndedRegionColors('#2a2a2a', '#7aa2f7');
    term.__setCursorLine(0);
    term.oscHandlers[133]('A');
    engine.markProgramActive();
    term.__setCursorLine(5);
    term.oscHandlers[133]('C'); // command output start, not a prompt
    term.oscHandlers[133]('D;0');
    expect(liveWashRows(term)).toEqual([]);
  });
});
