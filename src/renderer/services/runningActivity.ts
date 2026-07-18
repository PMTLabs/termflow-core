/** Tunable output-rate heuristic constants for the "running" indicator. */
export const WINDOW_MS = 1000;        // trailing window for the rate measure
export const EVAL_INTERVAL_MS = 400;  // how often the tracker re-evaluates
export const MIN_CHUNKS = 3;          // >= this many output chunks in the window → running
export const MIN_BYTES = 512;         // OR >= this many output bytes in the window → running
export const RESIZE_COOLDOWN_MS = 700; // after a window resize, ignore output this long
                                       // (SIGWINCH makes every TUI redraw at once — a
                                       // synchronized burst that otherwise reads as
                                       // "all tabs running")
export const RECONNECT_COOLDOWN_MS = 1500; // after the app regains visibility (RDP
                                       // reconnect / un-minimize / refocus), ignore output
                                       // this long — ConPTY repaints every TUI at once, a
                                       // synchronized burst like a resize that otherwise
                                       // falsely rings the unseen bell on quiet tabs.
export const STARTUP_COOLDOWN_MS = 3000; // on app start/restore, ignore output this long.
                                       // Restored tabs spawn (or reattach) their PTYs right
                                       // after the tracker starts, so every shell prints its
                                       // prompt/banner and reattached TUIs repaint at once —
                                       // a synchronized burst like a reconnect. Nothing was
                                       // "missed" on a fresh start, so this output must not
                                       // ring the unseen bell on the inactive restored tabs.
export const BURST_TAB_THRESHOLD = 3; // if this many inactive tabs would be flagged unseen
                                       // in a SINGLE eval tick, treat it as a synchronized
                                       // repaint burst (resize / RDP↔console reattach /
                                       // un-minimize — ConPTY redraws every TUI at once) and
                                       // suppress the whole batch. Genuine per-tab activity
                                       // settles at independent times (one tab per tick), so
                                       // a simultaneous many-tab flag is a repaint, not real
                                       // activity. Trigger-independent backstop for bursts the
                                       // resize/visibility/session-change signals miss.
export const UNSEEN_DEBOUNCE_MS = 2000; // an inactive tab's output must stay idle this long
                                       // before it rings the unseen bell. Riding through
                                       // bursty/intermittent output prevents the bell from
                                       // flashing on/off while a process is mid-execution.
export const ECHO_WINDOW_MS = 250;    // output arriving within this long after a user keystroke
                                       // (and before the command is submitted) is treated as the
                                       // shell echoing / re-rendering what the user just typed —
                                       // NOT autonomous program activity. Keeps live typing from
                                       // flipping the tab sweep. This is time-based ONLY, with no
                                       // size cap: PowerShell/PSReadLine (the Windows default) redraws
                                       // the WHOLE input line with syntax-highlight VT sequences on
                                       // every keystroke (60-200+ bytes), so a byte cap would let those
                                       // repaints through and sweep while the user types. Real command
                                       // output only arrives AFTER Enter, which resets the gate (see
                                       // isSubmitInput), so nothing genuine is lost by dropping the cap.

export interface OutputEvent {
  t: number;     // timestamp (ms)
  bytes: number; // byte length of the output chunk
}

export interface RunningOpts {
  windowMs: number;
  minChunks: number;
  minBytes: number;
}

/**
 * Decide whether a terminal is "actively processing" from its recent output
 * events. Running when, within the trailing window, the output is bursty enough:
 * chunk count >= minChunks OR total bytes >= minBytes. A low-rate idle redraw
 * (e.g. a once-a-second status-line clock) stays below both thresholds → idle.
 */
export function isRunningFromEvents(
  events: OutputEvent[],
  now: number,
  opts: RunningOpts,
): boolean {
  const cutoff = now - opts.windowMs;
  let chunks = 0;
  let bytes = 0;
  for (const e of events) {
    if (e.t >= cutoff) {
      chunks++;
      bytes += e.bytes;
    }
  }
  return chunks >= opts.minChunks || bytes >= opts.minBytes;
}

/**
 * A PTY output chunk is shell ECHO/repaint of the user's own keystrokes when it
 * arrives within ECHO_WINDOW_MS of an input write (and before submit). Typing into a
 * shell makes it re-render the input line back as output; without excluding that, live
 * typing trips the >= MIN_CHUNKS running heuristic and animates the tab sweep even
 * though nothing is actually running. `sinceInputMs` is `now - lastInputAt` for the
 * chunk's terminal (Infinity when there was no recent input, or Infinity after a submit
 * resets lastInputAt to -Infinity — either way a large gap, so not echo).
 *
 * Time-based ONLY, deliberately with NO size cap. An earlier version also required the
 * chunk to be small (<= 48B), assuming echo is per-character. That is false for the
 * Windows default shell: PowerShell/PSReadLine repaints the WHOLE input line with
 * syntax-highlight VT sequences on every keystroke (60-200+ bytes), so the size cap let
 * those big repaints through and the sweep animated while typing. Since genuine command
 * output only arrives AFTER Enter (which resets the gate via isSubmitInput), keying purely
 * on time is correct: any output landing in the window is a consequence of the keystroke.
 *
 * Scope (accepted tradeoffs): output a program emits within ECHO_WINDOW_MS of a keystroke
 * — e.g. an interactive fuzzy-finder repainting as you type, or a streaming program you
 * type into mid-stream — is also excluded from the running rate for that window. This
 * matches the requirement ("typing must not trigger the sweep") and self-corrects once
 * typing pauses. It never affects the unseen bell (lastOutputAt is updated regardless).
 */
