import { createSlice, PayloadAction } from '@reduxjs/toolkit';

/**
 * Which terminals' shell sessions have ENDED, per terminal — `plan/024` Req 4.
 *
 * This fact already existed, in the one place nothing else could reach it: `TerminalPane` held it
 * as `useState<{ exitCode } | null>`, set from a `pty:exit` listener. That was enough while the
 * only surface that cared was the pane itself. Canvas Mode added two more — a node has to draw
 * itself muted when its session is over, and the overlay has to offer the same
 * `SessionClosedBanner` a pane does — and neither can see a sibling component's local state.
 *
 * **Why not the two facts that already exist in the store.** `Tab.exited` is TAB-level and only
 * flips once EVERY pane in the tab has exited (`App.tsx` `handleTerminalProcessExit` /
 * `resolveExitedTabId`), so a split tab with one dead pane reports nothing — and a canvas node is
 * a pane. `terminalService.getProcessId` is per-terminal but imperative: it answers correctly and
 * re-renders nothing, which is why `isTerminalAlive` drives close-confirmation and not paint.
 *
 * **Transient, like `hasUnseenOutput` and `isRunning`.** A restored workspace has not started its
 * shells yet, so a persisted entry here would draw banners for sessions that never ran.
 * `StateManager.sanitizeLayoutData` strips it; `sessionExit.sanitize.test.ts` pins that.
 *
 * Keyed by RENDERER terminal id (`tb-*` / `tm-*`) — the id space canvas nodes and pane leaves are
 * keyed by, not the backend `pc-*` process id. A caller holding a process id must map it first.
 */

export interface SessionExitInfo {
  /** The shell's exit status, or null when the backend could not report one. */
  exitCode: number | null;
}

export interface SessionExitState {
  /** terminalId → how its session ended. Absent means "still running, or never started". */
  byTerminalId: Record<string, SessionExitInfo>;
}

const initialState: SessionExitState = { byTerminalId: {} };

const sessionExitSlice = createSlice({
  name: 'sessionExit',
  initialState,
  reducers: {
    /** A shell exited. Idempotent — a repeated event for the same terminal is not a new fact. */
    markSessionClosed: (
      state,
      action: PayloadAction<{ terminalId: string; exitCode: number | null }>,
    ) => {
      const { terminalId, exitCode } = action.payload;
      state.byTerminalId[terminalId] = { exitCode };
    },

    /**
     * This terminal is live again, or the user dismissed the notice.
     *
     * One action for both, deliberately: a restart and a dismiss leave the same observable state
     * and splitting them would invite a third caller to pick the wrong one. What differs is what
     * happens AROUND them, and that belongs to the caller.
     *
     * DELETES the key rather than writing a sentinel. "Never started" and "restarted" must be
     * the same state — a terminal that carried, say, `{ exitCode: null }` as a stand-in for
     * "cleared" would be indistinguishable from one whose shell died without a status, and the
     * node would stay muted forever.
     */
    clearSessionClosed: (state, action: PayloadAction<{ terminalId: string }>) => {
      delete state.byTerminalId[action.payload.terminalId];
    },

    /** Drop everything — used when a window's whole workspace is torn down or replaced. */
    clearAllSessionClosed: (state) => {
      state.byTerminalId = {};
    },
  },
});

export const { markSessionClosed, clearSessionClosed, clearAllSessionClosed } =
  sessionExitSlice.actions;
export default sessionExitSlice.reducer;
