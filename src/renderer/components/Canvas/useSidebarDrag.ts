import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { setGroupGeom, setNodeGeom, setSidebarWidth } from '../../store/slices/canvasSlice';
import { removePaneFromTab, insertPaneIntoTab } from '../../store/slices/panesSlice';
import { NODE_W, NODE_H, Rect } from './canvasGeometry';
import { fitGroupFrame } from './canvasLayout';
import { planRegroup, regridGroup } from './canvasMutations';
import type { CanvasModel } from './canvasSelectors';

/**
 * The sidebar's two pointer gestures — `plan/013` Task 15.
 *
 * Both live here for the reason `useCanvasDrag` gives: they share the window listeners and the
 * pointer-capture lifecycle, and a second copy of that is how the two drift. The decisions are
 * `planRegroup` and `regridGroup` in `canvasMutations`, tested there.
 *
 * **Pointer events, not HTML5 drag-and-drop**, matching the pane drag controller. DnD would give
 * us a drag image we cannot style, no control over the drop target while the pointer is moving,
 * and a `dragend` that does not fire reliably when the drop is refused.
 */

/**
 * Below this many pixels a press is a click, not a drag.
 *
 * Larger than the canvas's own 3px because a row carries two other gestures that a stray pixel
 * must not steal: a single click flies to the node and a double click renames it. A node header
 * has only the drag.
 */
const ROW_SLOP = 6;

interface RowDrag {
  terminalId: string;
  tabId: string;
  title: string;
  startX: number;
  startY: number;
  moved: boolean;
}

interface ResizeDrag { startX: number; startW: number }

export interface SidebarDrag {
  onRowPointerDown: (terminalId: string, tabId: string, title: string) => (e: React.PointerEvent) => void;
  onResizePointerDown: (e: React.PointerEvent) => void;
  /** The row being dragged, so it can render as lifted. */
  draggingId: string | null;
  /** The group the pointer is over and would drop into, or null. */
  dropTabId: string | null;
  /** Where to draw the floating label, in client coordinates. */
  ghost: { x: number; y: number; label: string } | null;
  resizing: boolean;
  /**
   * True once, immediately after a drag that actually moved.
   *
   * `click` fires after `pointerup`, so without this the drop would also fly the viewport to the
   * node that just changed groups — which looks like the drop went somewhere unintended.
   */
  consumeClick: () => boolean;
}

