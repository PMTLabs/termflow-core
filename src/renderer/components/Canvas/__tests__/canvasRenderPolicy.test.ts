import {
  desiredPolicies, promotionOrder, nextSuppressed, policySignature,
} from '../canvasRenderPolicy';
import {
  assignTiers, priorityOrder, LodTier, Rect, Viewport, NODE_W, NODE_H, MAX_GPU,
} from '../canvasGeometry';

const tiers = (m: Record<string, LodTier>) => m;

describe('desiredPolicies', () => {
  it('asks for webgl only at the gpu tier', () => {
    const d = desiredPolicies(
      tiers({ a: 'gpu', b: 'live', c: 'snapshot', d: 'chip', e: 'group' }),
      new Set(),
    );
    expect(d).toEqual({ a: 'webgl', b: 'dom', c: 'dom', d: 'dom', e: 'dom' });
  });

  it('gives every id a policy, so the reconciler sees the whole workspace', () => {
    const t = tiers({ a: 'gpu', b: 'group' });
    expect(Object.keys(desiredPolicies(t, new Set())).sort()).toEqual(['a', 'b']);
  });

  // Downgrading here rather than after the fact is the point: a suppressed id must not
  // be allocated a winner slot at all, or it displaces an incumbent every pass and the
  // slot it wins is never usable.
  it('downgrades a suppressed id before the reconciler can allocate to it', () => {
    const d = desiredPolicies(tiers({ a: 'gpu', b: 'gpu' }), new Set(['a']));
    expect(d.a).toBe('dom');
    expect(d.b).toBe('webgl');
  });
});

describe('promotionOrder', () => {
  it('puts the focused id first, then recent, then declaration order', () => {
    expect(promotionOrder(['a', 'b', 'c', 'd'], 'c', ['d', 'b'])).toEqual(['c', 'd', 'b', 'a']);
  });

  it('drops ids that are no longer on the canvas', () => {
    expect(promotionOrder(['a', 'b'], 'gone', ['also-gone', 'b'])).toEqual(['b', 'a']);
  });

  it('never repeats an id, even when focus and recent overlap', () => {
    const out = promotionOrder(['a', 'b'], 'a', ['a', 'b', 'a']);
    expect(out).toEqual(['a', 'b']);
  });

  // The reconciler's `order` and assignTiers' budget MUST rank identically, or a node can
  // be assigned the gpu tier and then promoted last, outside the budget — breaking D8's
  // unconditional focused promotion. They share one function; this asserts they still do.
  it('is the same ranking assignTiers spends its gpu budget by', () => {
    const ids = ['a', 'b', 'c'];
    expect(promotionOrder(ids, 'c', ['b'])).toEqual(priorityOrder(ids, 'c', ['b']));
  });

  // The end-to-end version of the clause above, through both real functions: whatever
  // assignTiers calls `gpu` must be inside the first MAX_GPU entries of the order the
  // reconciler promotes by. Integer-like ids are used deliberately — `Object.keys` sorts
  // those numerically first, which is the exact failure `order` exists to prevent.
  it('keeps every gpu-tier node inside the budget the reconciler promotes under', () => {
    const ids: string[] = [];
    const rects: Record<string, Rect> = {};
    for (let i = 0; i < 30; i++) {
      const id = `${100 + i}`; // integer-like on purpose
      ids.push(id);
      rects[id] = { x: (i % 6) * 20, y: Math.floor(i / 6) * 20, w: NODE_W, h: NODE_H };
    }
    const vp: Viewport = { x: 0, y: 0, z: 1 };
    const focusedId = ids[29];
    const assigned = assignTiers({ ids, rects, vp, vw: 4000, vh: 4000, focusedId, recent: [] });
    const order = promotionOrder(ids, focusedId, []);

    const gpuIds = ids.filter((i) => assigned[i] === 'gpu');
    expect(gpuIds).toHaveLength(MAX_GPU);
    expect(order[0]).toBe(focusedId);
    const budgetWindow = new Set(order.slice(0, MAX_GPU));
    for (const id of gpuIds) expect(budgetWindow.has(id)).toBe(true);
  });
});