export function isEchoChunk(sinceInputMs: number): boolean {
  return sinceInputMs <= ECHO_WINDOW_MS;
}

/**
 * A bare Enter keypress (submits the current command). The output the command then
 * produces must NOT be echo-suppressed, so on submit the caller resets the
 * terminal's lastInputAt to -Infinity. A multi-character paste (even one containing
 * a newline) is deliberately NOT a submit — only a lone CR/LF is.
 */
export function isSubmitInput(data: string): boolean {
  return data === '\r' || data === '\n' || data === '\r\n';
}

/**
 * Whether an output chunk should count toward the "running" rate buffer (the tab
 * sweep). Excludes keystroke echo/line-repaints (time-based; see isEchoChunk). This
 * ONLY gates the running sweep — the unseen bell's lastOutputAt timeline is intentionally
 * left untouched by the caller so genuine background activity is never lost.
 */
export function shouldCountForRunning(now: number, lastInputAt: number): boolean {
  return !isEchoChunk(now - lastInputAt);
}

/**
 * Map a list of running processIds to the set of owning tabIds, de-duplicated.
 * `resolveTab` returns the tabId for a processId, or null if none owns it.
 */
export function computeRunningTabIds(
  runningProcessIds: string[],
  resolveTab: (processId: string) => string | null,
): string[] {
  const tabIds = new Set<string>();
  for (const pid of runningProcessIds) {
    const tabId = resolveTab(pid);
    if (tabId) tabIds.add(tabId);
  }
  return Array.from(tabIds);
}

/** One process's most recent output timestamp (its persistent lastOutputAt). */
export interface UnseenInput {
  processId: string;
  newest: number; // timestamp (ms) of the most recent output event seen for this process
}

/**
 * Decide which inactive tabs to newly flag as having unseen output, and return
 * the advanced per-process high-water marks.
 *
 * DEBOUNCED: a process only contributes once its most recent output is at least
 * `debounceMs` old (i.e. output has SETTLED). While output is still streaming
 * (`now - newest < debounceMs`) the process is skipped without advancing its
 * mark, so a later tick retries it once idle. Each fresh chunk bumps `newest`,
 * which naturally resets the debounce — this is what keeps the bell from
 * flashing on/off during bursty, mid-execution output.
 *
 * Each output is still accounted for AT MOST ONCE: a process only contributes
 * when its newest output is strictly newer than its prior mark. This prevents
 * the stale-buffer races —
 *   (a) output produced while a tab was active (seen live) being reclassified as
 *       unseen after the user switches away, and
 *   (b) the same output re-flagging a tab after it was focused/cleared.
 *
 * The mark advances ONLY when the process resolves to a tab. An unresolved
 * process (its pane tree not seeded yet) is left un-marked so a later tick
 * retries it — preserving the late-seeding catch.
 *
 * Pure: takes the current marks, returns a NEW marks map (no mutation).
 */
export function computeUnseenUpdate(
  outputs: UnseenInput[],
  resolveTab: (processId: string) => string | null,
  activeTabId: string | null,
  alreadyUnseen: Set<string>,
  marks: Map<string, number>,
  now: number,
  debounceMs: number,
): { toFlag: string[]; marks: Map<string, number>; causalByTab: Map<string, number> } {
  const nextMarks = new Map(marks);
  const toFlag = new Set<string>();
  // Causal output time per flagged tab — built ONLY from the settled, eligible outputs
  // that actually cause the flag (not from all outputs), so the notification gate can't
  // be defeated by an unsettled sibling process borrowing a newer timestamp.
  const causalByTab = new Map<string, number>();
  for (const { processId, newest } of outputs) {
    if (newest <= (nextMarks.get(processId) ?? -Infinity)) continue; // nothing new
    if (now - newest < debounceMs) continue; // still streaming → wait for it to settle
    const tabId = resolveTab(processId);
    if (!tabId) continue; // unresolved → retry next tick, do NOT advance the mark
    nextMarks.set(processId, newest); // resolved + settled → this output is now accounted for
    if (tabId === activeTabId || alreadyUnseen.has(tabId)) continue;
    toFlag.add(tabId);
    causalByTab.set(tabId, Math.max(causalByTab.get(tabId) ?? 0, newest));
  }
  return { toFlag: Array.from(toFlag), marks: nextMarks, causalByTab };
}
