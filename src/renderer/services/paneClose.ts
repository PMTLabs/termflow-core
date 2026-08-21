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
  /** Disposes the terminal's cached xterm engine — its Terminal, its scrollback,
   *  its bridge subscriptions and, the reason this dep exists, its WebGL context.
   *
   *  `cleanupTerminalCache` had exactly ONE caller: the TAB-close path. Closing a
   *  single pane killed the PTY and left the whole cache entry alive, and
   *  `countActiveWebGLAddons()` kept counting its addon against the 12-context
   *  budget for the rest of the session — so a user who splits and closes panes
   *  all day silently loses GPU rendering for every terminal opened afterwards.
   *  Injected rather than imported so this helper stays free of terminal-core. */
  releaseSurface: (terminalId: string) => void;
  /** Drops the terminal's session-closed record (`plan/024` Req 4). Same argument as
   *  `clearCwdSnapshot` one field up: the pane is gone for good, so the map must not grow
   *  without bound and a recycled id must not inherit a dead shell's exit code and render a
   *  "Session closed" banner over a live terminal.
   *
   *  **Why here and not inside `TerminalService.closeTerminal`, beside `clearZoom`.** That is
   *  the obvious home — it is the single choke point every genuine close funnels through, and
   *  it already drops a per-terminal slice entry for exactly this reason. It does not work for
   *  this one. `closeTerminal` opens with `if (!process) return; // Already closed`, and the
   *  exit listener deletes the process mapping BEFORE it emits `pty:exit`
   *  (`TerminalService.ts:70`) — which is the event that creates a session-exit record in the
   *  first place. So by the time a terminal has an entry here, `closeTerminal` always takes
   *  that early return, and a clear placed there would be a no-op on 100% of the entries it
   *  was meant to remove. (The same early return means `clearZoom` already misses an exited
   *  terminal's entry — pre-existing, and not this plan's to fix.) */
  clearSessionExit: (terminalId: string) => void;
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
  const {
    terminalId, removeFromUi, closeTerminal, clearCwdSnapshot, releaseSurface, clearSessionExit,
  } = deps;

  // Remove the pane from the UI immediately — do not wait on the backend.
  removeFromUi();

  if (!terminalId) return;

  // Spec 045 §3.3: the pane is gone for good — drop its directory so the map
  // cannot grow without bound and a recycled id can't inherit it.
  clearCwdSnapshot(terminalId);

  // ...and the session-closed record, for the same reason and in the same place. Three
  // per-terminal maps are now cleared here; a fourth added elsewhere is the one that leaks.
  clearSessionExit(terminalId);

  // ...and dispose the cached xterm engine for the same reason, in the same place.
  // The cache is keyed by terminalId, so this is per TERMINAL, exactly as the
  // tab-close path does it per pane of the tab it is closing (TabManager.closeOneTab).
  // Before the UI removal has been committed by React is the same window that path
  // uses — it disposes before its own `removeTab` dispatch — so the ordering here is
  // the proven one rather than a new one.
  releaseSurface(terminalId);

  // Fire-and-forget: the backend PTY kill can take multiple seconds and must
  // never block the pane's disappearance. Errors are logged, not thrown —
  // there is no UI left waiting on this by the time it settles.
  closeTerminal(terminalId).catch((error) => {
    console.error(`Failed to close terminal for pane (terminalId=${terminalId}):`, error);
  });
}
