/**
 * renderPolicyReconciler.test.ts
 *
 * design/013 (rev 2) §5 — the reconciler.
 *
 * Review 084's finding was that the LOD tiers were only strings: nothing mapped a
 * tier onto a renderer and nothing asserted the resulting resource counts. So every
 * budget assertion here is against a COUNT produced by a fake setter with a hard
 * context cap, never against a tier string.
 */

import {
  reconcileRenderPolicies,
  snapshotRenderPolicies,
  restoreRenderPolicies,
} from '../renderPolicyReconciler';
import {
  getTerminalRenderPolicy,
  setTerminalRenderPolicy,
  countActiveWebGLAddons,
  quarantineWebGLAddon,
  releaseFromWebGLQuarantine,
  getQuarantinedWebGLAddonCount,
  clearWebGLQuarantine,
  type RenderPolicy,
} from '../renderPolicy';
import {
  terminalCache,
  resetTerminalRendering,
  disableWebGLGlobally,
  enableWebGLGlobally,
} from '../cache';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';

/** A fake policy setter with a hard context cap, so budget behaviour is asserted
 *  against COUNTS rather than tier strings — review 084's point. */
function makeFake(
  opts: {
    cap?: number;
    failOn?: string[];
    preloaded?: string[];
    /** Ids NOT in the cache at all — production getPolicy returns null for these,
     *  and setTerminalRenderPolicy returns 'dom'. Without this the fake reports
     *  'dom' for every unknown id and cannot model the uncached case its own seam
     *  documents (review 122). */
    uncached?: string[];
  } = {},
) {
  const cap = opts.cap ?? Infinity;
  const live = new Set<string>(opts.preloaded ?? []);
  const calls: Array<[string, RenderPolicy]> = [];
  const setPolicy = (id: string, want: RenderPolicy): RenderPolicy => {
    calls.push([id, want]);
    if (want === 'dom') {
      live.delete(id);
      return 'dom';
    }
    if (opts.uncached?.includes(id)) return 'dom';   // no cache entry to promote
    if (opts.failOn?.includes(id)) return 'dom';
    if (live.size >= cap) return 'dom';
    live.add(id);
    return 'webgl';
  };
  return {
    setPolicy,
    count: () => live.size,
    // The reconciler must allocate against what is ALREADY live, so the fake has to
    // answer "what policy is this on right now?" from the same `live` set its setter
    // mutates. Without this the fake can only model the everything-starts-on-DOM
    // case, which is exactly the blind spot that hid the bug these tests cover.
    getPolicy: (id: string): RenderPolicy | null => {
      if (opts.uncached?.includes(id)) return null;
      return live.has(id) ? 'webgl' : 'dom';
    },
    calls,
    live,
  };
}

/** Same shape as renderPolicy.test.ts's helper: jsdom reports offsetWidth 0 for
 *  everything, so a real layout box has to be faked or the LB guard (§5.3) would
 *  skip every fit a promotion issues. The snapshot/restore tests below drive the
 *  REAL setTerminalRenderPolicy against the real cache, unlike the fake-setter
 *  reconciler tests above. */
function makeEntry(key: string) {
  const term = new Terminal();
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon as never);
  const host = document.createElement('div');
  document.body.appendChild(host);
  term.open(host);
  Object.defineProperty(term.element!, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(term.element!, 'offsetHeight', { value: 600, configurable: true });
  terminalCache.set(key, { terminal: term, fitAddon, webglAddon: null, useWebGL: false } as never);
  return { term, fitAddon, entry: terminalCache.get(key)! };
}

afterEach(() => {
  terminalCache.clear();
  // The quarantine is module state that deliberately outlives terminalCache.clear().
  clearWebGLQuarantine();
  document.body.innerHTML = '';
});

