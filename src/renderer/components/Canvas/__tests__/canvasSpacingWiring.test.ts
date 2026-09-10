import fs from 'fs';
import path from 'path';
import { readSource } from '../../../utils/readSource';

/** Source pins must not be satisfied by the comments explaining the regression. */
function code(file: string): string {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MODE = code(path.resolve(__dirname, '../CanvasMode.tsx'));
const SIDEBAR = code(path.resolve(__dirname, '../CanvasSidebar.tsx'));
const DRAG = code(path.resolve(__dirname, '../useCanvasDrag.ts'));
const SIDEBAR_DRAG = code(path.resolve(__dirname, '../useSidebarDrag.ts'));
const ARRANGE = code(path.resolve(__dirname, '../useArrange.ts'));
const VIEWPORT = code(path.resolve(__dirname, '../CanvasViewport.tsx'));
const APP = code(path.resolve(__dirname, '../../../App.tsx'));
const SLICE = code(path.resolve(__dirname, '../../../store/slices/canvasSlice.ts'));
const FLY_TO_WORLD = (() => {
  const start = MODE.indexOf('const flyToWorld = useCallback(');
  return start < 0 ? '' : MODE.slice(start, MODE.indexOf('\n  }, [', start));
})();
const TARGET_RECT_AT = (() => {
  const start = MODE.indexOf('const targetRectAt = useCallback(');
  return start < 0 ? '' : MODE.slice(start, MODE.indexOf('\n  const busyCue', start));
})();
const NODE_DRAG = (() => {
  const start = DRAG.indexOf('const nd = nodeDrag.current;');
  const end = DRAG.indexOf('const gd = groupDrag.current;', start);
  return start < 0 || end < 0 ? '' : DRAG.slice(start, end);
})();
const GROUP_DRAG = (() => {
  const start = DRAG.indexOf('const gd = groupDrag.current;');
  const end = DRAG.indexOf('const onUp = () => {', start);
  return start < 0 || end < 0 ? '' : DRAG.slice(start, end);
})();
const PRESENTATION_MODEL = (() => {
  const start = MODE.indexOf('const presentationModel = useMemo(');
  const end = MODE.indexOf('\n  const flyTo = useFlyTo();', start);
  return start < 0 || end < 0 ? '' : MODE.slice(start, end);
})();
const CANVAS_DRAG_INPUT = (() => {
  const start = MODE.indexOf('const drag = useCanvasDrag(');
  const inputStart = start + 'const drag = useCanvasDrag('.length;
  const end = MODE.indexOf(', beginRealDrag);', inputStart);
  return start < 0 || end < 0 ? '' : MODE.slice(inputStart, end).trim();
})();
const GEOMETRY_DISPATCHES = [APP, MODE, DRAG, SIDEBAR_DRAG, ARRANGE]
  .flatMap((source) => source.match(/dispatch\((?:setNodeGeom|setGroupGeom|moveGroupGeom|applyArrange)\([\s\S]*?\)\);/g) ?? []);

describe('Dynamic Spacing consumers (plan/039)', () => {
  it('feeds the spacing-adjusted rects to tiers, culling and wire geometry, not the raw model', () => {
    expect(MODE).toContain('for (const n of spacedNodes) rects[n.terminalId] = n.rect;');
    expect(MODE).toContain('visibleNodeIds(spacedNodes, vp, size.w, size.h)');
    expect(MODE).toContain('for (const n of spacedNodes) {');
    expect(MODE).toContain('beaconLayout(spacedPaintedNodes, vp, size.w, size.h)');
    expect(MODE).toContain('chipOffsets(spacedShownGroups, vp.z)');
    // The rect handed to the painter is the rect from this display-space loop, not a raw lookup.
    expect(MODE).toContain("const box = paintedNodeRect(n.rect, vp.z, tiers[n.terminalId] === 'chip');");
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
    expect(TARGET_RECT_AT).toContain("return (kind === 'node' ? s.nodeRects[id] : s.groupRects[id]) ?? raw;");
    expect(MODE).toContain("targetRectAt(vp.z, 'node', plan.leafId, plan.rect, postSpawnSpacingModel)");
  });

  it('keeps raw geometry for choosing fit zoom and uses display geometry throughout the minimap', () => {
    // Global fit remains raw because its bounds contain every inward-spaced rect. A single-group
    // fit chooses zoom from raw dimensions too, but centres on its display-space location.
    expect(MODE).toContain('boundsOf(shownGroups.map((g) => g.rect))');
    expect(MODE).toContain("targetRectAt(fitted.z, 'group', g.tabId, g.rect)");
    expect(FLY_TO_WORLD).toContain('flyTo(centreOn({ x: w.x, y: w.y, w: 0, h: 0 }, size.w, size.h, vp.z, metrics.zMax));');
    expect(FLY_TO_WORLD).not.toContain('shownGroups.find(');
  });

  it('keeps the "frame everything" camera targets off the transform they would otherwise feed back into', () => {
    expect(MODE).toContain('boundsOf(shownGroups.map((g) => g.rect))');
  });

  it('projects the same display layout as the main canvas at its own fixed minimap scale', () => {
    const minimap = /<CanvasMinimap[\s\S]*?\/>/.exec(MODE)?.[0] ?? '';
    expect(minimap).toContain('model={{ ...model, nodes: spacedNodes }}');
    expect(minimap).toContain('shownGroups={spacedShownGroups}');
    expect(minimap).not.toContain('shownGroups={shownGroups}');
  });

  it('cancels absolute fly-to frames inside every site that corrects the camera', () => {
    // A `setViewport(lerpViewport(...))` frame captured before the correction overwrites it on
    // the next animation frame, taking the anchoring with it.
    //
    // Counting cancels against pans is NOT enough, and that weaker oracle was the first thing
    // written here: a cancel deleted from one site and duplicated in another keeps both totals
    // and still leaves a site unprotected. So each site is sliced and asked separately, and the
    // ORDER inside it is checked — a cancel after its own pan is no cancel at all.
    const sliceAt = (open: string, close: string) => {
      const start = MODE.indexOf(open);
      return start < 0 ? '' : MODE.slice(start, MODE.indexOf(close, start + open.length));
    };
    const SITES = {
      dragEntry: sliceAt('const beginRealDrag = useCallback(', '\n  }, ['),
      dragExit: sliceAt('if (wasDraggingRef.current && !drag.dragActive) {', '\n  }, ['),
      transform: sliceAt('const was = paintedRef.current;', '\n  }, ['),
      zoom: sliceAt('const zoomAtAnchor = useCallback(', '\n  );'),
    };

    for (const [name, body] of Object.entries(SITES)) {
      const cancel = body.indexOf('flyTo.cancel();');
      expect({ name, cancels: cancel >= 0 }).toEqual({ name, cancels: true });
      // The zoom site returns a viewport rather than panning; the other three pan.
      const pan = body.indexOf('panScreen(');
      if (name !== 'zoom') {
        expect({ name, pans: pan >= 0 }).toEqual({ name, pans: true });
        expect({ name, cancelsFirst: cancel < pan }).toEqual({ name, cancelsFirst: true });
      }
    }

    // Completeness: no camera correction may live OUTSIDE the four sites above. Without this the
    // per-site checks pass happily while a fifth, unprotected one is added next to them.
    const total = (MODE.match(/panScreen\(pan\.dx, pan\.dy\)/g) ?? []).length;
    const accounted = Object.entries(SITES)
      .filter(([name]) => name !== 'zoom')
      .reduce((n, [, body]) => n + (body.match(/panScreen\(pan\.dx, pan\.dy\)/g) ?? []).length, 0);
    expect({ total, accounted }).toEqual({ total: 3, accounted: 3 });

    expect(VIEWPORT).toContain('const cancel = useCallback(() => {');
    expect(VIEWPORT).toContain('return useMemo(() => Object.assign(flyTo, { cancel }), [flyTo, cancel]);');
  });

  /**
   * The transform is replaced by four things, not one. A zoom anchors itself; the other three are
   * the drag pair and this effect, which covers BOTH the toolbar toggle and a change in which
   * nodes participate — hiding a terminal re-shrink-wraps its frame and re-sweeps the canvas
   * without a single stored rect changing, so the view jumps by the whole offset difference.
   */
  it('compensates a transform replaced by anything other than a zoom', () => {
    const effect = MODE.slice(
      MODE.indexOf('const was = paintedRef.current;'),
      MODE.indexOf('\n  }, [', MODE.indexOf('const was = paintedRef.current;')),
    );
    // Keyed on what can replace the transform. `vp` and `spacing` change on every pan and zoom,
    // which anchor themselves — listing either would re-pan the camera on ordinary navigation.
    expect(MODE).toContain('}, [membershipKey, spacingRendered]);');
    expect(MODE).toContain("`${paintedNodes.map((n) => n.terminalId).join(',')}|${shownGroups.map((g) => g.tabId).join(',')}`");
    // A drag paints raw on BOTH sides of a toggle, so there is no transform change to pay for.
    expect(effect).toContain('drag.dragActive');
    // Same-zoom only: `was` was swept at the old zoom, so across a zoom the difference is not
    // the transform's alone — and the zoom already anchored itself.
    expect(effect).toContain('if (was.z !== vpRef.current.z) return;');
    // The recorder must be declared AFTER the comparer, or it overwrites the previous transform
    // before the comparer ever sees it and every compensation silently becomes a no-op.
    expect(MODE.indexOf('const was = paintedRef.current;'))
      .toBeLessThan(MODE.indexOf('paintedRef.current = { model: spacingModel, spacing, z: vp.z };'));
  });

  it('uses raw geometry only for a real slop-crossed drag and compensates both transitions', () => {
    expect(MODE).toContain('applySpacing(spacingModel, vp.z, spacingRendered)');
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
    // The notification cannot happen until the slop guard has returned for sub-threshold motion.
    expect(NODE_DRAG.indexOf('if (!nd.moved && Math.hypot')).toBeLessThan(NODE_DRAG.indexOf('onDragStart?.('));
    expect(GROUP_DRAG.indexOf('if (!gd.moved && Math.hypot')).toBeLessThan(GROUP_DRAG.indexOf('onDragStart?.('));
    expect(NODE_DRAG.indexOf('onDragStart?.(')).toBeGreaterThan(-1);
    expect(GROUP_DRAG.indexOf('onDragStart?.(')).toBeGreaterThan(-1);
  });

  it('applies each computed transition pan, rather than merely calculating it', () => {
    expect(MODE).toMatch(/const pan = spacingTransitionPan\(offset, source\.z, 'toRaw'\);\s+panScreen\(pan\.dx, pan\.dy\);/);
    expect(MODE).toMatch(/const pan = spacingTransitionPan\(offset, vp\.z, 'toDisplay'\);\s+panScreen\(pan\.dx, pan\.dy\);/);
  });

  it('keeps the whole real drag raw even if wheel zoom changes mid-gesture', () => {
    // `dragActive` gates the identity result itself; no frozen offset can survive at z=1.
    expect(MODE).toContain('applySpacing(spacingModel, vp.z, spacingRendered)');
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
    // The reducer cannot distinguish a bad payload. Every production geometry writer must feed
    // it raw layout expressions; this is a complete, counted census across App agent spawn,
    // CanvasMode spawn, canvas drag, sidebar regroup, and arrange.
    expect(GEOMETRY_DISPATCHES).toHaveLength(12);
    for (const dispatch of GEOMETRY_DISPATCHES) {
      expect(dispatch).not.toMatch(/\b(?:spacing|spaced)\w*/i);
    }
  });

  it('feeds every geometry writer from a raw model, before its final dispatch expression', () => {
    // Group dragging snapshots node rects at pointer-down, so its input must be the raw model
    // with only the shown-group filter applied. This binds the call site to the definition,
    // rather than treating `presentationModel` as a magic name.
    expect(CANVAS_DRAG_INPUT).toBe('presentationModel');
    expect(PRESENTATION_MODEL).toContain('({ ...model, groups: shownGroups })');
    expect(PRESENTATION_MODEL).not.toMatch(/\b(?:spacing|spaced)\w*/i);

    // The other paths which can persist canvas geometry likewise receive raw selectors/plans.
    expect(MODE).toContain('const arrange = useArrange(model, edges);');
    expect(SIDEBAR).toContain('const drag = useSidebarDrag(model);');
    expect(APP).toContain('buildCanvasModel(state),');
    expect(APP).toContain('dispatch(setNodeGeom({ id: plan.terminalId, rect: plan.rect }));');
    expect(APP).not.toMatch(/\b(?:spacing|spaced)\w*/i);
  });

  /**
   * `zoomAt` pins the RAW world point under the anchor, which is right only while the world is
   * drawn at its stored coordinates. Under Dynamic Spacing it is drawn at `raw + offset(z)`, so
   * a zoom that does not also correct for the change in that offset slides the terminal the user
   * aimed at out from under the cursor — cumulatively most of a screen by the top of the range,
   * which is felt as a canvas that will not zoom in rather than as a misplaced node.
   *
   * That defect shipped once. It is invisible to every oracle that looks at ONE zoom level, so
   * what stops it coming back is structural: exactly one function may call `zoomAt`, and every
   * gesture goes through it.
   */
  it('routes every point-anchored zoom through the one anchored helper', () => {
    const dir = path.resolve(__dirname, '..');
    const OWNERS = ['canvasGeometry.ts', 'canvasSpacing.ts'];
    // Recursive, so moving a raw-zoom helper into a subfolder does not walk out of the sweep.
    const walk = (at: string): string[] => fs.readdirSync(at, { withFileTypes: true })
      .flatMap((e) => {
        const full = path.join(at, e.name);
        if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
        return /\.tsx?$/.test(e.name) && !OWNERS.includes(e.name) ? [full] : [];
      });
    const consumers = walk(dir);

    // An absence census is the one kind that passes once it has stopped looking at anything, so
    // pin that the sweep still covers the two files that USED to call `zoomAt` themselves.
    expect(consumers.map((f) => path.basename(f)))
      .toEqual(expect.arrayContaining(['CanvasMode.tsx', 'CanvasViewport.tsx']));
    for (const file of consumers) {
      const src = code(file);
      // Both spellings: the call, and the IMPORT that would let it be called under another name.
      // `import { zoomAt as rawZoom }` passes a `zoomAt(` scan while doing exactly the old thing.
      expect({
        file: path.relative(dir, file),
        callsZoomAt: /\bzoomAt\s*\(/.test(src),
        importsZoomAt: /\bimport\s*\{[^}]*\bzoomAt\b[^}]*\}\s*from/.test(src),
      }).toEqual({ file: path.relative(dir, file), callsZoomAt: false, importsZoomAt: false });
    }

    // The anchor has to agree with what is RENDERED, not with the setting: a real drag swaps the
    // world back to raw for the whole gesture, so a wheel turned mid-drag must anchor raw too.
    // These two lines are the pair that has to move together.
    expect(MODE).toContain('applySpacing(spacingModel, vp.z, spacingRendered)');
    expect(MODE).toContain('const spacingRendered = dynamicSpacing && !drag.dragActive;');
    expect(MODE).toContain('metrics.zMax, spacingModel, spacingRendered');

    // And that the owner really is the anchored one — not `zoomAnchoredAt` delegating to a copy.
    const SPACING = code(path.resolve(dir, 'canvasSpacing.ts'));
    const anchored = SPACING.slice(SPACING.indexOf('export function zoomAnchoredAt'));
    expect(anchored).toContain('const next = zoomAt(vp, factor, cx, cy, zMax);');
    // A single SAMPLE of the camera path, so a stepped zoom and an animated one cannot land
    // anywhere different — the endpoint is not computed a second way.
    expect(anchored).toContain('return anchoredCamera(vp, cx, cy, model, enabled)(next.z);');
    // And the animation is handed the path itself, not two endpoints to interpolate between.
    expect(MODE).toContain('anchoredCamera(vp, size.w / 2, size.h / 2, spacingModel, spacingRendered)');
    expect(VIEWPORT).toContain('dispatch(setViewport(cameraAt ? cameraAt(frame.z) : frame));');
  });
});
