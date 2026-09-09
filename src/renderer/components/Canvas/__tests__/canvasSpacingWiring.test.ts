import path from 'path';
import { readSource } from '../../../utils/readSource';

const MODE = readSource(path.resolve(__dirname, '../CanvasMode.tsx'));
const SIDEBAR = readSource(path.resolve(__dirname, '../CanvasSidebar.tsx'));
const DRAG = readSource(path.resolve(__dirname, '../useCanvasDrag.ts'));
const SLICE = readSource(path.resolve(__dirname, '../../../store/slices/canvasSlice.ts'));

describe('Dynamic Spacing consumers (plan/039)', () => {
  it('feeds the spacing-adjusted rects to tiers, culling and wire geometry, not the raw model', () => {
    expect(MODE).toContain('for (const n of spacedNodes) rects[n.terminalId] = n.rect;');
    expect(MODE).toContain('visibleNodeIds(spacedNodes, vp, size.w, size.h)');
    expect(MODE).toContain('for (const n of spacedNodes) {');
    expect(MODE).toContain('beaconLayout(spacedPaintedNodes, vp, size.w, size.h)');
    expect(MODE).toContain('chipOffsets(spacedShownGroups, vp.z)');
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
    expect(MODE).toContain("targetRectAt(z, 'node', terminalId, n.rect, postUnhideSpacingModel)");
    expect(MODE).toContain("targetRectAt(vp.z, 'node', next, n.rect)");
    // The helper must resolve spacing at the zoom it is handed, not at the current one.
    expect(MODE).toContain('const s = applySpacing(targetModel, destZ, true);');
    expect(MODE).toContain("targetRectAt(vp.z, 'node', plan.leafId, plan.rect, postSpawnSpacingModel)");
  });

  it('keeps raw geometry for choosing fit zoom and minimap hit testing, then targets display space', () => {
    // Global fit remains raw because its bounds contain every inward-spaced rect. A single-group
    // fit chooses zoom from raw dimensions too, but centres on its display-space location.
    expect(MODE).toContain('boundsOf(shownGroups.map((g) => g.rect))');
    expect(MODE).toContain("targetRectAt(fitted.z, 'group', g.tabId, g.rect)");
    expect(MODE).toContain("targetRectAt(vp.z, 'group', g.tabId, g.rect)");
    expect(MODE).toContain('w.x >= x.rect.x && w.x <= x.rect.x + x.rect.w');
    expect(MODE).toContain('const target = g ? targetRectAt');
  });

  it('keeps the "frame everything" camera targets off the transform they would otherwise feed back into', () => {
    expect(MODE).toContain('boundsOf(shownGroups.map((g) => g.rect))');
  });

  it('leaves the minimap on the raw model — a fixed-scale overview, not a zoomed spatial view', () => {
    const minimap = /<CanvasMinimap[\s\S]*?\/>/.exec(MODE)?.[0] ?? '';
    expect(minimap).toContain('shownGroups={shownGroups}');
    expect(minimap).not.toContain('spacedShownGroups');
  });

  it('uses raw geometry only for a real slop-crossed drag and compensates both transitions', () => {
    expect(MODE).toContain('drag.dragActive ? applySpacing(spacingModel, vp.z, false) : liveSpacing');
    expect(MODE).toContain("spacingTransitionPan(offset, source.z, 'toRaw')");
    expect(MODE).toContain("spacingTransitionPan(offset, vp.z, 'toDisplay')");
    expect(MODE).not.toContain('applyFrozenOffsets');
    expect(MODE).not.toContain('beginDragFreeze');
    expect(DRAG).toContain("onDragStart?.({ kind: 'node', id: nd.terminalId });");
    expect(DRAG).toContain("onDragStart?.({ kind: 'group', id: gd.tabId });");
    expect(DRAG).toContain('if (!nd.moved && Math.hypot');
    expect(DRAG).toContain('if (!gd.moved && Math.hypot');
    // Hit-test stays RAW while the real-drag render branch is also RAW.
    expect(DRAG).toContain('m.groups.map((g) => ({ tabId: g.tabId, rect: g.rect }))');
    expect(DRAG).not.toContain('applySpacing(');
  });

  it('keeps the whole real drag raw even if wheel zoom changes mid-gesture', () => {
    // `dragActive` gates the identity result itself; no frozen offset can survive at z=1.
    expect(MODE).toContain('drag.dragActive ? applySpacing(spacingModel, vp.z, false) : liveSpacing');
    expect(MODE).not.toContain('frozenOffsets');
  });

  it('gives the sidebar no second camera implementation', () => {
    expect(MODE).toContain('onFlyToNode={flyToNode}');
    expect(SIDEBAR).toContain('onFlyToNode: (terminalId: string) => void;');
    expect(SIDEBAR).toContain('onFlyToNode(r.terminalId)');
    expect(SIDEBAR).not.toContain('const flyToNode = useCallback');
    expect(SIDEBAR).not.toContain('centreOn(');
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