describe('design/013 §5 — the reconciler', () => {
  // Spec test 4 — the budget is enforced by COUNT, not by tier strings.
  it('promotes exactly `budget` terminals and reports dom for the rest', () => {
    const desired: Record<string, RenderPolicy> = {};
    for (let i = 0; i < 20; i++) desired[`t${i}`] = 'webgl';
    const fake = makeFake();
    const { applied, webglCount } = reconcileRenderPolicies({
      desired, budget: 12, order: Object.keys(desired), ...fake,
    });
    expect(webglCount).toBe(12);
    expect(Object.values(applied).filter((p) => p === 'webgl')).toHaveLength(12);
    expect(Object.values(applied).filter((p) => p === 'dom')).toHaveLength(8);
  });

  // Spec test 5 — a swap AT the boundary. Fails if the order is reversed.
  it('demotes before promoting, so a swap at the budget boundary succeeds', () => {
    const fake = makeFake({ cap: 1, preloaded: ['old'] });
    const { applied } = reconcileRenderPolicies({
      desired: { old: 'dom', new: 'webgl' }, budget: 1, order: ['new', 'old'], ...fake,
    });
    expect(applied.new).toBe('webgl');
    expect(applied.old).toBe('dom');
    expect(fake.calls[0]).toEqual(['old', 'dom']);   // demotion came FIRST
  });

  // Spec test 6.
  it('records dom for a failed promotion and completes the pass', () => {
    const fake = makeFake({ failOn: ['b'] });
    const { applied, webglCount } = reconcileRenderPolicies({
      desired: { a: 'webgl', b: 'webgl', c: 'webgl' }, budget: 10,
      order: ['a', 'b', 'c'], ...fake,
    });
    expect(applied).toEqual({ a: 'webgl', b: 'dom', c: 'webgl' });
    expect(webglCount).toBe(2);
  });

  // Spec test 9 — §5.1 "Count every live entry". A terminal absent from `desired`
  // still holds a context, so canvas promotions must be counted against it.
  it('counts an addon held by a terminal absent from desired', () => {
    const fake = makeFake({ preloaded: ['offscreen'] });
    const { applied, webglCount } = reconcileRenderPolicies({
      desired: { a: 'webgl', b: 'webgl' }, budget: 2, order: ['a', 'b'], ...fake,
    });
    expect(applied.a).toBe('webgl');
    expect(applied.b).toBe('dom');   // 'offscreen' already spent one of the two
    expect(webglCount).toBe(2);
  });

  it('promotes in the caller priority order — focused first', () => {
    const fake = makeFake();
    const { applied } = reconcileRenderPolicies({
      desired: { a: 'webgl', b: 'webgl', c: 'webgl' },
      budget: 1, order: ['c', 'a', 'b'], ...fake,
    });
    expect(applied.c).toBe('webgl');
    expect(applied.a).toBe('dom');
    expect(applied.b).toBe('dom');
  });

  it('never returns the request — always what was applied', () => {
    const fake = makeFake({ cap: 0 });
    const { applied } = reconcileRenderPolicies({
      desired: { a: 'webgl' }, budget: 5, order: ['a'], ...fake,
    });
    expect(applied.a).toBe('dom');
  });

  // §5 tie-break: ids absent from `order` are promoted AFTER every listed id, in
  // Object.keys(desired) order. Asserted directly, because it is the half of the
  // contract a caller that only lists the focused id relies on.
  it('promotes ids absent from `order` last, in desired key order', () => {
    const fake = makeFake();
    reconcileRenderPolicies({
      desired: { a: 'webgl', b: 'webgl', c: 'webgl' },
      budget: 3, order: ['c'], ...fake,
    });
    expect(fake.calls.map(([id]) => id)).toEqual(['c', 'a', 'b']);
  });

  // §5: `order` is PROMOTION priority. Ids listed in `order` but absent from
  // `desired` are ignored rather than touched.
  it('ignores ids in `order` that are absent from `desired`', () => {
    const fake = makeFake();
    reconcileRenderPolicies({
      desired: { a: 'webgl' }, budget: 3, order: ['ghost', 'a'], ...fake,
    });
    expect(fake.calls).toEqual([['a', 'webgl']]);
  });
});

