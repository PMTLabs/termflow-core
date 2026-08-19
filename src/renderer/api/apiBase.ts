import { invoke } from '@tauri-apps/api/core';
import type { EffectiveEndpoints } from '../types/electron';

/**
 * Which REST API this window is allowed to talk to.
 *
 * **The configured port is not an address.** `default_api_port()` reads only `is_dev()`, so
 * every release instance — the shipped app, `--profile nightly`, `--profile alt` — is
 * configured for 42031. Whichever starts first binds it; the rest walk forward
 * (`net_ports::bind_api_listener`) and serve on 42033, 42035, … The backend records that in
 * `effective_endpoints` and deliberately leaves `network.api_port` at the configured value,
 * because Settings must keep submitting what the user chose rather than a one-off fallback.
 *
 * The renderer resolved its base URL from `get_network_config` — the CONFIGURED port — so a
 * second instance sent every REST call to the FIRST instance's server. Reads returned another
 * app's terminals; `POST /api/canvas/edges` was answered by a backend that had never heard of
 * these terminal ids, so it 404'd, `createEdge` swallowed the error and returned `null`, and
 * the wire the user drew simply never appeared. Nothing in the UI could say why.
 *
 * **There is deliberately no fallback to the configured port.** Every state in which the
 * effective port is unknown — still binding, bind failed outright, API suppressed for an
 * elevated profile — is a state in which the configured port is either dead or *someone
 * else's*. Falling back to it is not a degraded answer, it is the bug. Callers get a thrown
 * error instead, which is what they already handle for a non-2xx response.
 */

/** How often to re-ask while the backend is still binding. */
export const RESOLVE_POLL_MS = 100;

/**
 * How long a SINGLE probe may take before it is abandoned.
 *
 * The deadline below is checked between probes, so without this an `invoke` that never
 * settles — an IPC wedge, a host tearing down — is never timed out by it: the loop simply
 * stops at the await and every REST consumer waits forever. Generous for a loopback IPC
 * round trip, and abandoning a slow probe costs only one extra poll.
 */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * How long the FIRST resolution may wait for the bind.
 *
 * The listener is bound from a task spawned in `setup()`, so the bundle can easily load
 * first — the boot race is normal, not exceptional. Ten-plus seconds is well past any real
 * bind (it is a loopback socket) and still bounded, so a suppressed API surfaces as an error
 * rather than a promise nobody ever settles.
 */
export const RESOLVE_TIMEOUT_MS = 15_000;

export interface ResolveDeps {
  /** The port the backend actually BOUND; `null` while binding, or if it never did. */
  effectivePort: () => Promise<number | null>;
  wait: (ms: number) => Promise<void>;
  /** Monotonic-ish clock, injected so a test does not sleep. */
  now: () => number;
}

/**
 * Poll until the backend reports a bound port, or the deadline passes.
 *
 * One probe always happens before the deadline is consulted, so `timeoutMs = 0` means
 * "ask exactly once" rather than "never ask" — that is what makes re-resolution after a
 * port change cheap.
 *
 * A throwing probe is treated as "not yet", not as a failure: the command is unavailable
 * for the first moments of a window's life, and giving up there would pin the whole
 * session to an error.
 */
export async function resolveApiPort(
  deps: ResolveDeps,
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<number | null> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    // Raced rather than awaited: a probe that never settles must not outlive the deadline.
    // A rejection and an abandonment both read as "not yet", which is what keeps a slow
    // start indistinguishable from a slow answer — and both are retried, not fatal.
    const port = await Promise.race([
      deps.effectivePort().catch(() => null),
      deps.wait(PROBE_TIMEOUT_MS).then(() => null),
    ]);
    if (typeof port === 'number' && port > 0) return port;
    if (deps.now() >= deadline) return null;
    await deps.wait(RESOLVE_POLL_MS);
  }
}

/** Same check `index.tsx` uses to pick a bridge. */
const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  (!!(window as any).__TAURI_INTERNALS__ || !!(window as any).__TAURI__);

const liveDeps: ResolveDeps = {
  effectivePort: async () => {
    const eff = await invoke<EffectiveEndpoints>('get_effective_endpoints');
    return eff?.apiPort ?? null;
  },
  wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** In flight or resolved. Shared, so concurrent callers never start a second poll. */
let pending: Promise<number> | null = null;
/** Whether a resolution has ever run to completion — see the timeout choice below. */
let attempted = false;
/**
 * Bumped by every invalidation, so a resolution can tell whether it is still the current one.
 *
 * Without it the state machine is not linearizable, and both ways of losing that race route
 * wrongly: a resolution started before a rebind would hand its caller the port we have since
 * RELEASED — which is exactly the port a sibling is free to take — and its failure handler
 * would clear a memo a newer resolution had already filled, throwing away a correct answer.
 */
let generation = 0;

/**
 * The port this window's API server is listening on.
 *
 * Memoised on success for the life of the window. On failure the memo is cleared so a later
 * call tries again — the API can legitimately arrive late (Settings ▸ Start servers).
 *
 * The first attempt absorbs the boot race; every later one probes ONCE, because by then the
 * only reason for a null is that there is no server, and a polling caller must not stall for
 * fifteen seconds each time round.
 */
export function apiPort(): Promise<number> {
  // The browser-dev harness (`start-web-dev`) has no backend to ask. `invoke` would simply
  // reject there, and a rejecting probe reads as "not yet" — so every caller would sit out
  // the whole boot-race window before failing. Refuse up front instead; that harness talks
  // to the API on its own compiled-in port, through `browser-bridge`.
  if (!isTauri()) {
    return Promise.reject(
      new Error('TermFlow API is not available: not running under the Tauri host.'),
    );
  }
  if (!pending) {
    const mine = generation;
    /** Has an invalidation happened since this resolution started? */
    const superseded = () => mine !== generation;
    pending = resolveApiPort(liveDeps, attempted ? 0 : RESOLVE_TIMEOUT_MS).then(
      (port) => {
        attempted = true;
        // A port learned before a rebind is a port we may no longer hold. Refusing sends the
        // caller back through a fresh resolution rather than at an address someone else owns.
        if (superseded()) {
          throw new Error('TermFlow API moved while this request was resolving; retry.');
        }
        if (port === null) {
          pending = null;
          throw new Error(
            'TermFlow API is not available: this instance has not bound a port. ' +
              'Check Settings > Connections.',
          );
        }
        return port;
      },
      (e) => {
        attempted = true;
        // Only clear the memo if it is still OURS: a superseded failure that cleared it
        // would discard a newer resolution's correct answer.
        if (!superseded()) pending = null;
        throw e;
      },
    );
  }
  return pending;
}

/** `http://localhost:<effective>/api`, for callers that build a path onto it. */
export async function apiBase(): Promise<string> {
  return `http://localhost:${await apiPort()}/api`;
}

/**
 * Drop the memo so the next call re-reads the backend.
 *
 * Required after anything that can move the listener — applying new ports, stopping or
 * starting the servers. Without it the window keeps addressing the port it resolved at
 * startup, which after a port change is exactly the port a sibling instance is free to take.
 */
export function invalidateApiBase(): void {
  pending = null;
  generation += 1;
}

/** Reset both the memo and the first-attempt flag. Tests only. */
export function __resetApiBaseForTests(): void {
  pending = null;
  attempted = false;
  generation = 0;
}
