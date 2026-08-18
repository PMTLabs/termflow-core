import { CanvasEdge } from '../../store/slices/canvasSlice';

/**
 * Wiring a terminal that does not exist yet.
 *
 * `POST /api/canvas/edges` resolves both endpoints through `AppState::resolve_renderer_id` and
 * answers **404 "destination terminal not found"** for one it has never heard of. A terminal
 * created from the canvas is exactly that for the first second or so of its life: the tab is
 * dispatched to Redux, then React renders `TerminalContainer`, then `PaneManager`, then
 * `TerminalPane` mounts and invokes the backend, and only then does the process exist.
 *
 * Firing the edge immediately after `addTab` therefore lost it every time — Tam's report that
 * a port click "needs to auto setup connection to the new terminal" was not a missing feature
 * but a request that never arrived. **The failure was silent by design:** `createEdge` catches
 * and returns `null`, which the caller treated as "the server declined", which is the correct
 * reading for a duplicate or a self-edge and the wrong one here.
 */

/** How often to re-check. Short enough to feel immediate, long enough not to spin. */
export const CONNECT_POLL_MS = 100;

/**
 * How long to keep trying before giving up.
 *
 * A cold spawn is fast, but this is the first terminal of a session on a machine that may be
 * compiling, and a shell that takes four seconds to appear is not broken. Ten seconds is well
 * past any real spawn and still bounded — the alternative, waiting forever, leaves a promise
 * pinned to a terminal the user may already have closed.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

export interface ConnectDeps {
  /** Has this terminal registered its backend process yet? */
  isReady: (terminalId: string) => boolean;
  createEdge: (from: string, to: string) => Promise<CanvasEdge | null>;
  wait: (ms: number) => Promise<void>;
  /** Monotonic-ish clock, injected so a test does not sleep. */
  now: () => number;
  /**
   * Give up NOW, whatever the deadline says.
   *
   * The poll runs for up to ten seconds and then wires the pair anyway, which is right while
   * the canvas is still there — a terminal that registered in the last interval is a likely
   * win. It is wrong once the canvas has gone: the loop kept a closure alive for the rest of
   * that window and then created an edge for a workspace nobody is looking at, from a source
   * node the user may have closed in the meantime.
   *
   * Optional so existing callers and tests keep their behaviour; absent means "never abort".
   */
  abandoned?: () => boolean;
}

/**
 * Wait for `toId` to exist, then draw the edge.
 *
 * Returns the server's row, or `null` if the terminal never appeared or the server refused.
 *
 * The readiness gate is the renderer's own process registry rather than a retry on the POST
 * itself, and the distinction matters: `terminalService` binds the id only after
 * `createTerminal` has RESOLVED, which is after the backend registered the terminal — so a
 * ready terminal is one the endpoint can already resolve. Retrying the POST blind would work
 * too, but every attempt would be a 404 in the log and a real refusal (a self-edge, a bad id)
 * would be indistinguishable from "not yet".
 *
 * One attempt is still made after the deadline expires: the terminal may have registered in
 * the last interval, and a timeout that never tries is a guaranteed loss where a late try is
 * a likely win.
 */
export async function connectWhenReady(
  deps: ConnectDeps,
  fromId: string,
  toId: string,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<CanvasEdge | null> {
  const deadline = deps.now() + timeoutMs;
  while (!deps.isReady(toId)) {
    // Checked BEFORE the deadline branch, so abandoning wins over the last-attempt rule —
    // otherwise a canvas torn down on the final tick would still create the edge.
    if (deps.abandoned?.()) return null;
    if (deps.now() >= deadline) {
      console.warn(`[CANVAS] ${toId} never registered; connecting anyway as a last attempt`);
      break;
    }
    await deps.wait(CONNECT_POLL_MS);
  }
  // ...and again after the loop: `wait` is the only suspension point, so the canvas can have
  // gone away during the very interval that made the terminal ready.
  if (deps.abandoned?.()) return null;
  return deps.createEdge(fromId, toId);
}
