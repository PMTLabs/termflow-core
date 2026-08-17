/**
 * Wiring a terminal that does not exist yet.
 *
 * Tam: a port click "needs to auto setup connection to the new terminal". It already asked
 * for one — `POST /api/canvas/edges` resolves both endpoints through
 * `AppState::resolve_renderer_id` and answers 404 for a terminal it has never registered, and
 * a terminal created from the canvas is exactly that until its tab has rendered, mounted a
 * pane, invoked the backend and had the spawn resolve.
 *
 * The failure was silent: `createEdge` catches and returns `null`, which is the correct
 * reading for a duplicate pair or a self-edge and the wrong one here.
 */
import { connectWhenReady, CONNECT_POLL_MS } from '../canvasConnect';
import type { CanvasEdge } from '../../../store/slices/canvasSlice';

const EDGE = { id: 'ed-1', from: 'tm-a', to: 'tb-new', label: null, origin: 'user' } as CanvasEdge;

/** A fake clock: `wait` advances it rather than sleeping, so a 10-second timeout is instant
 *  and the number of polls is observable instead of being a matter of timing luck. */
function harness(opts: { readyAfterMs?: number; edge?: CanvasEdge | null } = {}) {
  const readyAfter = opts.readyAfterMs ?? 0;
  let t = 1_000_000;                        // not zero, so a `now()` that returned 0 would show
  const calls: Array<[string, string]> = [];
  const waits: number[] = [];
  return {
    calls,
    waits,
    elapsed: () => t - 1_000_000,
    deps: {
      isReady: () => t - 1_000_000 >= readyAfter,
      createEdge: async (from: string, to: string) => {
        calls.push([from, to]);
        return opts.edge === undefined ? EDGE : opts.edge;
      },
      wait: async (ms: number) => { waits.push(ms); t += ms; },
      now: () => t,
    },
  };
}

describe('waiting for the terminal to exist', () => {
  it('connects immediately when it is already registered', async () => {
    const h = harness({ readyAfterMs: 0 });
    await expect(connectWhenReady(h.deps, 'tm-a', 'tb-new')).resolves.toEqual(EDGE);
    expect(h.calls).toEqual([['tm-a', 'tb-new']]);
    expect(h.waits).toEqual([]);            // no delay for the case that does not need one
  });

  /** The whole bug: the edge used to be posted here, at t=0, against a terminal that appears
   *  half a second later. */
  it('waits for a terminal that takes time to spawn, then connects', async () => {
    const h = harness({ readyAfterMs: 500 });
    await expect(connectWhenReady(h.deps, 'tm-a', 'tb-new')).resolves.toEqual(EDGE);
    expect(h.calls).toEqual([['tm-a', 'tb-new']]);
    expect(h.elapsed()).toBe(500);
    expect(h.waits.every((w) => w === CONNECT_POLL_MS)).toBe(true);
  });

  it('polls rather than spinning', async () => {
    const h = harness({ readyAfterMs: 1000 });
    await connectWhenReady(h.deps, 'tm-a', 'tb-new');
    // 1000ms of waiting at 100ms a poll. A spin loop would show zero waits and burn a core.
    expect(h.waits).toHaveLength(1000 / CONNECT_POLL_MS);
  });

  it('posts exactly one edge, however long it waited', async () => {
    const h = harness({ readyAfterMs: 3000 });
    await connectWhenReady(h.deps, 'tm-a', 'tb-new');
    expect(h.calls).toHaveLength(1);
  });
});

describe('when the terminal never appears', () => {
  /**
   * Bounded, because the alternative pins a promise to a terminal the user may already have
   * closed. `Infinity` here would pass every test above.
   */
  it('gives up rather than waiting forever', async () => {
    const h = harness({ readyAfterMs: Number.MAX_SAFE_INTEGER });
    await connectWhenReady(h.deps, 'tm-a', 'tb-new', 2000);
    expect(h.elapsed()).toBeGreaterThanOrEqual(2000);
    expect(h.elapsed()).toBeLessThan(2000 + CONNECT_POLL_MS * 2);
  });

  /**
   * …and still tries once. The terminal may have registered inside the last interval, and a
   * timeout that returns without attempting is a guaranteed loss where a late attempt is a
   * likely win. A `return null` on timeout would pass the elapsed-time check above.
   */
  it('makes a last attempt anyway', async () => {
    const h = harness({ readyAfterMs: Number.MAX_SAFE_INTEGER });
    await connectWhenReady(h.deps, 'tm-a', 'tb-new', 2000);
    expect(h.calls).toEqual([['tm-a', 'tb-new']]);
  });

  it('reports the server refusing, rather than inventing an edge', async () => {
    const h = harness({ readyAfterMs: 0, edge: null });
    await expect(connectWhenReady(h.deps, 'tm-a', 'tb-new')).resolves.toBeNull();
  });
});

describe('the ids it connects', () => {
  it('draws from the source to the new terminal, in that order', async () => {
    // Direction is the gesture — the port you grabbed is the `from`. Reversed, the wire is
    // drawn and points the wrong way, which no test of "an edge exists" would notice.
    const h = harness();
    await connectWhenReady(h.deps, 'tm-parent', 'tb-child');
    expect(h.calls[0]).toEqual(['tm-parent', 'tb-child']);
  });

  it('waits on the DESTINATION, not the source', async () => {
    // The source has existed all along; it is the new terminal that is missing. A readiness
    // check on the wrong id returns true immediately and reintroduces the bug in full.
    const asked: string[] = [];
    const deps = {
      isReady: (id: string) => { asked.push(id); return true; },
      createEdge: async () => EDGE,
      wait: async () => { },
      now: () => 0,
    };
    await connectWhenReady(deps, 'tm-parent', 'tb-child');
    expect(asked).toEqual(['tb-child']);
  });
});
