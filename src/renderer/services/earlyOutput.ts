/**
 * PTY output that reaches this window before any pane has subscribed to its process.
 *
 * `TerminalService` re-dispatches every chunk as a `pty:data` window event, and a pane's
 * engine only listens once `createTerminal` has resolved, React has re-rendered with the
 * process id, and `TerminalDisplay`'s effect has run `engine.attach()`. Whatever the shell
 * printed in between used to be dropped on the floor. For an ordinary spawn that was
 * harmless — hydration's screen snapshot comes from the backend parser, which saw every
 * byte — but a RESTORED terminal hydrates from a prefix-only snapshot (the previous
 * session's scrollback, not the screen), so its shell's first prompt was simply gone: the
 * cursor sat on the prompt row ConPTY was told about, with nothing on it, and typing
 * appeared mid-screen after an invisible prompt. Seen on a startup restore of nine tabs, where
 * every tab is created at once while the others hydrate their replays (the width of the window
 * in that case was not measured).
 *
 * So chunks for a process nobody has claimed yet are held here and handed to the FIRST
 * subscriber (`MainBridge.onData`), which feeds them to the engine before any live chunk.
 * The engine buffers them like any other chunk that arrives mid-hydration, so a screen
 * snapshot still drops them (already reflected) and a prefix-only one writes them after the
 * replay, in order.
 *
 * Once a process has been claimed or closed it is never held again: a later remount
 * re-hydrates from a screen snapshot, exactly as before, and a chunk the backend coalesces past
 * the process's exit event is not mistaken for a new process. That bookkeeping is retired
 * `EARLY_OUTPUT_WINDOW_MS` after the exit event (which every window receives), so it does not
 * grow with every process a long-lived window ever saw.
 *
 * Explicit registration of an existing process — a pane moved in from another window, a
 * reconciled or API-created terminal, a hidden agent terminal restored — closes it in
 * `registerExistingTerminal`, so those hydrate exactly as before. A pane's own admission does
 * NOT: `AlreadyBound` is the same pane copy mounting for the process it just created, and
 * `Existing` re-binds this leaf's process after a reload or copy change. Their held output is
 * the process's own; a screen snapshot drops it as already reflected, and a restore that has
 * not hydrated yet needs it — that is the prompt this module exists to keep.
 *
 * Exit does NOT drop what is held: a shell that fails at startup and exits before its pane
 * subscribes still shows what it printed. Held output is handed over only within
 * `EARLY_OUTPUT_WINDOW_MS` of its first chunk; after that `claim` returns nothing, and the
 * memory is released the next time a new process starts (or it is claimed or closed). Each
 * buffer keeps its newest chunks up to `EARLY_OUTPUT_CAP_BYTES` (counted in string length, like
 * the engine's own hydration buffer), evicting the oldest first; a single chunk larger than the
 * cap is kept whole. The cap is per process: there is no global bound beyond how many processes
 * start within one window.
 */

/** How long after a process's first chunk its output is still held for a subscriber. */
export const EARLY_OUTPUT_WINDOW_MS = 30_000;
/** Per-process byte cap; the oldest chunks are evicted first, like the engine's own buffer. */
export const EARLY_OUTPUT_CAP_BYTES = 1_000_000;

interface Held {
  chunks: string[];
  bytes: number;
  firstAt: number;
}

export class EarlyOutput {
  private held = new Map<string, Held>();
  /** Claimed, closed, or past its window: never held again. */
  private closed = new Set<string>();
  /** When each exited process's bookkeeping may be dropped (exit + the window). */
  private retireAt = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Hold `data` for `processId` if no subscriber has claimed it yet. */
  record(processId: string, data: string): void {
    if (this.closed.has(processId)) return;
    const now = this.now();
    let entry = this.held.get(processId);
    if (!entry) {
      this.sweep(now);
      entry = { chunks: [], bytes: 0, firstAt: now };
      this.held.set(processId, entry);
    } else if (this.expired(entry, now)) {
      this.close(processId);
      return;
    }
    entry.chunks.push(data);
    entry.bytes += data.length;
    while (entry.bytes > EARLY_OUTPUT_CAP_BYTES && entry.chunks.length > 1) {
      entry.bytes -= entry.chunks.shift()!.length;
    }
  }

  /** Take what is held for `processId` (oldest first, nothing once its window has passed). */
  claim(processId: string): string[] {
    const entry = this.held.get(processId);
    this.close(processId);
    return entry && !this.expired(entry, this.now()) ? entry.chunks : [];
  }

  /** Never hold `processId`'s output, and drop what is held. */
  close(processId: string): void {
    this.held.delete(processId);
    this.closed.add(processId);
  }

  /**
   * The process exited. Held output stays (a pane that subscribes late still shows it); the
   * bookkeeping is dropped once no chunk coalesced past the exit can still arrive.
   */
  exited(processId: string): void {
    this.retireAt.set(processId, this.now() + EARLY_OUTPUT_WINDOW_MS);
  }

  private expired(entry: Held, now: number): boolean {
    return now - entry.firstAt > EARLY_OUTPUT_WINDOW_MS;
  }

  private sweep(now: number): void {
    for (const [processId, entry] of this.held) {
      if (this.expired(entry, now)) this.close(processId);
    }
    for (const [processId, at] of this.retireAt) {
      if (now < at) continue;
      this.retireAt.delete(processId);
      this.held.delete(processId);
      this.closed.delete(processId);
    }
  }
}

export const earlyOutput = new EarlyOutput();
