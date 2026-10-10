/**
 * @jest-environment jsdom
 *
 * Engine search API (backlog 006): the engine owns @xterm/addon-search and exposes
 * a thin host-agnostic surface. These tests drive the mocked SearchAddon to assert
 * option mapping, live refresh, result forwarding, and the Ctrl/Cmd+F intercept.
 */
import { TerminalEngine } from './TerminalEngine';
import { terminalCache } from './cache';
import type { TerminalBridge } from './types';
import { Terminal as MockTerminal } from './__mocks__/xterm';
import { SearchAddon as MockSearchAddon } from './__mocks__/addon-search';

function makeBridge(): TerminalBridge {
  return {
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write: () => {},
    resize: () => {},
  };
}

let cacheKeySeq = 0;

function mountEngine(opts: Record<string, unknown> = {}) {
  const cacheKey = `k_${++cacheKeySeq}`;
  const engine = new TerminalEngine(makeBridge(), { cacheKey, ...opts });
  const container = document.createElement('div');
  Object.defineProperty(container, 'offsetWidth', { value: 800, configurable: true });
  document.body.appendChild(container);
  engine.mount(container);
  const entry = terminalCache.get(cacheKey);
  return { engine, container, entry, cacheKey };
}

describe('TerminalEngine search', () => {
  afterEach(() => {
    terminalCache.clear();
    document.body.innerHTML = '';
  });

  it('searchNext maps options and passes decorations', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    engine.searchNext('foo', { caseSensitive: true, regex: false, wholeWord: true });
    expect(addon.findNextCalls).toHaveLength(1);
    const call = addon.findNextCalls[0];
    expect(call.term).toBe('foo');
    expect(call.options?.caseSensitive).toBe(true);
    expect(call.options?.wholeWord).toBe(true);
    expect(call.options?.regex).toBe(false);
    expect(call.options?.decorations).toBeDefined();
  });

  it('searchNext with incremental=true sets the incremental flag', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    engine.searchNext('foo', {}, true);
    expect(addon.findNextCalls[0].options?.incremental).toBe(true);
  });

  it('searchNext (Next button) defaults incremental to false', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    engine.searchNext('foo', {});
    expect(addon.findNextCalls[0].options?.incremental).toBe(false);
  });

  it('searchPrevious calls findPrevious with mapped options', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    engine.searchPrevious('bar', { caseSensitive: true });
    expect(addon.findPreviousCalls).toHaveLength(1);
    expect(addon.findPreviousCalls[0].term).toBe('bar');
    expect(addon.findPreviousCalls[0].options?.caseSensitive).toBe(true);
  });

  it('empty query clears the search instead of searching', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    engine.searchNext('', {});
    expect(addon.findNextCalls).toHaveLength(0);
    expect(addon.clearDecorationsCount).toBe(1);
  });

  it('clearSearch clears decorations and the active query', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    engine.searchNext('foo', {});
    engine.clearSearch();
    expect(addon.clearDecorationsCount).toBe(1);
    // refresh after clear is a no-op (no active query)
    engine.refreshSearch();
    expect(addon.findNextCalls).toHaveLength(1);
  });

  it('onSearchResults forwards onDidChangeResults', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    const seen: Array<{ resultIndex: number; resultCount: number }> = [];
    const sub = engine.onSearchResults((r) => seen.push(r));
    addon.emitResults(2, 7);
    expect(seen).toEqual([{ resultIndex: 2, resultCount: 7 }]);
    sub.dispose();
  });

  it('refreshSearch re-runs the active query with the same options, without scrolling', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    engine.searchNext('foo', { caseSensitive: true });
    addon.findNextCalls.length = 0; // reset to isolate the refresh call
    addon.findPreviousCalls.length = 0;
    engine.refreshSearch();
    // Never findNext: a same-term findNext steps to the NEXT match (see below).
    expect(addon.findNextCalls).toHaveLength(0);
    expect(addon.findPreviousCalls).toHaveLength(1);
    expect(addon.findPreviousCalls[0].term).toBe('foo');
    expect(addon.findPreviousCalls[0].options?.caseSensitive).toBe(true);
    expect(addon.findPreviousCalls[0].options?.decorations).toBeDefined();
    expect(addon.findPreviousInternal[0]).toEqual({ noScroll: true });
  });

  it('refreshSearch re-selects the SAME match every time instead of stepping to the next', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    engine.searchNext('foo', {}, true); // as-you-type: first match
    engine.searchNext('foo', {}); // user presses Next: second match
    expect(addon.selectedIndex).toBe(1);
    for (let i = 0; i < 5; i++) engine.refreshSearch(); // five streaming ticks
    expect(addon.selectedIndex).toBe(1);
  });

  it('refreshSearch forces the addon to recount (drops its cached term first)', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    engine.searchNext('foo', {});
    const before = addon.clearDecorationsCount;
    engine.refreshSearch();
    // The real addon recounts only when the cached term differs from the query;
    // clearDecorations() is what resets it, and it must precede the re-search.
    expect(addon.clearDecorationsCount).toBe(before + 1);
  });

  it('refreshSearch never moves the viewport, whether following output or scrolled up', () => {
    const { engine } = mountEngine();
    const term = (engine as any).term as MockTerminal;
    const addon = (engine as any).searchAddon as MockSearchAddon;
    term.buffer.active.baseY = 100;
    addon.matchViewportY = 0; // a scrolling search would yank the viewport to the top
    engine.searchNext('foo', {}); // explicit search scrolls to the match (expected)
    for (const viewportY of [100, 30]) {
      // 100 = following live output at the bottom, 30 = scrolled up to read
      term.buffer.active.viewportY = viewportY;
      term.scrollToBottomCount = 0;
      term.scrollToLineCalls.length = 0;
      engine.refreshSearch();
      expect(term.buffer.active.viewportY).toBe(viewportY);
      expect(term.scrollToBottomCount).toBe(0);
      expect(term.scrollToLineCalls).toHaveLength(0);
    }
  });

  it('onWriteParsed triggers a live refresh when a search is active', () => {
    jest.useFakeTimers();
    try {
      const { engine } = mountEngine();
      const addon = (engine as any).searchAddon as MockSearchAddon;
      const term = (engine as any).term as MockTerminal;
      engine.searchNext('foo', {});
      addon.findPreviousCalls.length = 0;
      term.emitWriteParsed();
      // Deferred: nothing fires synchronously.
      expect(addon.findPreviousCalls).toHaveLength(0);
      jest.advanceTimersByTime(250);
      expect(addon.findPreviousCalls).toHaveLength(1);
      expect(addon.findPreviousInternal[0]).toEqual({ noScroll: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps refreshing DURING a stream that never goes idle (throttle, not debounce)', () => {
    jest.useFakeTimers();
    try {
      const { engine } = mountEngine();
      const addon = (engine as any).searchAddon as MockSearchAddon;
      const term = (engine as any).term as MockTerminal;
      engine.searchNext('foo', {});
      addon.findPreviousCalls.length = 0;
      // 2s of continuous output, a parsed write every 10ms: never a quiet moment.
      for (let i = 0; i < 200; i++) {
        term.emitWriteParsed();
        jest.advanceTimersByTime(10);
      }
      // A trailing debounce would have fired zero times here (counter frozen).
      // A throttle fires once per interval, and far fewer times than once per write.
      expect(addon.findPreviousCalls.length).toBeGreaterThanOrEqual(7);
      expect(addon.findPreviousCalls.length).toBeLessThanOrEqual(8);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refreshSearch does not re-force a match the user dismissed (cleared selection)', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    const term = (engine as any).term as MockTerminal;
    engine.searchNext('foo', {}); // selects the first match (term.selection set)
    addon.emitResults(0, 3); // 3 matches exist
    expect(term.hasSelection()).toBe(true);
    term.clearSelection(); // user clicks in the terminal, dropping the selection
    addon.findNextCalls.length = 0;
    addon.findPreviousCalls.length = 0;
    engine.refreshSearch();
    // No re-search: the dismissed match is not yanked back.
    expect(addon.findNextCalls).toHaveLength(0);
    expect(addon.findPreviousCalls).toHaveLength(0);
  });

  it('refreshSearch keeps searching when no match exists yet (so new output can match)', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    const term = (engine as any).term as MockTerminal;
    engine.searchNext('zzz', {}); // nothing on screen matches yet
    addon.emitResults(-1, 0); // 0 matches
    term.clearSelection(); // no active match selection
    addon.findPreviousCalls.length = 0;
    engine.refreshSearch();
    // Still re-runs: a match that scrolls into view from new output must highlight.
    expect(addon.findPreviousCalls).toHaveLength(1);
  });

  it('unmount clears stranded decorations (no leftover highlights on remount)', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    engine.searchNext('foo', {});
    expect(addon.clearDecorationsCount).toBe(0);
    engine.unmount();
    expect(addon.clearDecorationsCount).toBe(1);
    // active query dropped too — a post-unmount refresh is a no-op
    addon.findNextCalls.length = 0;
    engine.refreshSearch();
    expect(addon.findNextCalls).toHaveLength(0);
  });

  it('onWriteParsed does nothing when no search is active', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    const term = (engine as any).term as MockTerminal;
    term.emitWriteParsed();
    expect(addon.findNextCalls).toHaveLength(0);
  });

  it('Ctrl+F fires onOpenSearch and prevents default', () => {
    const onOpenSearch = jest.fn();
    const { container } = mountEngine({ isMac: false, onOpenSearch });
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    container.dispatchEvent(event);
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Cmd+F fires onOpenSearch on macOS', () => {
    const onOpenSearch = jest.fn();
    const { container } = mountEngine({ isMac: true, onOpenSearch });
    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
    container.dispatchEvent(event);
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+F does NOT fire on macOS (Cmd is the modifier there)', () => {
    const onOpenSearch = jest.fn();
    const { container } = mountEngine({ isMac: true, onOpenSearch });
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    container.dispatchEvent(event);
    expect(onOpenSearch).not.toHaveBeenCalled();
  });
});
