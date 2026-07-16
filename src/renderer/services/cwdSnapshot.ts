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
 * write (`{final: true}`) and a clear. Both async writers sample it while the
 * terminal is live and drop their result if it moved: refreshLiveCwds before its
 * await, and the exit write when its pane subscribes — see the guards for why.
 *
 * Entries deliberately OUTLIVE their snapshot: deleting one on clear would reset
 * the count to 0 and let a refresh that sampled 0 before the clear look current
 * again, resurrecting exactly the entry the clear removed.
 */
const writeGenerations = new Map<string, number>();

function bumpGeneration(terminalId: string): void {
  writeGenerations.set(terminalId, (writeGenerations.get(terminalId) ?? 0) + 1);
}

/** Read a terminal's current write generation, to be handed back to a later
 *  `setCwdSnapshot({final})`. Callers sample this at the moment the terminal is
 *  known LIVE (the pane subscribing to `pty:exit`); the write is then dropped if a
 *  clear moved the generation while the event was in flight. Same contract as the
 *  refresh guard below, for the same reason — see setCwdSnapshot. */
export function sampleCwdGeneration(terminalId: string): number {
  return writeGenerations.get(terminalId) ?? 0;
}

/** Remember a terminal's directory. Ignores empty/absent values so a cwd-less
 *  exit payload never erases a good one.
 *
 *  `final` marks a write as authoritative — the directory the shell actually died
 *  in, from the `terminal:exit` payload. It outranks any refresh still in flight
 *  (a refresh only ever holds a guess about a shell that was alive when it
 *  started). Refresh and session-restore writes leave it off.
 *
 *  `generation` gates the write against a clear that happened since it was sampled.
 *  A pane's close path clears SYNCHRONOUSLY (right after closeTerminal), but the
 *  `terminal:exit` it triggers arrives later — so without this an entry the clear
 *  just removed comes straight back for a pane that no longer exists. Omitting it
 *  leaves the write ungated (session-restore and other non-racing callers). */
export function setCwdSnapshot(
  terminalId: string,
  cwd: string | null | undefined,
  opts?: { final?: boolean; generation?: number },
): void {
  if (!cwd) return;
  if (opts?.generation !== undefined && sampleCwdGeneration(terminalId) !== opts.generation) return;
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
 *  autosave tick and one dead terminal must not break the rest.
 *
 *  ONE batch call, not one per terminal. Only PowerShell populates the backend's
 *  OSC cwd map, so every cmd/WSL/bash/zsh terminal (i.e. every terminal on Linux)
 *  falls back to a full `System::new_all()` process scan — 50-200ms each. Fanned
 *  out per terminal that was N scans per tick; the batch command builds the process
 *  snapshot once and resolves every pid against it. */
export async function refreshLiveCwds(terminalIds: string[]): Promise<void> {
  try {
    // Sample BEFORE the await: the read can take long enough for a terminal to
    // `cd` and exit, or be restarted, while it is in flight. Anything we learned
    // before that is stale, and storing it would reopen the shell in the pre-`cd`
    // directory — the bug this snapshot exists to prevent. Per terminal, so one
    // terminal exiting mid-batch doesn't discard the others' results.
    const pending = terminalIds
      .map(terminalId => ({
        terminalId,
        processId: terminalService.getProcessId(terminalId),
        generation: sampleCwdGeneration(terminalId),
      }))
      .filter((t): t is typeof t & { processId: string } => Boolean(t.processId));
    if (pending.length === 0) return;

    const byProcessId = await window.electronAPI?.getTerminalCwds?.(
      pending.map(t => t.processId),
    );
    if (!byProcessId) return;

    for (const { terminalId, processId, generation } of pending) {
      if (sampleCwdGeneration(terminalId) !== generation) continue;
      setCwdSnapshot(terminalId, byProcessId[processId]);
    }
  } catch {
    // The read failed, or the API is unavailable. Keep any previous values; the
    // profile default is the ultimate fallback.
  }
}

/** Test-only: reset module state between cases. */
export function __resetCwdSnapshots(): void {
  snapshots.clear();
  writeGenerations.clear();
}
