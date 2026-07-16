// Fake @xterm/xterm for jsdom unit tests — real xterm touches canvas/DOM internals
// that jsdom can't provide. This mock captures the engine's wiring (onData/onResize/
// onTitleChange/attachCustomKeyEventHandler) and records writes so tests can assert
// behavior without faking anything into a no-op that hides bugs.

type Dataable = (data: string) => void;
type Resizable = (size: { cols: number; rows: number }) => void;
type Titleable = (title: string) => void;
type KeyHandler = (event: KeyboardEvent) => boolean;

interface Disposable {
  dispose(): void;
}

function makeDisposable(remove: () => void): Disposable {
  return { dispose: remove };
}

export class Terminal {
  rows = 24;
  cols = 80;
  // Real xterm initialises `options` from the constructor arg; the engine reads
  // these back (e.g. options.fontSize, options.allowProposedApi) so we keep them.
  options: Record<string, unknown>;

  // Set by open() so the create-or-reattach path can detect a live element.
  element: HTMLElement | undefined;

  unicode = { activeVersion: '6' as string };

  buffer = {
    active: {
      cursorX: 0,
      cursorY: 0,
      // Viewport position within the scrollback. viewportY >= baseY means the
      // viewport is pinned to the bottom (following live output). Tests set these
      // to exercise refreshSearch's scroll-preservation.
      viewportY: 0,
      baseY: 0,
      // Buffer type: 'normal' (main/scrollback) or 'alternate' (alt-screen, e.g. vim/less).
      // The alt-screen state heal (Task 6) checks this before reset()ing.
      type: 'normal' as 'normal' | 'alternate',
      // Settable line content so capture/suggest tests can simulate shell echo.
      __lines: [] as Array<{ text: string; isWrapped: boolean } | undefined>,
      getLine(
        n: number,
      ):
        | {
            isWrapped: boolean;
            translateToString(trim?: boolean, startCol?: number, endCol?: number): string;
          }
        | undefined {
        const entry = this.__lines[n];
        if (entry === undefined) return undefined;
        return {
          isWrapped: entry.isWrapped,
          translateToString: (trim?: boolean, startCol?: number, endCol?: number) => {
            let t = entry.text.slice(startCol ?? 0, endCol);
            if (trim) t = t.replace(/\s+$/, '');
            return t;
          },
        };
      },
    },
  };

  // Scroll calls recorded so tests can assert refreshSearch restores the viewport
  // instead of letting the search addon yank it to the active match.
  scrollToBottomCount = 0;
  scrollToLineCalls: number[] = [];
  scrollPagesCalls: number[] = [];

  scrollToBottom(): void {
    this.scrollToBottomCount++;
    // Mirror real xterm: bottom == baseY. Lets tests assert the viewport was
    // genuinely restored after findNext moved it, not just that this was called.
    this.buffer.active.viewportY = this.buffer.active.baseY;
  }

  scrollToLine(line: number): void {
    this.scrollToLineCalls.push(line);
    this.buffer.active.viewportY = line;
  }

  scrollPages(pageCount: number): void {
    this.scrollPagesCalls.push(pageCount);
    // Mirror real xterm: move by a viewport height per page, clamped to the buffer.
    this.buffer.active.viewportY = Math.max(
      0,
      Math.min(this.buffer.active.baseY, this.buffer.active.viewportY + pageCount * this.rows),
    );
  }

  // Captured callbacks — tests drive these to simulate real xterm events.
  dataCallbacks: Dataable[] = [];
  resizeCallbacks: Resizable[] = [];
  titleCallbacks: Titleable[] = [];
  writeParsedCallbacks: Array<() => void> = [];
  selectionChangeCallbacks: Array<() => void> = [];
  keyHandler: KeyHandler | null = null;

  // CSI handlers registered by the enhanced-keyboard wiring (Kitty/modifyOtherKeys).
  // Stored by `${prefix ?? ''}${final}` so tests can simulate protocol sequences.
  csiHandlers: Record<string, (params: (number | number[])[]) => boolean> = {};
  // OSC handlers (backlog 011 prompt-render heal), keyed by identifier.
  oscHandlers: Record<number, (data: string) => boolean> = {};
  parser = {
    registerCsiHandler: (
      id: { prefix?: string; final: string },
      cb: (params: (number | number[])[]) => boolean,
    ): Disposable => {
      const k = `${id.prefix ?? ''}${id.final}`;
      this.csiHandlers[k] = cb;
      return makeDisposable(() => {
        delete this.csiHandlers[k];
      });
    },
    registerOscHandler: (ident: number, cb: (data: string) => boolean): Disposable => {
      this.oscHandlers[ident] = cb;
      return makeDisposable(() => {
        delete this.oscHandlers[ident];
      });
    },
  };