describe('design/013 §5 / spec test 12 — `order` under a numeric id set', () => {
  // The trap: Object.keys puts integer-like keys FIRST, in ascending numeric
  // order, before insertion-ordered string keys. Every ordering test above uses
  // 'a'/'b'/'c', which are NON-integer-like and therefore come back in insertion
  // order — so none of them can catch an implementation that ignores `order` and
  // walks Object.keys(desired). This one can. Building `desired` with '20'
  // inserted FIRST proves the reconciler is not reading insertion order either.
  it('promotes the focused id first even when its key sorts numerically last', () => {
    const desired: Record<string, RenderPolicy> = {};
    desired['20'] = 'webgl';                       // the FOCUSED terminal
    for (let i = 1; i <= 19; i++) desired[String(i)] = 'webgl';

    // Sanity-pin the trap itself, so a future JS-engine or transpiler change that
    // altered key ordering would surface here rather than silently weakening the
    // test below into a tautology.
    expect(Object.keys(desired)[0]).toBe('1');
    expect(Object.keys(desired)[19]).toBe('20');

    const fake = makeFake();
    const { applied, webglCount } = reconcileRenderPolicies({
      desired,
      budget: 12,
      order: ['20', ...Array.from({ length: 19 }, (_, i) => String(i + 1))],
      ...fake,
    });

    // Under an Object.keys walk, '20' is the 20th promotion attempt and the
    // budget is spent by then, so this would report 'dom'.
    expect(applied['20']).toBe('webgl');
    expect(fake.calls[0]).toEqual(['20', 'webgl']);
    expect(webglCount).toBe(12);
    // ...and the 12-slot budget went to '20' plus '1'..'11', not '1'..'12'.
    expect(applied['11']).toBe('webgl');
    expect(applied['12']).toBe('dom');
  });

  // The same trap on the RETURN value: `applied` must be keyed by the ids given,
  // and a numeric-looking id must not be coerced anywhere on the path.
  it('keys `applied` by the exact id strings it was given', () => {
    const fake = makeFake();
    const { applied } = reconcileRenderPolicies({
      desired: { '007': 'webgl' }, budget: 1, order: ['007'], ...fake,
    });
    expect(applied).toEqual({ '007': 'webgl' });
    expect(fake.calls).toEqual([['007', 'webgl']]);
  });
});

describe('design/013 D6 — snapshot and restore', () => {
  // Spec test 7. Without this, leaving canvas mode leaves every terminal it
  // demoted permanently on the DOM renderer — a silent, cumulative degradation.
  it('reinstates the pre-canvas policy on exit', () => {
    makeEntry('snap-a');
    makeEntry('snap-b');
    setTerminalRenderPolicy('snap-a', 'webgl');           // a was on GPU before canvas
    const snap = snapshotRenderPolicies(['snap-a', 'snap-b']);

    setTerminalRenderPolicy('snap-a', 'dom');             // canvas demoted it
    setTerminalRenderPolicy('snap-b', 'webgl');           // and promoted b

    const restored = restoreRenderPolicies(snap);
    expect(restored['snap-a']).toBe('webgl');
    expect(restored['snap-b']).toBe('dom');
  });

  // Spec test 11 — the entry can be REPLACED without the policy having changed
  // (mount()'s rebuild carries webglAddon/useWebGL forward), so identity must key
  // on entry.terminal. A snapshot whose Terminal no longer matches is DISCARDED,
  // not applied — restoring blindly would address a dead entry or undo an explicit
  // user action ("Reset Rendering", a global toggle, a context loss).
  it('discards a snapshot whose Terminal object no longer matches', () => {
    makeEntry('stale');
    setTerminalRenderPolicy('stale', 'webgl');
    const snap = snapshotRenderPolicies(['stale']);

    terminalCache.delete('stale');
    makeEntry('stale');                                   // same id, NEW Terminal
    expect(getTerminalRenderPolicy('stale')).toBe('dom');

    const restored = restoreRenderPolicies(snap);
    expect(restored['stale']).toBeUndefined();            // not applied
    expect(getTerminalRenderPolicy('stale')).toBe('dom'); // left alone
  });

  it('survives an entry REBUILD that keeps the same Terminal', () => {
    const { term } = makeEntry('rebuild');
    setTerminalRenderPolicy('rebuild', 'webgl');
    const snap = snapshotRenderPolicies(['rebuild']);
    const old = terminalCache.get('rebuild')!;
    terminalCache.set('rebuild', { ...old, terminal: term });  // same Terminal
    setTerminalRenderPolicy('rebuild', 'dom');
    expect(restoreRenderPolicies(snap)['rebuild']).toBe('webgl');
  });

  it('skips ids that have left the cache entirely', () => {
    makeEntry('gone');
    const snap = snapshotRenderPolicies(['gone']);
    terminalCache.delete('gone');
    expect(restoreRenderPolicies(snap)).toEqual({});
  });
});

