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
  type RenderPolicy,
} from '../renderPolicy';
import { terminalCache } from '../cache';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

/** A fake policy setter with a hard context cap, so budget behaviour is asserted
 *  against COUNTS rather than tier strings — review 084's point. */
function makeFake(opts: { cap?: number; failOn?: string[]; preloaded?: string[] } = {}) {
  const cap = opts.cap ?? Infinity;
  const live = new Set<string>(opts.preloaded ?? []);
  const calls: Array<[string, RenderPolicy]> = [];
  const setPolicy = (id: string, want: RenderPolicy): RenderPolicy => {
    calls.push([id, want]);
    if (want === 'dom') {
      live.delete(id);
      return 'dom';
    }
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
    getPolicy: (id: string): RenderPolicy | null => (live.has(id) ? 'webgl' : 'dom'),
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
    expect(fake.live.size).toBe(12);
    // The 12 kept are the highest-priority 12, and the rest are reported honestly.
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
