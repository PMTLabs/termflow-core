import path from 'path';
import { readSource } from '../../../utils/readSource';

const MODE = readSource(path.resolve(__dirname, '../CanvasMode.tsx'));
const SLICE = readSource(path.resolve(__dirname, '../../../store/slices/canvasSlice.ts'));

describe('Dynamic Spacing consumers (plan/039)', () => {
  it('feeds the spacing-adjusted rects to tiers, culling and wire geometry, not the raw model', () => {
    expect(MODE).toContain('for (const n of spacedNodes) rects[n.terminalId] = n.rect;');
    expect(MODE).toContain('visibleNodeIds(spacedNodes, vp, size.w, size.h)');
    expect(MODE).toContain('for (const n of spacedNodes) {');
  });

  it('renders every node and group at its spacing-adjusted rect, except the overlaid node', () => {
    expect(MODE).toContain("const node = isOverlaid ? { ...n, rect: overlay!.rect } : { ...n, rect: spacing.nodeRects[n.terminalId] ?? n.rect };");
    expect(MODE).toContain('group={{ ...g, rect: spacing.groupRects[g.tabId] ?? g.rect }}');
  });

  it('keeps drag origins and spawn placement on the RAW model, never the spaced one', () => {
    // A drag must write real geometry, never a compacted position.
    expect(MODE).toContain('drag.onNodeHeaderPointerDown(n.terminalId, n.tabId, n.rect)');
    // Spawn placement avoids overlapping the terminals' true stored positions.
    expect(MODE).toContain('spawnRectNear(source.rect, model.nodes.map((n) => n.rect),');
  });

  it('aims every id-addressed camera destination at where the target will be DRAWN, at the destination zoom', () => {
    // Centring on the stored rect points the camera at empty canvas: the node is rendered at its
    // tightened position, which on a sparse layout is more than a screen width away. Spacing is a
    // function of zoom alone and never of viewport translation, so evaluating it at the
    // DESTINATION zoom is well-defined and cannot feed back into itself.
    expect(MODE).toContain("targetRectAt(GROUP_CHIP_ZOOM, 'group', g.tabId, g.rect)");
    expect(MODE).toContain("targetRectAt(NODE_CHIP_ZOOM, 'node', n.terminalId, n.rect)");
    expect(MODE).toContain("targetRectAt(z, 'node', terminalId, n.rect)");
    expect(MODE).toContain("targetRectAt(vp.z, 'node', next, n.rect)");
    // The helper must resolve spacing at the zoom it is handed, not at the current one.
    expect(MODE).toContain('const s = applySpacing(spacingModel, destZ, true);');
  });

  it('frames RAW bounds for fit, and RAW world points for the minimap, on purpose', () => {
    // Spacing only ever moves rects CLOSER, so raw bounds always contain the tightened layout —
    // a fit computed on them cannot cut off anything it promised to show. The minimap draws the
    // raw layout for the same reason it is not zoom-reactive, so a click on it and the map it
    // was aimed at agree with each other.
    expect(MODE).toContain('boundsOf(shownGroups.map((g) => g.rect))');
    expect(MODE).toContain('flyTo(centreOn({ x: w.x, y: w.y, w: 0, h: 0 }, size.w, size.h, vp.z, metrics.zMax));');
  });

  it('keeps the "frame everything" camera targets off the transform they would otherwise feed back into', () => {
    expect(MODE).toContain('boundsOf(shownGroups.map((g) => g.rect))');
  });

  it('leaves the minimap on the raw model — a fixed-scale overview, not a zoomed spatial view', () => {
    const minimap = /<CanvasMinimap[\s\S]*?\/>/.exec(MODE)?.[0] ?? '';
    expect(minimap).toContain('shownGroups={shownGroups}');
    expect(minimap).not.toContain('spacedShownGroups');
  });

  it('FREEZES the spacing offset for a drag press rather than switching spacing off', () => {
    // Switching it off does not freeze the transform, it removes it: the grabbed node jumps from
    // its tightened position to its stored one the instant it is touched (~90 screen px on an
    // ordinary four-tab canvas) and keeps that offset from the pointer for the whole gesture.
    // Holding the offset constant lets the node track the pointer exactly instead.
    expect(MODE).toContain('beginDragFreeze()');
    expect(MODE).toContain('setFrozenOffsets(spacingOffsets(m, s))');
    expect(MODE).toContain('frozenOffsets ? applyFrozenOffsets(spacingModel, frozenOffsets) : liveSpacing');
    // The press must never be allowed to disable spacing outright again.
    expect(MODE).not.toContain('dynamicSpacing && !dragActive');
  });

  it('feeds spacing the SHOWN nodes, so a hidden member cannot pull its siblings', () => {
    // A frame is shrink-wrapped around its shown members only, so tightening toward a hidden one
    // moves the visible terminal toward a rect its own frame does not contain.
    expect(MODE).toContain('const spacingModel = useMemo(');
    expect(MODE).toContain('({ nodes: paintedNodes, groups: shownGroups })');
    expect(MODE).toContain('applySpacing(spacingModel, vp.z, dynamicSpacing)');
  });

  it('never gives canvasSlice a spacing-adjusted rect to store', () => {
    // Dynamic Spacing is a render-time transform, never a second source of truth for a node or
    // group's position (plan/039 §2) — the reducers that actually write geometry must not
    // import the module that computes it. (A doc-comment naming it, as `dynamicSpacing`'s own
    // field comment does, is fine — this checks for an actual dependency.)
    expect(SLICE).not.toContain("from './canvasSpacing'");
    expect(SLICE).not.toContain('canvasSpacing.applySpacing(');
    expect(SLICE).not.toContain('applySpacing(state');
  });
});