/**
 * P0-C review round 1 (report 120, codex) — HIGH.
 *
 * The reconciler checked `count() >= budget` inside the promotion loop WITHOUT first
 * resolving each terminal's current policy. That is correct only while every
 * candidate starts on DOM, which is the one state the original tests set up — they
 * either started with no live WebGL terminals, or made the preloaded one explicitly
 * desire DOM. Every case below starts with contexts ALREADY HELD, which is the
 * steady state Canvas Mode actually reconciles from on every pan and zoom.
 */
describe('reconcileRenderPolicies with slots already held (review 120 HIGH)', () => {
  it('reports webgl — and does not churn — for an already-WebGL winner at a full budget', () => {
    const fake = makeFake({ cap: 4, preloaded: ['a'] });

    const out = reconcileRenderPolicies({
      desired: { a: 'webgl' },
      budget: 1,
      order: ['a'],
      ...fake,
    });

    // Before the fix this reported 'dom' while `a` was still WebGL — `applied` lied
    // about the end state, so the caller's LOD bookkeeping drifted from reality.
    expect(out.applied.a).toBe('webgl');
    expect(fake.live.has('a')).toBe(true);
    expect(out.webglCount).toBe(1);
    // Idempotent: a steady state must not thrash the GPU context.
    expect(fake.calls).toEqual([]);
  });

  it('takes the last slot from a lower-priority holder and gives it to the focused terminal', () => {
    // `b` holds the only slot; `a` is higher priority and also wants WebGL.
    const fake = makeFake({ cap: 4, preloaded: ['b'] });

    const out = reconcileRenderPolicies({
      desired: { a: 'webgl', b: 'webgl' },
      budget: 1,
      order: ['a', 'b'],
      ...fake,
    });

    // Before the fix `a` was refused and `b` was never demoted, so the focused
    // terminal could never obtain a context — design/010 D8 requires the opposite.
    expect(out.applied.a).toBe('webgl');
    expect(out.applied.b).toBe('dom');
    expect(out.webglCount).toBe(1);
    // RULE 1: the loser is freed BEFORE the winner asks, or the swap fails at the
    // boundary because the context being freed is still held.
    expect(fake.calls).toEqual([['b', 'dom'], ['a', 'webgl']]);
  });

  it('enforces the budget on a desired set that STARTS over it', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const fake = makeFake({ cap: 20, preloaded: ids });
    const desired: Record<string, RenderPolicy> = {};
    ids.forEach(id => { desired[id] = 'webgl'; });

    const out = reconcileRenderPolicies({ desired, budget: 12, order: ids, ...fake });

    // Before the fix this made NO calls at all and returned webglCount 20: the
    // budget was simply not enforced once the set began over it.
    expect(out.webglCount).toBe(12);
    // Assert WHICH contexts remain live, not just how many (review 124 LOW). A
    // state/report divergence that kept the wrong 12 alive while reporting the
    // requested top 12 would satisfy a count-only assertion.
    expect([...fake.live].sort()).toEqual(ids.slice(0, 12).sort());
    // ...and the report agrees with that state.
    ids.slice(0, 12).forEach(id => expect(out.applied[id]).toBe('webgl'));
    ids.slice(12).forEach(id => expect(out.applied[id]).toBe('dom'));
  });

  it('does not reallocate contexts held by terminals absent from the request', () => {
    // `x` is live but not in `desired` — §5.1's count is GLOBAL, and `x` is not
    // ours to demote, so it must reduce the slots available rather than be freed.
    const fake = makeFake({ cap: 4, preloaded: ['x'] });

    const out = reconcileRenderPolicies({
      desired: { a: 'webgl', b: 'webgl' },
      budget: 2,
      order: ['a', 'b'],
      ...fake,
    });

    expect(fake.live.has('x')).toBe(true);
    expect(out.applied.a).toBe('webgl');
    expect(out.applied.b).toBe('dom');   // only one slot was actually free
    expect(out.webglCount).toBe(2);
  });
});

/**
 * P0-C review round 2 (report 122, codex) — HIGH + MEDIUM.
 *
 * The round-1 fix preselected a fixed `winners` set and gated promotion on it. That
 * strands a slot: RULE 3 says a failed promotion records 'dom' and the pass
 * CONTINUES, but a preselected set skips every non-winner forever, so the freed
 * capacity is never offered to the next candidate. The existing failed-promotion
 * test uses budget 10 for three candidates, so all three are winners and it cannot
 * reach the boundary.
 */