  // Recorded side effects.
  written: string[] = [];
  pasted: string[] = [];
  loadedAddons: unknown[] = [];
  resetCount = 0;
  clearCount = 0;
  selectAllCount = 0;
  focusCount = 0;
  selection = '';
  // Real xterm exposes term.modes.mouseTrackingMode; the engine reads it to decide
  // whether to retain a selection for the context-menu copy fallback. Tests set this.
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any' = 'none';
  // Real xterm exposes term.modes.sendFocusMode (DECSET/DECRST 1004); the engine
  // reads it as a suggestions-suppression signal.
  sendFocusMode = false;

  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options };
  }

  loadAddon(addon: unknown): void {
    this.loadedAddons.push(addon);
    // Real xterm activates the addon with the terminal on load. The search-addon
    // mock uses this to capture the terminal so its findNext can simulate the
    // scroll-to-match side effect that refreshSearch's restore counteracts.
    const a = addon as { activate?: (t: unknown) => void };
    if (typeof a.activate === 'function') a.activate(this);
  }

  // Real xterm v6 API used by the backlog-003 file-path link provider. Returns a
  // disposable; tests don't exercise hover/click so the provider body isn't run.
  registerLinkProvider(_provider: unknown): Disposable {
    return makeDisposable(() => {});
  }

  open(container: HTMLElement): void {
    // Real xterm appends its render element to the container; emulate enough that
    // the reattach path (`cached.terminal.element`) sees a live node.
    const el = (typeof document !== 'undefined' ? document.createElement('div') : ({} as HTMLElement));
    this.element = el;
    if (container && typeof (container as HTMLElement).appendChild === 'function') {
      container.appendChild(el);
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  // --- Marker / decoration surface -----------------------------------------
  // Real xterm anchors a marker at `buffer.ybase + buffer.y + offset` and returns
  // a NON-nullable IMarker (xterm.d.ts:1147 — its "or undefined" docstring is
  // stale). registerDecoration DOES return undefined on the alt buffer or a
  // disposed marker. Modelled here so EndedRegionTracker tests mean something.
  private __cursorLine = 0;
  decorations: { options: Record<string, unknown>; disposed: boolean; dispose(): void }[] = [];
  private __decorationsFail = false;

  registerMarker(offset: number = 0): { line: number; isDisposed: boolean; dispose(): void } {
    const marker = {
      line: this.__cursorLine + offset,
      isDisposed: false,
      dispose(): void { marker.isDisposed = true; },
    };
    return marker;
  }

  registerDecoration(
    options: Record<string, unknown>,
  ): { options: Record<string, unknown>; disposed: boolean; dispose(): void } | undefined {
    if (this.__decorationsFail) return undefined;
    const d = { options, disposed: false, dispose(): void { d.disposed = true; } };
    this.decorations.push(d);
    return d;
  }

  /** Test hook: move the modelled cursor so the next marker anchors lower. */
  __setCursorLine(line: number): void { this.__cursorLine = line; }
  /** Test hook: model the alt-buffer / disposed-marker case. */
  __failDecorations(v: boolean): void { this.__decorationsFail = v; }

  write(data: string): void {
    this.written.push(data);
    if (data.includes('\x1b[?1003h')) {
      this.mouseTrackingMode = 'any';
    } else if (data.includes('\x1b[?1002h')) {
      this.mouseTrackingMode = 'drag';
    } else if (data.includes('\x1b[?1000h')) {
      this.mouseTrackingMode = 'vt200';
    } else if (data.includes('\x1b[?9h')) {
      this.mouseTrackingMode = 'x10';
    } else if (
      data.includes('\x1b[?9l') ||
      data.includes('\x1b[?1000l') ||
      data.includes('\x1b[?1002l') ||
      data.includes('\x1b[?1003l')
    ) {
      this.mouseTrackingMode = 'none';
    }
    if (data.includes('\x1b[?1004h')) {
      this.sendFocusMode = true;
    } else if (data.includes('\x1b[?1004l')) {
      this.sendFocusMode = false;
    }
  }

  // Real xterm routes pasted text OUT through the onData event (after bracketed-paste
  // / line-ending transforms), not through write(); emulate that so engine.paste()
  // tests see input reach bridge.write.
  paste(data: string): void {
    this.pasted.push(data);
    this.dataCallbacks.forEach((cb) => cb(data));
  }

  reset(): void {
    this.resetCount += 1;
    this.written = [];
    // Real xterm's reset() restores default modes; hydration relies on this
    // (reset, then the snapshot re-asserts any live input modes).
    this.mouseTrackingMode = 'none';
    this.sendFocusMode = false;
  }

  clear(): void {
    this.clearCount += 1;
  }

  selectAll(): void {
    this.selectAllCount += 1;
  }

  focus(): void {
    this.focusCount += 1;
  }

  refresh(_start: number, _end: number): void {}

  getSelection(): string {
    return this.selection;
  }

  hasSelection(): boolean {
    return this.selection.length > 0;
  }

  clearSelection(): void {
    this.selection = '';
  }

  onData(cb: Dataable): Disposable {
    this.dataCallbacks.push(cb);
    return makeDisposable(() => {
      this.dataCallbacks = this.dataCallbacks.filter((c) => c !== cb);
    });
  }

  onResize(cb: Resizable): Disposable {
    this.resizeCallbacks.push(cb);
    return makeDisposable(() => {
      this.resizeCallbacks = this.resizeCallbacks.filter((c) => c !== cb);
    });
  }

  onTitleChange(cb: Titleable): Disposable {
    this.titleCallbacks.push(cb);
    return makeDisposable(() => {
      this.titleCallbacks = this.titleCallbacks.filter((c) => c !== cb);
    });
  }

  onWriteParsed(cb: () => void): Disposable {
    this.writeParsedCallbacks.push(cb);
    return makeDisposable(() => {
      this.writeParsedCallbacks = this.writeParsedCallbacks.filter((c) => c !== cb);
    });
  }

  scrollCallbacks: Array<(viewportY: number) => void> = [];

  onScroll(cb: (viewportY: number) => void): Disposable {
    this.scrollCallbacks.push(cb);
    return makeDisposable(() => {
      this.scrollCallbacks = this.scrollCallbacks.filter((c) => c !== cb);
    });
  }

  onSelectionChange(cb: () => void): Disposable {
    this.selectionChangeCallbacks.push(cb);
    return makeDisposable(() => {
      this.selectionChangeCallbacks = this.selectionChangeCallbacks.filter((c) => c !== cb);
    });
  }

  // Mirrors real xterm's term.modes (only the fields the engine reads).
  get modes(): {
    mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
    sendFocusMode: boolean;
  } {
    return { mouseTrackingMode: this.mouseTrackingMode, sendFocusMode: this.sendFocusMode };
  }

  attachCustomKeyEventHandler(handler: KeyHandler): void {
    this.keyHandler = handler;
  }

  dispose(): void {}

  // ---- Test helpers (not part of the real xterm API) ----

  /** Set the active buffer type ('normal' or 'alternate') for Task-6 alt-screen heal tests. */
  __setBufferType(type: 'normal' | 'alternate'): void {
    this.buffer.active.type = type;
  }

  /** Set a buffer line's text for capture/suggest tests (backlog 011). */
  __setLine(row: number, text: string, isWrapped = false): void {
    this.buffer.active.__lines[row] = { text, isWrapped };
  }

  /** Move the fake cursor for capture/suggest tests (backlog 011). */
  __setCursor(x: number, y: number): void {
    this.buffer.active.cursorX = x;
    this.buffer.active.cursorY = y;
  }

  emitData(data: string): void {
    this.dataCallbacks.forEach((cb) => cb(data));
  }

  emitResize(cols: number, rows: number): void {
    this.resizeCallbacks.forEach((cb) => cb({ cols, rows }));
  }

  emitTitle(title: string): void {
    this.titleCallbacks.forEach((cb) => cb(title));
  }

  emitWriteParsed(): void {
    this.writeParsedCallbacks.forEach((cb) => cb());
  }

  emitScroll(viewportY: number): void {
    this.buffer.active.viewportY = viewportY;
    this.scrollCallbacks.forEach((cb) => cb(viewportY));
  }

  /** Set the current selection text and fire onSelectionChange (mirrors real xterm). */
  __setSelection(text: string): void {
    this.selection = text;
    this.selectionChangeCallbacks.forEach((cb) => cb());
  }
}
