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

  it('refreshSearch re-runs the active query incrementally', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    engine.searchNext('foo', { caseSensitive: true });
    addon.findNextCalls.length = 0; // reset to isolate the refresh call
    engine.refreshSearch();
    expect(addon.findNextCalls).toHaveLength(1);
    expect(addon.findNextCalls[0].term).toBe('foo');
    expect(addon.findNextCalls[0].options?.incremental).toBe(true);
    expect(addon.findNextCalls[0].options?.caseSensitive).toBe(true);
  });

  it('refreshSearch keeps the viewport pinned to the bottom when following output', () => {
    const { engine } = mountEngine();
    const term = (engine as any).term as MockTerminal;
    const addon = (engine as any).searchAddon as MockSearchAddon;
    term.buffer.active.baseY = 100;
    // findNext will yank the viewport up to the match (line 0) — the bug we fix.
    addon.matchViewportY = 0;
    engine.searchNext('foo', {}); // initial search scrolls to the match (expected)
    // Now the user is following live output at the bottom; a write fires refresh.
    term.buffer.active.viewportY = 100; // viewportY >= baseY ⇒ at bottom
    term.scrollToBottomCount = 0; // isolate the refresh
    engine.refreshSearch();
    // Re-pinned to the bottom, NOT left at the match line findNext jumped to.
    expect(term.scrollToBottomCount).toBe(1);
    expect(term.scrollToLineCalls).toHaveLength(0);
    expect(term.buffer.active.viewportY).toBe(100);
  });

  it('refreshSearch restores the exact scroll position when scrolled up', () => {
    const { engine } = mountEngine();
    const term = (engine as any).term as MockTerminal;
    const addon = (engine as any).searchAddon as MockSearchAddon;
    // Scrolled up (viewportY < baseY): hold position, don't jump to the match.
    term.buffer.active.baseY = 100;
    addon.matchViewportY = 0; // findNext would yank to the top
    engine.searchNext('foo', {}); // initial search scrolls to the match (expected)
    // User then scrolls up to inspect output; a live write fires refresh.
    term.buffer.active.viewportY = 30;
    term.scrollToLineCalls.length = 0;
    engine.refreshSearch();
    expect(term.scrollToLineCalls).toEqual([30]);
    expect(term.scrollToBottomCount).toBe(0);
    expect(term.buffer.active.viewportY).toBe(30);
  });

  it('onWriteParsed triggers a debounced live refresh when a search is active', () => {
    jest.useFakeTimers();
    try {
      const { engine } = mountEngine();
      const addon = (engine as any).searchAddon as MockSearchAddon;
      const term = (engine as any).term as MockTerminal;
      engine.searchNext('foo', {});
      addon.findNextCalls.length = 0;
      term.emitWriteParsed();
      // Debounced: nothing fires synchronously.
      expect(addon.findNextCalls).toHaveLength(0);
      jest.advanceTimersByTime(150);
      expect(addon.findNextCalls).toHaveLength(1);
      expect(addon.findNextCalls[0].options?.incremental).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('coalesces a burst of writes into a single refresh', () => {
    jest.useFakeTimers();
    try {
      const { engine } = mountEngine();
      const addon = (engine as any).searchAddon as MockSearchAddon;
      const term = (engine as any).term as MockTerminal;
      engine.searchNext('foo', {});
      addon.findNextCalls.length = 0;
      // Rapid streaming output: many parsed writes inside one debounce window.
      for (let i = 0; i < 20; i++) {
        term.emitWriteParsed();
        jest.advanceTimersByTime(10); // < 150ms apart, keeps resetting the timer
      }
      expect(addon.findNextCalls).toHaveLength(0);
      jest.advanceTimersByTime(150); // stream goes idle
      expect(addon.findNextCalls).toHaveLength(1);
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
    engine.refreshSearch();
    // No re-search: the dismissed match is not yanked back.
    expect(addon.findNextCalls).toHaveLength(0);
  });

  it('refreshSearch keeps searching when no match exists yet (so new output can match)', () => {
    const { engine } = mountEngine();
    const addon = (engine as any).searchAddon as MockSearchAddon;
    const term = (engine as any).term as MockTerminal;
    engine.searchNext('zzz', {}); // nothing on screen matches yet
    addon.emitResults(-1, 0); // 0 matches
    term.clearSelection(); // no active match selection
    addon.findNextCalls.length = 0;
    engine.refreshSearch();
    // Still re-runs: a match that scrolls into view from new output must highlight.
    expect(addon.findNextCalls).toHaveLength(1);
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
