import { CANVAS_SHELL_TYPE } from './tabKinds';

/** Tunable output-rate heuristic constants for the "running" indicator. */
export const WINDOW_MS = 1000;        // trailing window for the rate measure
export const EVAL_INTERVAL_MS = 400;  // how often the tracker re-evaluates
export const MIN_CHUNKS = 3;          // >= this many output chunks in the window → running
export const MIN_BYTES = 512;         // OR >= this many output bytes in the window → running
export const RESIZE_COOLDOWN_MS = 700; // after a window resize, ignore output this long
/**
 * After the user changes how they are LOOKING at a terminal — a Canvas Mode relocation, a
 * font zoom, a pane split, anything that resizes the PTY.
 *
 * Deliberately much longer than a plain window resize, because the chain is longer: the
 * geometry change waits on a DEBOUNCED fit and a backend round-trip before the TUI even starts
 * redrawing. 700ms was short enough that the repaint landed AFTER the window closed — which is
 * exactly the case this is for, so it suppressed nothing and the notification fired anyway.
 */
export const VIEW_CHANGE_COOLDOWN_MS = 2500;
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

/**
 * The per-PANE sibling of `computeRunningTabIds` (Req 8, plan/020 §2). Maps running processIds
 * to the set of owning terminalIds, de-duplicated — stopping one resolution step earlier
 * (`getTerminalIdForProcess`, not the tab walk on top of it), which is exactly the granularity
 * `RunningActivityTracker` already buffers output at (`buffers` is keyed by processId) but used
 * to throw away by rolling straight up to the tab. `resolveTerminal` returns the terminalId for
 * a processId, or null if it does not resolve (e.g. the pane tree hasn't seeded it yet).
 */
export function computeRunningTerminalIds(
  runningProcessIds: string[],
  resolveTerminal: (processId: string) => string | null,
): string[] {
  const terminalIds = new Set<string>();
  for (const pid of runningProcessIds) {
    const terminalId = resolveTerminal(pid);
    if (terminalId) terminalIds.add(terminalId);
  }
  return Array.from(terminalIds);
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
 * SUPPRESSION: `isSuppressed(processId, tabId)` reports whether this output must
 * not raise a notification. Two unrelated reasons share the mechanism because
 * they need identical handling:
 *
 *   - the source is MUTED (its tab is muted, or its own pane is muted); or
 *   - CANVAS MODE IS SHOWING, in which case the user is looking at every terminal
 *     at once and nothing is unseen (see `canvasIsShowing`).
 *
 * A suppressed source is excluded from `toFlag` (no bell / toast / OS notification
 * / chime — everything downstream hangs off the flag) but its mark STILL advances,
 * exactly like the active-tab case, so leaving the canvas — or unmuting later —
 * never rings a backlog of output the user has already watched go by. Defaults to
 * "never suppressed" for callers/tests that don't pass it.
 *
 * Pure: takes the current marks, returns a NEW marks map (no mutation).
 */
/**
 * Is Canvas Mode the tab on screen?
 *
 * **The reason this exists.** "Unseen output" is defined against a SINGLE active tab, which was
 * right while the canvas was a full-screen overlay: the user's terminal tab stayed active behind
 * it and stayed exempt. Under `design/010` D1a the canvas is itself a tab, so the moment it is
 * opened NO terminal tab is active — and every running terminal starts ringing the unseen bell,
 * firing a toast and a chime, while the user is looking straight at it on the canvas. Reported
 * from live testing, 2026-08-16: "very annoying".
 *
 * **This is NOT a suppression predicate on its own** — it used to be, and that was `plan/021` R3:
 * a blanket "nothing may notify while the canvas is up" silenced every terminal in the window
 * for as long as the canvas stayed open. See `overlaySuppressedTerminal` below for the rule that
 * replaced it, and why the premise was too strong.
 *
 * Takes the tab list rather than a `shellType` so the caller cannot pass the wrong tab's kind;
 * `activeTabId` is looked up here.
 */
export function canvasIsShowing(
  tabs: readonly { id: string; shellType?: string | null }[],
  activeTabId: string | null,
): boolean {
  if (!activeTabId) return false;
  return tabs.some((t) => t.id === activeTabId && t.shellType === CANVAS_SHELL_TYPE);
}

/**
 * Which ONE terminal, if any, the user is currently watching closely enough that its own
 * busy→idle transition must not notify (`plan/021` R4). `null` means "suppress nothing".
 *
 * **Why the canvas being open is not enough.** The rule this replaces was "the canvas shows
 * every terminal at once, so while it is up, seen is not one tab — it is all of them". That
 * over-claims: a canvas node is a PREVIEW, typically a few percent of natural size, and below
 * the `live` tier it is not painting at all. Treating a thumbnail the user is not reading as
 * "seen" silenced the notification the user opened the app to get. The premise holds for exactly
 * one surface — the OVERLAY, the single canvas surface rendered at 1:1 (`plan/020` §5) — so that
 * is the only terminal this returns.
 *
 * **Both conditions are load-bearing, and the second is the subtle one.** `overlayId` is
 * deliberately NOT cleared when the user leaves the canvas tab (`plan/020` §4: it records WHICH
 * NODE IS ENLARGED, a view fact that must survive a tab switch). So `overlayId` alone would keep
 * suppressing a terminal long after the user had switched to another tab and could no longer see
 * it — a value made to survive an event silently changes the meaning of everything keyed on it.
 * The canvas must actually be on screen for its overlay to count as "being watched".
 *
 * Returns the RENDERER LEAF id (`tb-*` / `tm-*`), which is the id space canvas nodes are keyed
 * by; callers holding a `pc-*` process id must map it first (see
 * `terminalService.getTerminalIdForProcess`).
 */
export function overlaySuppressedTerminal(
  tabs: readonly { id: string; shellType?: string | null }[],
  activeTabId: string | null,
  overlayId: string | null,
): string | null {
  return canvasIsShowing(tabs, activeTabId) ? overlayId : null;
}

export function computeUnseenUpdate(
  outputs: UnseenInput[],
  resolveTab: (processId: string) => string | null,
  activeTabId: string | null,
  alreadyUnseen: Set<string>,
  marks: Map<string, number>,
  now: number,
  debounceMs: number,
  isSuppressed: (processId: string, tabId: string) => boolean = () => false,
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
    // Suppressed source (muted, or the canvas is showing every terminal at once): the mark
    // was already advanced above, so nothing rings in arrears; the tab is simply never
    // flagged, which turns off every notification surface downstream of the flag.
    if (isSuppressed(processId, tabId)) continue;
    toFlag.add(tabId);
    causalByTab.set(tabId, Math.max(causalByTab.get(tabId) ?? 0, newest));
  }
  return { toFlag: Array.from(toFlag), marks: nextMarks, causalByTab };
}
