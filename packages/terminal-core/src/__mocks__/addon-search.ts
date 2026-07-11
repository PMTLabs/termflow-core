// Fake @xterm/addon-search for jsdom unit tests. Records findNext/findPrevious
// calls (term + options) and exposes an emitResults() helper so tests can drive
// the onDidChangeResults event the engine forwards to the host counter.

interface Disposable {
  dispose(): void;
}

function makeDisposable(remove: () => void): Disposable {
  return { dispose: remove };
}

type ResultsCb = (e: { resultIndex: number; resultCount: number }) => void;

export interface ISearchOptions {
  regex?: boolean;
  wholeWord?: boolean;
  caseSensitive?: boolean;
  incremental?: boolean;
  decorations?: unknown;
}

export class SearchAddon {
  activated = false;
  disposed = false;

  // Recorded calls — tests assert the engine maps options correctly.
  findNextCalls: Array<{ term: string; options?: ISearchOptions }> = [];
  findPreviousCalls: Array<{ term: string; options?: ISearchOptions }> = [];
  clearDecorationsCount = 0;
  clearActiveDecorationCount = 0;

  // findNext/findPrevious return value the engine relays; tests can override.
  nextReturn = true;
  previousReturn = true;

  private resultsCallbacks: ResultsCb[] = [];

  // The terminal this addon is activated on, captured so findNext can simulate
  // the real addon's side effects: scrolling the viewport to the match AND
  // selecting it (so terminal.hasSelection() reflects an active match).
  private terminal:
    | { buffer: { active: { viewportY: number } }; selection: string }
    | null = null;
  // Where a found match lives — findNext yanks the viewport here, mimicking real
  // xterm. Tests set this to a value far from the snapshot so they can prove
  // refreshSearch actually restores the viewport (not merely that it calls scroll).
  matchViewportY = 0;

  constructor(_options?: unknown) {}

  activate(terminal: unknown): void {
    this.activated = true;
    this.terminal = terminal as { buffer: { active: { viewportY: number } }; selection: string };
  }

  dispose(): void {
    this.disposed = true;
  }

  findNext(term: string, options?: ISearchOptions): boolean {
    this.findNextCalls.push({ term, options });
    // Real findNext scrolls the viewport to the active match and selects it.
    // Reproduce both so tests exercise refreshSearch's scroll-preservation AND
    // its "skip when the user cleared the selection" guard.
    if (term && this.terminal) {
      this.terminal.buffer.active.viewportY = this.matchViewportY;
      this.terminal.selection = term;
    }
    return this.nextReturn;
  }

  findPrevious(term: string, options?: ISearchOptions): boolean {
    this.findPreviousCalls.push({ term, options });
    if (term && this.terminal) {
      this.terminal.buffer.active.viewportY = this.matchViewportY;
      this.terminal.selection = term;
    }
    return this.previousReturn;
  }

  clearDecorations(): void {
    this.clearDecorationsCount += 1;
  }

  clearActiveDecoration(): void {
    this.clearActiveDecorationCount += 1;
  }

  onDidChangeResults(cb: ResultsCb): Disposable {
    this.resultsCallbacks.push(cb);
    return makeDisposable(() => {
      this.resultsCallbacks = this.resultsCallbacks.filter((c) => c !== cb);
    });
  }

  // ---- Test helper (not part of the real addon API) ----
  emitResults(resultIndex: number, resultCount: number): void {
    this.resultsCallbacks.forEach((cb) => cb({ resultIndex, resultCount }));
  }
}
