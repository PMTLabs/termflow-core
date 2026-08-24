/**
 * Signals that a terminal's PTY is being RESIZED, so `RunningActivityTracker` can
 * brace for the repaint that answers it (see `notifyViewChangeBurst`).
 *
 * A resize is the one output cause that is never the program doing work: a shell or
 * TUI repaints its whole screen because the geometry changed, and the geometry
 * changed because the user did something to the VIEW — a font zoom, a pane split, a
 * Canvas Mode zoom that re-tiers a node. Counting that repaint as activity rings the
 * unseen bell, pops a toast and animates the running sweep on terminals nobody
 * touched.
 *
 * ## Emitted HERE — at the `electronAPI` boundary — and that is the whole point
 *
 * This used to be dispatched by `TerminalService.resizeTerminal`, described in
 * `RunningActivityTracker` as "the single choke point every renderer-caused resize
 * goes through". It was not one. Input and resize flow
 * `TerminalEngine` -> `bridge.resize()` -> `MainBridge` -> `electronAPI` (spec §6.1 /
 * §17 R2), so `TerminalService.resizeTerminal` had exactly one caller left — the
 * `onResize` prop `TerminalDisplay` explicitly discards as vestigial — and the event
 * was never dispatched in the running app at all. The suppression it arms was dead
 * from the day the engine took the resize path over, and the unit test covering it
 * passed only because it dispatched the event by hand.
 *
 * `electronAPI.resizeTerminal` is the choke point that claim wanted: every sender
 * reaches the backend through it — the engine's debounced `flushBackendResize`, the
 * pre-hydration resize, and `TerminalService` itself. Putting the announcement in the
 * CALLERS is what let one silently opt out; putting it on the one entry point they
 * all share is what makes a new sender impossible to forget.
 *
 * Mirrors `emitPtyInput` in shape and in placement (both bridges, plus the `*Pty`
 * alias) deliberately: they are the same kind of signal about the same stream, and
 * two different answers to "where does a PTY-lifecycle signal live" is how the next
 * one ends up somewhere nothing listens.
 *
 * Announced BEFORE the round-trip, so anything bracing for the SIGWINCH is armed when
 * the redraw comes back rather than a round-trip late.
 *
 * Fire-and-forget: this must never throw into the resize path.
 */
export function emitPtyResize(processId: string, cols: number, rows: number): void {
  try {
    window.dispatchEvent(
      new CustomEvent('pty:resize', { detail: { processId, cols, rows } }),
    );
  } catch {
    /* no-op: activity signalling must never break a terminal resize */
  }
}