describe('reconcileRenderPolicies promotion cascade (review 122 HIGH)', () => {
  it('offers the slot to the next candidate when the top choice FAILS to promote', () => {
    // Both start on DOM, both want WebGL, one slot, and `a` (top priority) fails.
    const fake = makeFake({ cap: 4, failOn: ['a'] });

    const out = reconcileRenderPolicies({
      desired: { a: 'webgl', b: 'webgl' },
      budget: 1,
      order: ['a', 'b'],
      ...fake,
    });

    // Before the fix the pass ended at count 0: `b` was a non-winner and never
    // attempted, even though the budget was entirely free.
    expect(out.applied.a).toBe('dom');
    expect(out.applied.b).toBe('webgl');
    expect(out.webglCount).toBe(1);
  });

  it('offers the slot to the next candidate when the top choice is not in the cache', () => {
    // Production getPolicy returns null for an uncached id and the promotion
    // returns 'dom'; it must not reserve a slot it can never use.
    const fake = makeFake({ cap: 4, uncached: ['ghost'] });

    const out = reconcileRenderPolicies({
      desired: { ghost: 'webgl', b: 'webgl' },
      budget: 1,
      order: ['ghost', 'b'],
      ...fake,
    });

    expect(out.applied.ghost).toBe('dom');
    expect(out.applied.b).toBe('webgl');
    expect(out.webglCount).toBe(1);
  });
});

describe('reconcileRenderPolicies is call-idempotent (review 122 MEDIUM)', () => {
  it('emits no calls on a second identical pass over a MIXED set', () => {
    const fake = makeFake({ cap: 4, preloaded: ['old'] });
    const input = {
      desired: { old: 'dom' as RenderPolicy, focused: 'webgl' as RenderPolicy },
      budget: 1,
      order: ['focused', 'old'],
      ...fake,
    };

    const first = reconcileRenderPolicies(input);
    expect(first.applied).toEqual({ old: 'dom', focused: 'webgl' });
    expect(fake.calls).toEqual([['old', 'dom'], ['focused', 'webgl']]);

    fake.calls.length = 0;
    const second = reconcileRenderPolicies(input);

    // Before the fix the demote pass called setPolicy('old', 'dom') unconditionally,
    // so a steady state kept emitting calls forever.
    expect(second.applied).toEqual({ old: 'dom', focused: 'webgl' });
    expect(fake.calls).toEqual([]);
    expect(second.webglCount).toBe(1);
  });
});

/**
 * Review 124 MEDIUM. `order` is documented as highest-priority-first and is NOT
 * required to be duplicate-free, so a repeated id must not demote itself: building
 * the rank map with `new Map(order.map(...))` let the LAST occurrence win.
 */
describe('reconcileRenderPolicies with duplicate ids in `order` (review 124)', () => {
  it('ranks a duplicated id by its FIRST occurrence, so focus still wins', () => {
    const fake = makeFake({ cap: 4 });

    const out = reconcileRenderPolicies({
      desired: { focused: 'webgl', other: 'webgl' },
      budget: 1,
      order: ['focused', 'other', 'focused'],
      ...fake,
    });

    // Before the fix `focused` was ranked 2 and `other` 1, so `other` took the only
    // context — the exact inversion design/010 D8 forbids.
    expect(out.applied.focused).toBe('webgl');
    expect(out.applied.other).toBe('dom');
    expect(out.webglCount).toBe(1);
  });
});

/**
 * Review 124 MEDIUM — snapshot invalidation must survive a SAME-Terminal policy
 * change. Terminal identity is not enough: Reset Rendering, the global WebGL
 * toggle and a context loss all mutate the policy of the same Terminal object, so
 * they passed the identity check and canvas exit promoted the terminal straight
 * back to WebGL — undoing the explicit action or re-promoting onto a context the
 * GPU had just taken away.
 */