describe('policySignature', () => {
  // The reason this exists: a pan produces a fresh tier object per pointer-move, and
  // almost all of them want identical policies. Without an equality that survives the
  // new object identity, the reconciler runs at frame rate and flips real GPU contexts.
  it('is equal for maps that differ only in object identity or key order', () => {
    expect(policySignature({ a: 'webgl', b: 'dom' }))
      .toBe(policySignature({ b: 'dom', a: 'webgl' }));
  });

  it('differs when the set of webgl ids changes', () => {
    expect(policySignature({ a: 'webgl', b: 'dom' }))
      .not.toBe(policySignature({ a: 'dom', b: 'webgl' }));
    expect(policySignature({ a: 'webgl' }))
      .not.toBe(policySignature({ a: 'webgl', b: 'webgl' }));
  });

  // A tier map is total over the workspace, so a node leaving the canvas changes the
  // 'dom' set without changing the 'webgl' set. Reconciling for that would be pointless
  // work — but pin it, because it is a deliberate blind spot rather than an oversight.
  it('ignores changes confined to the dom ids', () => {
    expect(policySignature({ a: 'webgl', b: 'dom' }))
      .toBe(policySignature({ a: 'webgl', c: 'dom', d: 'dom' }));
  });

  it('is empty when nothing wants a context', () => {
    expect(policySignature({ a: 'dom', b: 'dom' })).toBe('');
    expect(policySignature({})).toBe('');
  });

  // Ids are compared as a set, so the signature must not depend on how they sort into
  // the map — `Object.keys` puts integer-like keys first, in numeric order.
  it('is stable for integer-like ids', () => {
    expect(policySignature({ '10': 'webgl', '9': 'webgl' }))
      .toBe(policySignature({ '9': 'webgl', '10': 'webgl' }));
  });
});

describe('nextSuppressed', () => {
  it('adds this pass\'s failed promotions', () => {
    const out = nextSuppressed(new Set(), ['a'], ['a', 'b']);
    expect([...out]).toEqual(['a']);
  });

  it('keeps earlier failures suppressed', () => {
    const out = nextSuppressed(new Set(['a']), ['b'], ['a', 'b']);
    expect([...out].sort()).toEqual(['a', 'b']);
  });

  // A closed terminal that never re-arms would suppress its id forever, and ids are
  // reused across sessions.
  it('forgets ids that have left the canvas', () => {
    const out = nextSuppressed(new Set(['a', 'b']), [], ['b']);
    expect([...out]).toEqual(['b']);
  });

  it('ignores a failure for an id that is not present', () => {
    expect([...nextSuppressed(new Set(), ['ghost'], ['a'])]).toEqual([]);
  });

  it('re-arms an id on an explicit signal', () => {
    expect([...nextSuppressed(new Set(['a']), [], ['a'], ['a'])]).toEqual([]);
  });

  it('lets a re-arm win over a failure reported in the same pass', () => {
    expect([...nextSuppressed(new Set(), ['a'], ['a'], ['a'])]).toEqual([]);
  });

  // The caller reconciles when this value changes. A fresh Set on every pass would make
  // every pass look like a change and reconcile forever.
  it('returns the SAME instance when nothing changed', () => {
    const prev = new Set(['a']);
    expect(nextSuppressed(prev, [], ['a'])).toBe(prev);
    expect(nextSuppressed(prev, ['a'], ['a'])).toBe(prev);
  });

  it('returns a NEW instance when something did change', () => {
    const prev = new Set(['a']);
    expect(nextSuppressed(prev, ['b'], ['a', 'b'])).not.toBe(prev);
    expect(nextSuppressed(prev, [], [])).not.toBe(prev);
  });

  // Equal size but different members is the case a size-only comparison misses — a
  // simultaneous departure and failure swaps one id for another without changing the count.
  it('does not mistake a swap for no change', () => {
    const prev = new Set(['a']);
    const out = nextSuppressed(prev, ['b'], ['b']);
    expect(out).not.toBe(prev);
    expect([...out]).toEqual(['b']);
  });
});
