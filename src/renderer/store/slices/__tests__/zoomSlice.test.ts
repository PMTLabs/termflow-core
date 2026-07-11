import zoomReducer, {
  setZoom,
  nudgeZoom,
  resetZoom,
  clearZoom,
  clampZoom,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_DEFAULT,
} from '../zoomSlice';

describe('zoomSlice', () => {
  it('starts with no surface levels (missing key === 100%)', () => {
    const state = zoomReducer(undefined, { type: '@@INIT' } as any);
    expect(state.levels).toEqual({});
  });

  it('setZoom records a normalized level for a surface', () => {
    const state = zoomReducer(undefined, setZoom({ key: 'settings', level: 1.234 }));
    expect(state.levels.settings).toBe(1.23); // rounded to 2dp
  });

  it('clamps levels to [ZOOM_MIN, ZOOM_MAX]', () => {
    expect(zoomReducer(undefined, setZoom({ key: 's', level: 99 })).levels.s).toBe(ZOOM_MAX);
    expect(zoomReducer(undefined, setZoom({ key: 's', level: 0.01 })).levels.s).toBe(ZOOM_MIN);
  });

  it('nudgeZoom in/out steps ~10% from the current level (default when absent)', () => {
    const inOnce = zoomReducer(undefined, nudgeZoom({ key: 'tm-1', direction: 'in' }));
    expect(inOnce.levels['tm-1']).toBe(1.1);

    const outFromThere = zoomReducer(inOnce, nudgeZoom({ key: 'tm-1', direction: 'out' }));
    expect(outFromThere.levels['tm-1']).toBe(1); // 1.1 / 1.1, normalized
  });

  it('nudge does not exceed the clamp bounds', () => {
    let state = zoomReducer(undefined, setZoom({ key: 'a', level: ZOOM_MAX }));
    state = zoomReducer(state, nudgeZoom({ key: 'a', direction: 'in' }));
    expect(state.levels.a).toBe(ZOOM_MAX);
  });

  it('resetZoom returns a surface to 100% but keeps the key', () => {
    let state = zoomReducer(undefined, setZoom({ key: 'tm-1', level: 2 }));
    state = zoomReducer(state, resetZoom('tm-1'));
    expect(state.levels['tm-1']).toBe(ZOOM_DEFAULT);
  });

  it('clearZoom forgets a surface entirely', () => {
    let state = zoomReducer(undefined, setZoom({ key: 'tm-1', level: 2 }));
    state = zoomReducer(state, clearZoom('tm-1'));
    expect(state.levels['tm-1']).toBeUndefined();
  });

  it('clampZoom helper is exported and bounded', () => {
    expect(clampZoom(10)).toBe(ZOOM_MAX);
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(1)).toBe(1);
  });
});