describe('restoreRenderPolicies vs same-Terminal invalidation (review 124)', () => {
  it('does NOT restore after Reset Rendering demoted the same Terminal', () => {
    const { entry } = makeEntry('snap-reset');
    // Canvas entry: the terminal is on WebGL and gets snapshotted.
    setTerminalRenderPolicy('snap-reset', 'webgl');
    expect(getTerminalRenderPolicy('snap-reset')).toBe('webgl');
    const snap = snapshotRenderPolicies(['snap-reset']);

    // While canvas is active the user invokes Reset Rendering. Same Terminal object.
    const before = entry.terminal;
    resetTerminalRendering('snap-reset');
    expect(getTerminalRenderPolicy('snap-reset')).toBe('dom');
    expect(terminalCache.get('snap-reset')!.terminal).toBe(before);

    const restored = restoreRenderPolicies(snap);

    // The reset must win. Before the fix this re-promoted to 'webgl'.
    expect(restored['snap-reset']).toBeUndefined();
    expect(getTerminalRenderPolicy('snap-reset')).toBe('dom');
  });

  it('does NOT restore after a context loss on the same Terminal', () => {
    makeEntry('snap-ctxloss');
    setTerminalRenderPolicy('snap-ctxloss', 'webgl');
    const snap = snapshotRenderPolicies(['snap-ctxloss']);

    // The GPU takes the context away; loadWebGLAddon's handler nulls the addon and
    // bumps the generation.
    const onLoss = (WebglAddon as unknown as { lastContextLossHandler: (() => void) | null })
      .lastContextLossHandler;
    expect(onLoss).toBeTruthy();
    onLoss!();
    expect(getTerminalRenderPolicy('snap-ctxloss')).toBe('dom');

    const restored = restoreRenderPolicies(snap);

    expect(restored['snap-ctxloss']).toBeUndefined();
    expect(getTerminalRenderPolicy('snap-ctxloss')).toBe('dom');
  });

  it('DOES restore when only canvas itself changed the policy', () => {
    makeEntry('snap-canvas-only');
    setTerminalRenderPolicy('snap-canvas-only', 'webgl');
    const snap = snapshotRenderPolicies(['snap-canvas-only']);

    // Canvas demotes it — its own reconciliation must NOT invalidate the snapshot.
    setTerminalRenderPolicy('snap-canvas-only', 'dom');

    const restored = restoreRenderPolicies(snap);

    expect(restored['snap-canvas-only']).toBe('webgl');
    expect(getTerminalRenderPolicy('snap-canvas-only')).toBe('webgl');
  });
});

/**
 * Review 126 MEDIUM — the same invalidation, on the sequence canvas actually
 * produces. The tests above call the invalidating operation while the terminal is
 * still on WebGL, so that operation performs the demotion itself and reaches the
 * generation bump. In a real canvas session canvas has ALREADY demoted the
 * terminal (its own demotion is deliberately non-bumping), so the user's Reset
 * Rendering and the global toggle both arrive at a DOM entry with nothing left to
 * dispose — and, while the bump lived inside the addon-present branch, changed no
 * generation at all. Canvas exit then restored WebGL over the top of them.
 */
describe('non-canvas invalidation after canvas already demoted (review 126)', () => {
  it('does NOT restore after canvas demoted and the user then reset rendering', () => {
    const { entry } = makeEntry('snap-canvas-then-reset');
    setTerminalRenderPolicy('snap-canvas-then-reset', 'webgl');
    const snap = snapshotRenderPolicies(['snap-canvas-then-reset']);

    // Canvas's own demotion — non-bumping by design (D6).
    setTerminalRenderPolicy('snap-canvas-then-reset', 'dom');
    expect(getTerminalRenderPolicy('snap-canvas-then-reset')).toBe('dom');

    // The user invokes Reset Rendering while canvas is still active. There is no
    // addon left to dispose, but this is still an explicit non-canvas decision.
    expect(resetTerminalRendering('snap-canvas-then-reset')).toBe(true);
    expect(terminalCache.get('snap-canvas-then-reset')!.terminal).toBe(entry.terminal);

    const restored = restoreRenderPolicies(snap);

    expect(restored['snap-canvas-then-reset']).toBeUndefined();
    expect(getTerminalRenderPolicy('snap-canvas-then-reset')).toBe('dom');
  });

  it('does NOT restore after canvas demoted and WebGL was globally toggled', () => {
    makeEntry('snap-canvas-then-global');
    setTerminalRenderPolicy('snap-canvas-then-global', 'webgl');
    const snap = snapshotRenderPolicies(['snap-canvas-then-global']);

    setTerminalRenderPolicy('snap-canvas-then-global', 'dom');   // canvas demotion

    // The user turns WebGL off and back on again while canvas is active. The
    // re-enable only affects NEW addons, so the terminal must stay on DOM — but
    // without the bump the snapshot survived and canvas exit re-promoted it.
    disableWebGLGlobally();
    enableWebGLGlobally();

    const restored = restoreRenderPolicies(snap);

    expect(restored['snap-canvas-then-global']).toBeUndefined();
    expect(getTerminalRenderPolicy('snap-canvas-then-global')).toBe('dom');
  });
});

