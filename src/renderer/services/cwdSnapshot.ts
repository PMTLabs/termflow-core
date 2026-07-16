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

/**
 * Write generation per terminal, bumped by the two AUTHORITATIVE events: an exit
 * write (`{final: true}`) and a clear. refreshLiveCwds samples it before its await
 * and drops its result if it moved — see the guard there for why.
 *
 * Entries deliberately OUTLIVE their snapshot: deleting one on clear would reset
 * the count to 0 and let a refresh that sampled 0 before the clear look current
 * again, resurrecting exactly the entry the clear removed.
 */
const writeGenerations = new Map<string, number>();

function bumpGeneration(terminalId: string): void {
  writeGenerations.set(terminalId, (writeGenerations.get(terminalId) ?? 0) + 1);
}

/** Remember a terminal's directory. Ignores empty/absent values so a cwd-less
 *  exit payload never erases a good one.
 *
 *  `final` marks a write as authoritative — the directory the shell actually died
 *  in, from the `terminal:exit` payload. It outranks any refresh still in flight
 *  (a refresh only ever holds a guess about a shell that was alive when it
 *  started). Refresh and session-restore writes leave it off. */
export function setCwdSnapshot(
  terminalId: string,
  cwd: string | null | undefined,
  opts?: { final?: boolean },
): void {
  if (!cwd) return;
  snapshots.set(terminalId, cwd);
  if (opts?.final) bumpGeneration(terminalId);
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
  // Also invalidates any refresh in flight, which would otherwise resolve later
  // and repopulate the entry we just removed.
  bumpGeneration(terminalId);
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
        // Sample BEFORE the await: the read can take long enough for the terminal
        // to `cd` and exit, or be restarted, while it is in flight. Anything we
        // learned before that is stale, and storing it would reopen the shell in
        // the pre-`cd` directory — the bug this snapshot exists to prevent.
        const generation = writeGenerations.get(terminalId) ?? 0;
        const cwd = await window.electronAPI?.getTerminalCwd?.(processId);
        if ((writeGenerations.get(terminalId) ?? 0) !== generation) return;
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
  writeGenerations.clear();
}
