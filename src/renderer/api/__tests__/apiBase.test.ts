import { resolveApiPort, RESOLVE_POLL_MS, ResolveDeps } from '../apiBase';

/**
 * The rule under test is a NEGATIVE one: the renderer must never address the configured
 * port. That is invisible to any assertion about a happy path — a resolver that returned
 * the configured port would pass "it produced a number" — so every case here pins either
 * the SOURCE of the number or the refusal to produce one.
 */

/** A clock and a `wait` that advance the same virtual time, so nothing sleeps. */
function fakeTime() {
  let t = 0;
  return {
    now: () => t,
    wait: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function deps(
  ports: Array<number | null | 'throw'>,
  time = fakeTime(),
): ResolveDeps & { calls: () => number } {
  let i = 0;
  return {
    now: time.now,
    wait: time.wait,
    effectivePort: async () => {
      const next = ports[Math.min(i, ports.length - 1)];
      i += 1;
      if (next === 'throw') throw new Error('command unavailable');
      return next;
    },
    calls: () => i,
  };
}

describe('resolveApiPort', () => {
  it('returns the port the backend reports', async () => {
    await expect(resolveApiPort(deps([42035]), 1000)).resolves.toBe(42035);
  });

  it('polls past the boot race instead of giving up on the first null', async () => {
    // The listener is bound from a task spawned in setup(), so the first few probes
    // legitimately answer null. Giving up there is what would send the window to the
    // configured port for the rest of the session.
    const d = deps([null, null, 42033]);
    await expect(resolveApiPort(d, 1000)).resolves.toBe(42033);
    expect(d.calls()).toBe(3);
  });

  it('treats a throwing probe as "not yet", not as a failure', async () => {
    const d = deps(['throw', 'throw', 42037]);
    await expect(resolveApiPort(d, 1000)).resolves.toBe(42037);
  });

  it('gives up with null rather than falling back to a port', async () => {
    // The whole point: no port at all is a usable answer (callers throw), a WRONG port
    // is not — it is another instance's API answering with another instance's terminals.
    await expect(resolveApiPort(deps([null]), 3 * RESOLVE_POLL_MS)).resolves.toBeNull();
  });

  it('probes exactly once when the timeout is zero', async () => {
    // Re-resolution after a port change must not stall a polling caller for the full
    // boot-race window; by then a null means "there is no server", not "not yet".
    const d = deps([null]);
    await expect(resolveApiPort(d, 0)).resolves.toBeNull();
    expect(d.calls()).toBe(1);
  });

  it('still answers when the port arrives on the very last allowed probe', async () => {
    const time = fakeTime();
    const d = deps([null, 42039], time);
    // Deadline lands exactly on the second probe's turn.
    await expect(resolveApiPort(d, RESOLVE_POLL_MS)).resolves.toBe(42039);
  });

  it('rejects a non-positive port instead of building http://localhost:0', async () => {
    const d = deps([0, 42041]);
    await expect(resolveApiPort(d, 1000)).resolves.toBe(42041);
  });
});