export function useSidebarDrag(model: CanvasModel): SidebarDrag {
  const dispatch = useDispatch();
  const trees = useSelector((s: RootState) => s.panes.treesByTabId);
  const width = useSelector((s: RootState) => s.canvas.sidebarWidth);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTabId, setDropTabId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const [resizing, setResizing] = useState(false);

  const rowDrag = useRef<RowDrag | null>(null);
  const resizeDrag = useRef<ResizeDrag | null>(null);
  const justDragged = useRef(false);

  // Read through a ref inside listeners registered ONCE — putting these in the effect's deps
  // would tear them down and re-register mid-drag on every model change.
  const latest = useRef({ model, trees, width });
  latest.current = { model, trees, width };

  const onRowPointerDown = useCallback(
    (terminalId: string, tabId: string, title: string) => (e: React.PointerEvent) => {
      // Not `preventDefault`: the row's own click and double-click must still happen when this
      // turns out to be a press rather than a drag.
      rowDrag.current = { terminalId, tabId, title, startX: e.clientX, startY: e.clientY, moved: false };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [],
  );

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    resizeDrag.current = { startX: e.clientX, startW: latest.current.width };
    setResizing(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const consumeClick = useCallback(() => {
    if (!justDragged.current) return false;
    justDragged.current = false;
    return true;
  }, []);

  useEffect(() => {
    /** Which group the pointer is over, from the DOM rather than from cached rectangles: the
     *  list scrolls and re-flows as it filters, so any geometry we cached at pointerdown would
     *  be describing a layout that has since moved. */
    const groupUnder = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y);
      const section = el?.closest?.('.canvas-sgroup') as HTMLElement | null;
      return section?.dataset.tabId ?? null;
    };

    const onMove = (e: PointerEvent) => {
      const rz = resizeDrag.current;
      if (rz) {
        // The slice clamps to SIDEBAR_MIN..SIDEBAR_MAX, so the handle can be dragged past both
        // ends and the width simply stops.
        dispatch(setSidebarWidth(rz.startW + (e.clientX - rz.startX)));
        return;
      }

      const rd = rowDrag.current;
      if (!rd) return;
      if (!rd.moved && Math.hypot(e.clientX - rd.startX, e.clientY - rd.startY) < ROW_SLOP) return;
      rd.moved = true;
      setDraggingId(rd.terminalId);
      setGhost({ x: e.clientX, y: e.clientY, label: rd.title });
      const over = groupUnder(e.clientX, e.clientY);
      // Its own group is not a target: re-homing a terminal to where it already lives is a
      // no-op, and highlighting it would promise a change that is not going to happen.
      setDropTabId(over && over !== rd.tabId ? over : null);
    };

    const onUp = () => {
      if (resizeDrag.current) {
        resizeDrag.current = null;
        setResizing(false);
        return;
      }
      const rd = rowDrag.current;
      rowDrag.current = null;
      const target = dropTabId;
      setDraggingId(null);
      setDropTabId(null);
      setGhost(null);
      if (!rd?.moved) return;
      justDragged.current = true;
      if (!target || target === rd.tabId) return;
      applyRegroup(rd.terminalId, rd.tabId, target);
    };

    const applyRegroup = (terminalId: string, fromTabId: string, toTabId: string) => {
      const { model: m, trees: t } = latest.current;
      const plan = planRegroup(t, terminalId, fromTabId, toTabId);
      if (!plan) return;

      // The same reducer pair the canvas drop and the cross-window detach use — design §6.3:
      // "both dispatch the same underlying move". See `planRegroup`'s note for what writing
      // trees directly would miss.
      dispatch(removePaneFromTab({ tabId: fromTabId, paneId: plan.paneId }));
      dispatch(insertPaneIntoTab({
        tabId: toTabId, targetPaneId: plan.anchorPaneId, zone: 'right', node: plan.movedPane,
      }));

      const sizeOf = (id: string): Rect =>
        m.nodes.find((n) => n.terminalId === id)?.rect ?? { x: 0, y: 0, w: NODE_W, h: NODE_H };

      // **The destination is RE-GRIDDED, not merely re-fitted**, and that is the one real
      // difference between this and the canvas drop: a list drag carries no position, so there
      // is nowhere to honour and the arrival is slotted into the grid instead (design §6.3).
      const to = m.groups.find((g) => g.tabId === toTabId);
      if (to) {
        const r = regridGroup(to.rect, [...to.nodeIds, terminalId]);
        dispatch(setGroupGeom({ id: toTabId, rect: r.frame }));
        for (const [id, p] of Object.entries(r.nodes)) {
          const s = sizeOf(id);
          dispatch(setNodeGeom({ id, rect: { x: p.x, y: p.y, w: s.w, h: s.h } }));
        }
      }

      // The SOURCE only shrink-wraps around what is left — re-gridding it would rearrange
      // terminals the user never touched. Null means it is now empty, and skipping the dispatch
      // is what leaves its frame in place as a drop target (§6.3/§10).
      const from = m.groups.find((g) => g.tabId === fromTabId);
      if (from) {
        const rects = from.nodeIds.filter((id) => id !== terminalId).map(sizeOf);
        const fitted = fitGroupFrame(rects);
        if (fitted) dispatch(setGroupGeom({ id: fromTabId, rect: fitted }));
      }
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

  return { onRowPointerDown, onResizePointerDown, draggingId, dropTabId, ghost, resizing, consumeClick };
}
