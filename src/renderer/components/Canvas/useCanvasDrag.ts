import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { setNodeGeom, setGroupGeom, moveGroupGeom } from '../../store/slices/canvasSlice';
import { removePaneFromTab, insertPaneIntoTab } from '../../store/slices/panesSlice';
import { Rect } from './canvasGeometry';
import { fitGroupFrame } from './canvasLayout';
import { CanvasModel } from './canvasSelectors';
import { planRegroup, moveGroupBy, worldDelta, dropTargetTabId } from './canvasMutations';

/**
 * Node drag, group drag and cross-group re-homing — `plan/013` Tasks 11 and 12.
 *
 * A hook rather than more of `CanvasMode` because the two drags share every moving part: the
 * screen→world conversion, the window listeners, and the pointer-capture lifecycle. Two copies
 * of that in one component is how they drift.
 *
 * The DECISIONS all live in `canvasMutations` as pure functions (`planRegroup`, `moveGroupBy`,
 * `worldDelta`, `dropTargetTabId`) and are tested there. What is left here is wiring, which is
 * the part no test in this repo can reach — `CanvasMode` cannot be mounted under the root Jest
 * config — so it is kept as thin as it can be.
 *
 * **Window listeners, not React handlers on the node.** A drag that leaves the element still has
 * to track the cursor, and `pointerup` outside the window has to end it. `setPointerCapture`
 * retargets the events, and these listeners see them either way.
 */

interface NodeDrag {
  terminalId: string;
  tabId: string;
  /** Screen coords at pointerdown, so the delta is measured from the press, not the last frame —
   *  accumulating per-frame deltas drifts under rounding. */
  startX: number;
  startY: number;
  origin: Rect;
  /** True once the pointer has actually moved. A click on a header must not count as a drag and
   *  write geometry (which would defeat the double-click-to-overlay gesture). */
  moved: boolean;
}

interface GroupDrag {
  tabId: string;
  startX: number;
  startY: number;
  frame: Rect;
  nodes: Record<string, Rect>;
  ids: string[];
  moved: boolean;
}

/** Below this many screen pixels a press is a click, not a drag. */
const DRAG_SLOP = 3;

export interface CanvasDrag {
  onNodeHeaderPointerDown: (terminalId: string, tabId: string, rect: Rect) => (e: React.PointerEvent) => void;
  onGroupLabelPointerDown: (tabId: string) => (e: React.PointerEvent) => void;
  /** Frame to highlight as the pending drop target. */
  dropTabId: string | null;
  /** Frame currently being dragged as a whole. */
  movingTabId: string | null;
}

