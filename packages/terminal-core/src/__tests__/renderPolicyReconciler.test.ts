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

import { reconcileRenderPolicies } from '../renderPolicyReconciler';
import type { RenderPolicy } from '../renderPolicy';

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
  return { setPolicy, count: () => live.size, calls, live };
}

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
