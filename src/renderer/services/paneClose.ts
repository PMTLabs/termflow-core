/**
 * Pure, unit-testable helper for the "close pane" action (P0 — Faster Pane
 * Close). Mirrors the fire-and-forget pattern already used by the tab-close
 * path (see `closeOneTab` in TabManager.tsx): the backend PTY teardown is a
 * multi-second `await`, so the UI removal must happen SYNCHRONOUSLY and the
 * backend close must run in the background instead of gating it.
 *
 * Kept free of React/Redux so it can be tested in isolation (see
 * __tests__/paneClose.test.ts).
 */

export interface ClosePaneDeps {
  /** The pane's terminal id, already resolved from the pane tree — or null if
   *  the pane has no terminal (defensive; should not normally happen). */
  terminalId: string | null;
  /** Removes the pane from the UI. Must be synchronous — this is the call
   *  that makes the pane disappear immediately. */
  removeFromUi: () => void;
  /** Backend PTY teardown. Never awaited by this helper — fire-and-forget. */
  closeTerminal: (terminalId: string) => Promise<void>;
  /** Drops the terminal's cwd snapshot. Called synchronously, matching the
   *  existing comment in TerminalPane.tsx's pty:exit handler: performClose
   *  clears the snapshot synchronously so a late write from the (now
   *  in-flight) backend close is dropped once the generation moves. */
  clearCwdSnapshot: (terminalId: string) => void;
  /** Disposes the terminal's cached xterm engine — its Terminal, its scrollback, its
   *  bridge subscriptions and, the reason this dep exists, its WebGL context.
   *
   *  REQUIRED, not optional: an optional dep lets a caller silently forget it, which
   *  is exactly how this leaked in the first place. Injected rather than imported so
   *  this helper stays free of terminal-core. */
  releaseSurface: (terminalId: string) => void;
}

/**
 * Close a pane without blocking the UI on the backend PTY teardown.
 *
 * Ordering (load-bearing): UI removal, then the cwd snapshot clear, both
 * synchronous — THEN the backend close is kicked off without awaiting it.
 * `closePane` (Redux) only mutates the pane tree, not `terminalService`'s
 * process map, so removing the pane before the backend close resolves is
 * safe; TerminalPane's unmount does not itself close the terminal, so this
 * fire-and-forget call remains the one and only PTY kill.
 */
export function closePaneNonBlocking(deps: ClosePaneDeps): void {
  const { terminalId, removeFromUi, closeTerminal, clearCwdSnapshot, releaseSurface } = deps;

  // Remove the pane from the UI immediately — do not wait on the backend.
  removeFromUi();

  if (!terminalId) return;

  // Spec 045 §3.3: the pane is gone for good — drop its directory so the map
  // cannot grow without bound and a recycled id can't inherit it.
  clearCwdSnapshot(terminalId);

  // ...and dispose the cached xterm engine for the same reason, in the same place.
  // The cache is keyed by terminalId, so this is per TERMINAL — exactly what the
  // tab-close path does per pane of the tab it closes (TabManager.closeOneTab),
  // and it disposes before its own removeTab dispatch, so this ordering is the
  // proven one rather than a new one.
  //
  // Without it the entry — Terminal, scrollback, bridge subs and WebGL context —
  // outlives the pane. A renderer allows only ~16 GL contexts; past that the browser
  // drops the OLDEST, which is the longest-running terminal, and webgl.ts disposes
  // that addon without ever reloading it. The session's most-used terminal silently
  // falls back to the DOM renderer, which re-renders full rows on every selection
  // change: selection lags the cursor and scrolling stutters, worsening all day.
  releaseSurface(terminalId);

  // Fire-and-forget: the backend PTY kill can take multiple seconds and must
  // never block the pane's disappearance. Errors are logged, not thrown —
  // there is no UI left waiting on this by the time it settles.
  closeTerminal(terminalId).catch((error) => {
    console.error(`Failed to close terminal for pane (terminalId=${terminalId}):`, error);
  });
}