/**
 * Review 126 LOW, RETRACTED at rev 10 (pre-review `138`).
 *
 * The old property here was: a quarantined addon whose driver recovers gets its slot
 * back on the next reconciliation, with no mount or create event. It was implemented
 * by draining the quarantine at the top of every pass and releasing any addon whose
 * `dispose()` did not throw.
 *
 * That release is unsound, and the test only passed because its fixture was a plain
 * object. Every real quarantined addon went through `term.loadAddon()`, and xterm's
 * AddonManager latches `isDisposed` BEFORE calling the real dispose — so after the
 * first throwing call, every retry returns silently having done nothing. "Recovery"
 * was indistinguishable from the latch, and the drain handed out a budget slot for a
 * context that was never freed.
 *
 * The honest property is the inverse: quarantine is TERMINAL. A wedged context keeps
 * its slot for the rest of the session, and is released only by its own
 * onContextLoss — the one signal that actually proves the GPU took it back. That
 * costs a slot in a degraded session, which is the safe direction; the old behaviour
 * over-allocated, which is not.
 */
describe('the quarantine is terminal (rev 10, retracting review 126 LOW)', () => {
  it('does NOT give the slot back, however many passes run (rev 10)', () => {
    makeEntry('q-recon');

    // A wedged addon. `wedged` is flipped below to model the ONLY way the old test
    // could ever have "recovered" — a fixture that is not a loaded addon.
    let wedged = true;
    let disposeCalls = 0;
    const stuck = {
      dispose() {
        disposeCalls += 1;
        if (wedged) throw new Error('test: dispose failed before releasing the context');
      },
    };
    quarantineWebGLAddon(stuck);
    expect(countActiveWebGLAddons()).toBe(1);

    // Budget 1, entirely consumed by the wedged context: nothing may be promoted.
    const input = { desired: { 'q-recon': 'webgl' as RenderPolicy }, budget: 1, order: ['q-recon'] };
    expect(reconcileRenderPolicies(input).applied['q-recon']).toBe('dom');
    expect(getQuarantinedWebGLAddonCount()).toBe(1);

    wedged = false;
    reconcileRenderPolicies(input);
    reconcileRenderPolicies(input);
    const out = reconcileRenderPolicies(input);

    // The slot is NOT returned, and — the load-bearing assertion — reconciliation
    // never even attempted a dispose. A drain that called dispose() and released on
    // "it did not throw" is exactly what handed out budget on no evidence.
    expect(disposeCalls).toBe(0);
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(out.applied['q-recon']).toBe('dom');
    expect(countActiveWebGLAddons()).toBe(1);

    // Context loss is the one thing that DOES return it: the GPU has taken the
    // context back, so counting it would overstate usage for the rest of the session.
    releaseFromWebGLQuarantine(stuck);
    expect(getQuarantinedWebGLAddonCount()).toBe(0);
    expect(reconcileRenderPolicies(input).applied['q-recon']).toBe('webgl');
  });
});