export function useCanvasDrag(model: CanvasModel): CanvasDrag {
  const dispatch = useDispatch();
  const zoom = useSelector((s: RootState) => s.canvas.viewport.z);
  const trees = useSelector((s: RootState) => s.panes.treesByTabId);

  const [dropTabId, setDropTabId] = useState<string | null>(null);
  const [movingTabId, setMovingTabId] = useState<string | null>(null);

  const nodeDrag = useRef<NodeDrag | null>(null);
  const groupDrag = useRef<GroupDrag | null>(null);

  // Read through refs inside the window listeners below, which are registered ONCE. Putting
  // these in the effect's deps would tear the listeners down and re-register them on every pan,
  // zoom and model change — mid-drag, which drops the drag.
  const latest = useRef({ model, zoom, trees });
  latest.current = { model, zoom, trees };

  const onNodeHeaderPointerDown = useCallback(
    (terminalId: string, tabId: string, rect: Rect) => (e: React.PointerEvent) => {
      // Not preventDefault: the header is also the double-click target for the overlay, and the
      // node's own pointerdown selects it. Both should still happen.
      e.stopPropagation();
      nodeDrag.current = {
        terminalId, tabId, startX: e.clientX, startY: e.clientY, origin: rect, moved: false,
      };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [],
  );

  const onGroupLabelPointerDown = useCallback(
    (tabId: string) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();          // or the viewport starts a pan under it
      const { model: m } = latest.current;
      const group = m.groups.find((g) => g.tabId === tabId);
      if (!group) return;
      groupDrag.current = {
        tabId,
        startX: e.clientX,
        startY: e.clientY,
        frame: group.rect,
        nodes: Object.fromEntries(m.nodes.map((n) => [n.terminalId, n.rect])),
        ids: group.nodeIds,
        moved: false,
      };
      setMovingTabId(tabId);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const { model: m, zoom: z } = latest.current;

      const nd = nodeDrag.current;
      if (nd) {
        const { dx, dy } = worldDelta(e.clientX - nd.startX, e.clientY - nd.startY, z);
        if (!nd.moved && Math.hypot(e.clientX - nd.startX, e.clientY - nd.startY) < DRAG_SLOP) return;
        nd.moved = true;
        const rect = { ...nd.origin, x: nd.origin.x + dx, y: nd.origin.y + dy };
        dispatch(setNodeGeom({ id: nd.terminalId, rect }));
        setDropTabId(dropTargetTabId(
          m.groups.map((g) => ({ tabId: g.tabId, rect: g.rect })),
          rect.x + rect.w / 2,
          rect.y + rect.h / 2,
          nd.tabId,
        ));
        return;
      }

      const gd = groupDrag.current;
      if (gd) {
        if (!gd.moved && Math.hypot(e.clientX - gd.startX, e.clientY - gd.startY) < DRAG_SLOP) return;
        gd.moved = true;
        const { dx, dy } = worldDelta(e.clientX - gd.startX, e.clientY - gd.startY, z);
        const moved = moveGroupBy(gd.frame, gd.nodes, gd.ids, dx, dy);
        // ONE transition for the frame and every member. This was a dispatch per member,
        // so a 100-terminal group produced 101 Redux actions per pointer event — each one
        // invalidating the canvas selector and re-running layout mid-gesture.
        const nodes: Record<string, Rect> = {};
        for (const id of gd.ids) {
          if (moved.nodes[id]) nodes[id] = moved.nodes[id];
        }
        dispatch(moveGroupGeom({ tabId: gd.tabId, frame: moved.frame, nodes }));
      }
    };

    const onUp = () => {
      const nd = nodeDrag.current;
      const gd = groupDrag.current;
      nodeDrag.current = null;
      groupDrag.current = null;
      setMovingTabId(null);
      const target = dropTabId;
      setDropTabId(null);

      if (gd?.moved) {
        // Shrink-wrap the frame around wherever its terminals ended up.
        const { model: m } = latest.current;
        const rects = m.nodes.filter((n) => gd.ids.includes(n.terminalId)).map((n) => n.rect);
        const fitted = fitGroupFrame(rects);
        if (fitted) dispatch(setGroupGeom({ id: gd.tabId, rect: fitted }));
        return;
      }

      if (!nd?.moved || !target || target === nd.tabId) return;
      applyRegroup(nd.terminalId, nd.tabId, target);
    };

    const applyRegroup = (terminalId: string, fromTabId: string, toTabId: string) => {
      const { model: m, trees: t } = latest.current;
      const plan = planRegroup(t, terminalId, fromTabId, toTabId);
      if (!plan) return;

      // The SAME reducer pair the cross-window drop uses, rather than writing trees directly:
      // they collapse the source tree, drop it entirely when it empties, clear both tabs'
      // maximize flags and repair the active pane. See `planRegroup`'s note.
      dispatch(removePaneFromTab({ tabId: fromTabId, paneId: plan.paneId }));
      dispatch(insertPaneIntoTab({
        tabId: toTabId, targetPaneId: plan.anchorPaneId, zone: 'right', node: plan.movedPane,
      }));

      // Re-fit BOTH frames from their new membership. Computed here rather than read back,
      // because the model this hook holds is from the render before those dispatches.
      const rectOf = (id: string) => m.nodes.find((n) => n.terminalId === id)?.rect;
      const refit = (tabId: string, ids: string[]) => {
        const rects = ids.map(rectOf).filter((r): r is Rect => !!r);
        const fitted = fitGroupFrame(rects);
        // Null means the group is now empty. Design §6.3/§10: it KEEPS its last frame and stays
        // a visible drop target, so skipping the dispatch is the correct behaviour, not a gap.
        if (fitted) dispatch(setGroupGeom({ id: tabId, rect: fitted }));
      };
      const from = m.groups.find((g) => g.tabId === fromTabId);
      const to = m.groups.find((g) => g.tabId === toTabId);
      if (from) refit(fromTabId, from.nodeIds.filter((id) => id !== terminalId));
      // The dropped node keeps the position the user chose — design says do NOT re-grid the
      // destination on a canvas drop — so the frame simply grows to include where it landed.
      if (to) refit(toTabId, [...to.nodeIds, terminalId]);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dispatch, dropTabId]);

  return { onNodeHeaderPointerDown, onGroupLabelPointerDown, dropTabId, movingTabId };
}
