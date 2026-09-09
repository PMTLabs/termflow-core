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

  it('keeps drag origins, spawn placement and the group chip camera on the RAW model, never the spaced one', () => {
    // A drag must write real geometry, never a compacted position — see `dragActive`'s own note.
    expect(MODE).toContain('drag.onNodeHeaderPointerDown(n.terminalId, n.tabId, n.rect)');
    // Spawn placement avoids overlapping the terminals' true stored positions.
    expect(MODE).toContain('spawnRectNear(source.rect, model.nodes.map((n) => n.rect),');
    // Flying to a group chip must aim at where the group really is, not at an already-tightened
    // rect whose own destination zoom would change the spacing factor again.
    expect(MODE).toContain('onChipClick={() => flyTo(centreOn(g.rect, size.w, size.h, GROUP_CHIP_ZOOM, metrics.zMax))}');
    expect(MODE).not.toContain('onChipClick={() => flyTo(centreOn(spacing.groupRects');
  });

  it('keeps the "frame everything" camera targets off the transform they would otherwise feed back into', () => {
    expect(MODE).toContain('boundsOf(shownGroups.map((g) => g.rect))');
  });

  it('leaves the minimap on the raw model — a fixed-scale overview, not a zoomed spatial view', () => {
    const minimap = /<CanvasMinimap[\s\S]*?\/>/.exec(MODE)?.[0] ?? '';
    expect(minimap).toContain('shownGroups={shownGroups}');
    expect(minimap).not.toContain('spacedShownGroups');
  });

  it('freezes spacing for the duration of a node or group drag press', () => {
    expect(MODE).toContain('setDragActive(true)');
    expect(MODE).toContain('dynamicSpacing && !dragActive');
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
