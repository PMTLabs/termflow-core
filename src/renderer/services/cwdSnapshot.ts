/**
 * Spec 045 §3.3 — last-known working directory per terminal.
 *
 * Two writers, because the value is needed at three moments and no single
 * mechanism covers them all:
 *
 *  1. RESTART — written from the `terminal:exit` payload (Task 3). It CANNOT be
 *     read back from the renderer: pty_manager.rs:690 calls
 *     cleanup_terminal_state (wiping `terminal_cwds` AND `terminals`) before
 *     emitting the event at :693, so get_terminal_cwd would return None every
 *     time. The backend hands us the value instead.
 *
 *  2. SESSION SAVE — refreshLiveCwds() on the existing 30s autosave tick. A
 *     terminal still running when the app closes never fires an exit event, so
 *     (1) can never cover it. saveState() runs from `beforeunload` and is
 *     synchronous through to localStorage.setItem, so it cannot await a read —
 *     the map must already be warm when it runs.
 *
 * A missing value degrades to `undefined`, and callers fall back to the profile
 * cwd — today's behaviour, never worse. Stale directories are not validated
 * here: pty_manager.rs:583-587 is_dir()-checks the spawn cwd and falls back to
 * the default, which is the spec's edge case.
 */
import { terminalService } from './TerminalService';

const snapshots = new Map<string, string>();

/** Remember a terminal's directory. Ignores empty/absent values so a cwd-less
 *  exit payload never erases a good one. */
export function setCwdSnapshot(terminalId: string, cwd: string | null | undefined): void {
  if (cwd) snapshots.set(terminalId, cwd);
}

/** Last-known cwd for a terminal, or undefined if we never captured one. */
export function getCwdSnapshot(terminalId: string): string | undefined {
  return snapshots.get(terminalId);
}

/** Forget a terminal's directory (restarted, or its pane is gone for good).
 *  Load-bearing: without it a second exit that carries no cwd would silently
 *  reuse the FIRST exit's directory — a wrong-directory bug that is worse than
 *  falling back to the profile default. */
export function clearCwdSnapshot(terminalId: string): void {
  snapshots.delete(terminalId);
}

/** All snapshots, for persistence by StateManager. */
export function getAllCwdSnapshots(): Record<string, string> {
  return Object.fromEntries(snapshots);
}

/** Refresh the directories of terminals that are still RUNNING, so a session
 *  save has something to persist for them. Never rejects: it runs on the
 *  autosave tick and one dead terminal must not break the rest. */
export async function refreshLiveCwds(terminalIds: string[]): Promise<void> {
  await Promise.all(
    terminalIds.map(async terminalId => {
      try {
        const processId = terminalService.getProcessId(terminalId);
        if (!processId) return;
        const cwd = await window.electronAPI?.getTerminalCwd?.(processId);
        setCwdSnapshot(terminalId, cwd);
      } catch {
        // Terminal died mid-refresh, or the API is unavailable. Keep any
        // previous value; the profile default is the ultimate fallback.
      }
    }),
  );
}

/** Test-only: reset module state between cases. */
export function __resetCwdSnapshots(): void {
  snapshots.clear();
}
