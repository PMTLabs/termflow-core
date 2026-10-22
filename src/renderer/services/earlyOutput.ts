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
 * appeared mid-screen after an invisible prompt. Startup restores make that window wide —
 * every tab is created at once while the others hydrate their replays.
 *
 * So chunks for a process nobody has claimed yet are held here and handed to the FIRST
 * subscriber (`MainBridge.onData`), which feeds them to the engine before any live chunk.
 * The engine buffers them like any other chunk that arrives mid-hydration, so a screen
 * snapshot still drops them (already reflected) and a prefix-only one writes them after the
 * replay, in order.
 *
 * Once a process has been claimed it is never buffered again: a later remount re-hydrates
 * from a screen snapshot, exactly as before. A process no pane ever claims (an API-created
 * terminal, or one owned by another window) stops being buffered `EARLY_OUTPUT_WINDOW_MS`
 * after its first chunk, and each buffer keeps only its newest `EARLY_OUTPUT_CAP_BYTES`.
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
  /** Claimed by a subscriber, or past its window: never buffered again. */
  private closed = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Hold `data` for `processId` if no subscriber has claimed it yet. */
  record(processId: string, data: string): void {
    if (this.closed.has(processId)) return;
    const now = this.now();
    let entry = this.held.get(processId);
    if (!entry) {
      this.sweep(now);
      entry = { chunks: [], bytes: 0, firstAt: now };
      this.held.set(processId, entry);
    } else if (now - entry.firstAt > EARLY_OUTPUT_WINDOW_MS) {
      this.held.delete(processId);
      this.closed.add(processId);
      return;
    }
    entry.chunks.push(data);
    entry.bytes += data.length;
    while (entry.bytes > EARLY_OUTPUT_CAP_BYTES && entry.chunks.length > 1) {
      entry.bytes -= entry.chunks.shift()!.length;
    }
  }

  /** Take what is held for `processId`, oldest first, and stop holding its output. */
  claim(processId: string): string[] {
    this.closed.add(processId);
    const entry = this.held.get(processId);
    this.held.delete(processId);
    return entry ? entry.chunks : [];
  }

  /** The process is gone: its ids are never reused, so drop the bookkeeping. */
  forget(processId: string): void {
    this.held.delete(processId);
    this.closed.delete(processId);
  }

  private sweep(now: number): void {
    for (const [processId, entry] of this.held) {
      if (now - entry.firstAt > EARLY_OUTPUT_WINDOW_MS) {
        this.held.delete(processId);
        this.closed.add(processId);
      }
    }
  }
}

export const earlyOutput = new EarlyOutput();