describe('the quarantine is inert across reconciliation (rev 10)', () => {
  /**
   * Review 129 LOW — the drain must sit on the SAME injection boundary as the rest
   * of the reconciler. `ReconcileInput` advertises `setPolicy`/`count`/`getPolicy`
   * as the complete set of seams and §5 calls the reconciler pure orchestration over
   * them; an unconditional `drainWebGLQuarantine()` was a fourth mutation of real
   * module state that a caller supplying all three seams could neither observe nor
   * prevent — it disposed a REAL quarantined addon during what was supposed to be an
   * isolated pass.
   */
  it('never touches the quarantine at all (rev 10)', () => {
    // Was: "drains through the injected seam". The seam existed because this function
    // called drainWebGLQuarantine() unconditionally, mutating real module state a
    // caller faking the other three seams could neither observe nor prevent.
    //
    // The DRAIN itself is now gone — retrying dispose() on an xterm-wrapped addon
    // returns silently whether or not the context was freed, so the retry could not
    // prove release and its release path handed out budget on no evidence. With no
    // drain there is nothing to inject, and the property to pin flips from "the fake
    // drain ran" to "the quarantine is inert across a reconciliation".
    let stuckDisposeCalls = 0;
    const stuck = {
      dispose() {
        stuckDisposeCalls += 1;
      },
    };
    quarantineWebGLAddon(stuck);
    expect(countActiveWebGLAddons()).toBe(1);

    const out = reconcileRenderPolicies({
      desired: { fake: 'webgl' as RenderPolicy },
      budget: 4,
      order: ['fake'],
      setPolicy: () => 'webgl' as RenderPolicy,
      count: () => 0,
      getPolicy: () => 'dom' as RenderPolicy,
    });

    // No dispose attempt, still held, still counted — across as many passes as you like.
    reconcileRenderPolicies({
      desired: { fake: 'dom' as RenderPolicy },
      budget: 4,
      order: ['fake'],
      setPolicy: () => 'dom' as RenderPolicy,
      count: () => 0,
      getPolicy: () => 'dom' as RenderPolicy,
    });
    expect(stuckDisposeCalls).toBe(0);
    expect(getQuarantinedWebGLAddonCount()).toBe(1);
    expect(countActiveWebGLAddons()).toBe(1);
    expect(out.applied['fake']).toBe('webgl');
  });
});

/**
 * rev 11 (pre-review `140`) — C1. The intersection nothing covered: a dispose that
 * THROWS while a canvas snapshot is live.
 *
 * Rev 10 made the failure path clear `webglAddon`, which is what
 * getTerminalRenderPolicy reads — so the policy moved webgl -> dom — but the
 * generation bump was still skipped on that path, on a rationale that had been true
 * only while the path retained the addon. restoreRenderPolicies then saw a matching
 * Terminal AND a matching generation, neither guard fired, and canvas exit silently
 * re-promoted: reversing an explicit user action and stacking a FRESH GPU context on
 * one whose release was never proven. One fault was enough to reach it.
 */
describe('a THROWING dispose still invalidates a live canvas snapshot (rev 11)', () => {
  it('Reset Rendering whose dispose throws is not undone by canvas exit', () => {
    const { entry } = makeEntry('c1-reset');
    expect(setTerminalRenderPolicy('c1-reset', 'webgl')).toBe('webgl');

    // Canvas snapshots the WebGL policy.
    const snap = snapshotRenderPolicies(['c1-reset']);

    // The user hits Reset Rendering while canvas is still up, and the dispose throws.
    asMockDispose(entry).dispose = () => { throw new Error('test: driver refused'); };
    expect(resetTerminalRendering('c1-reset')).toBe(false);
    expect(getTerminalRenderPolicy('c1-reset')).toBe('dom');   // the policy DID change

    // Canvas exits. The explicit user action must win.
    const restored = restoreRenderPolicies(snap);
    expect(restored['c1-reset']).toBeUndefined();
    expect(getTerminalRenderPolicy('c1-reset')).toBe('dom');
  });

  it('a global WebGL disable whose dispose throws is not undone by canvas exit', () => {
    const { entry } = makeEntry('c1-global');
    expect(setTerminalRenderPolicy('c1-global', 'webgl')).toBe('webgl');
    const snap = snapshotRenderPolicies(['c1-global']);

    asMockDispose(entry).dispose = () => { throw new Error('test: driver refused'); };
    disableWebGLGlobally();
    expect(getTerminalRenderPolicy('c1-global')).toBe('dom');

    const restored = restoreRenderPolicies(snap);
    expect(restored['c1-global']).toBeUndefined();
    expect(getTerminalRenderPolicy('c1-global')).toBe('dom');

    enableWebGLGlobally();
  });
});

/** The entry's addon, narrowed so a test can make its dispose throw. */
function asMockDispose(entry: { webglAddon: unknown }): { dispose: () => void } {
  return entry.webglAddon as { dispose: () => void };
}
