// Fake @xterm/addon-fit for jsdom unit tests.

interface FitTerminal {
  resize(cols: number, rows: number): void;
  emitResize(cols: number, rows: number): void;
}

export class FitAddon {
  // Records how many times fit() was called — used by lifecycle-timers tests
  // to assert that no fit fires after unmount().
  fitCount = 0;

  // Captured terminal reference (set by activate, called during loadAddon).
  private _term: FitTerminal | null = null;

  // Configurable next-fit size. When set, fit() applies this size by calling
  // term.resize() + term.emitResize() (driving the real onResize → scheduleBackendResize
  // chain). Tests call setNextFit(cols, rows) to control what the next fit() will measure.
  private _nextFit: { cols: number; rows: number } | null = null;

  activate(term: unknown): void {
    this._term = term as FitTerminal;
  }

  dispose(): void {}

  fit(): void {
    this.fitCount += 1;
    if (this._nextFit && this._term) {
      const { cols, rows } = this._nextFit;
      this._nextFit = null;
      this._term.resize(cols, rows);
      this._term.emitResize(cols, rows);
    }
  }

  proposeDimensions(): { cols: number; rows: number } | undefined {
    return undefined;
  }

  /**
   * Test helper: set the size that the NEXT fit() call will apply.
   * Mimics a real FitAddon measuring the container and resizing xterm.
   */
  setNextFit(cols: number, rows: number): void {
    this._nextFit = { cols, rows };
  }
}
