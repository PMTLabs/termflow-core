import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { addEdge } from '../../store/slices/canvasSlice';
import { createEdge } from '../../services/canvasGraph';
import { worldPoint } from './canvasMutations';
import { CanvasModel } from './canvasSelectors';
import {
  Side, pickSides, portPoint, wirePath, oppositeSide, linkTargetId,
} from './wireGeometry';

/**
 * Drag a connection out of a node port — `plan/013` Task 18, design 010 §5 / §7.1.
 *
 * Direction is the gesture: from the node whose port was grabbed, to the node released over.
 *
 * **The ports already exist.** `CanvasNode` renders four `.canvas-port` spans carrying
 * `data-port`, `Canvas.css` styles and hover-reveals them, and `CanvasViewport` already exempts
 * them from the background pan. So this listens for them by delegation rather than threading a
 * handler prop through the node — the same resolution `useSidebarDrag` does with
 * `elementFromPoint().closest()`, and it keeps `CanvasNode`'s props unchanged.
 *
 * Window listeners rather than React handlers, for the reason `useCanvasDrag` documents: a drag
 * that leaves the element still has to track the cursor, and a `pointerup` outside the window
 * still has to end it.
 */

interface Link {
  fromId: string;
  side: Side;
  /** World-space start point, frozen at pointerdown. */
  from: [number, number];
  /** `.canvas-viewport`'s box, for screen→world. */
  rect: { left: number; top: number };
}

export interface WireDragState {
  /** Attach to the canvas root in the CAPTURE phase. */
  onPointerDownCapture: (e: React.PointerEvent) => void;
  /** The `d` of the wire being dragged, or null. */
  ghost: string | null;
  /** True while a link drag is in flight — reveals every port as a candidate target. */
  linking: boolean;
  /** The node the drag would land on, for its highlight. */
  targetId: string | null;
}

/** The element under the cursor that is a canvas node, if any. */
function terminalIdAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return el?.closest('.canvas-node')?.getAttribute('data-terminal-id') ?? null;
}

export function useWireDrag(model: CanvasModel): WireDragState {
  const dispatch = useDispatch();
  const vp = useSelector((s: RootState) => s.canvas.viewport);

  const link = useRef<Link | null>(null);
  const [ghost, setGhost] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);

  // Read through a ref inside listeners registered once — see `useCanvasDrag`.
  const latest = useRef({ model, vp });
  latest.current = { model, vp };

  const rectOf = (id: string) =>
    latest.current.model.nodes.find((n) => n.terminalId === id)?.rect;

  const onPointerDownCapture = useCallback((e: React.PointerEvent) => {
    const port = (e.target as HTMLElement | null)?.closest('.canvas-port') as HTMLElement | null;
    if (!port) return;
    const side = port.getAttribute('data-port') as Side | null;
    const fromId = port.closest('.canvas-node')?.getAttribute('data-terminal-id');
    const viewport = port.closest('.canvas-viewport') as HTMLElement | null;
    if (!side || !fromId || !viewport) return;
    const rect = rectOf(fromId);
    if (!rect) return;

    // Capture, and stop: a port press must not also select the node, start a header drag or
    // reach the viewport's pan. It is its own gesture in design §5's table.
    e.preventDefault();
    e.stopPropagation();

    const box = viewport.getBoundingClientRect();
    link.current = {
      fromId,
      side,
      from: portPoint(rect, side),
      rect: { left: box.left, top: box.top },
    };
    setLinking(true);
    setGhost(null);
    setTargetId(null);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  useEffect(() => {
    const end = () => {
      link.current = null;
      setLinking(false);
      setGhost(null);
      setTargetId(null);
    };

    const onMove = (e: PointerEvent) => {
      const l = link.current;
      if (!l) return;
      const { vp: v } = latest.current;
      const over = linkTargetId(terminalIdAt(e.clientX, e.clientY), l.fromId);
      setTargetId(over);

      const target = over ? rectOf(over) : undefined;
      const source = rectOf(l.fromId);
      if (target && source) {
        // Preview EXACTLY the wire that will exist. Once created, geometry comes from
        // `pickSides` — the grabbed port decides the edge's direction, never its shape — so
        // previewing from the grabbed face instead would redraw itself on release.
        const [s1, s2] = pickSides(source, target);
        setGhost(wirePath(portPoint(source, s1), portPoint(target, s2), s1, s2));
        return;
      }
      const to = worldPoint(e.clientX, e.clientY, l.rect, v);
      setGhost(wirePath(l.from, [to.x, to.y], l.side, oppositeSide(l.side)));
    };

    const onUp = (e: PointerEvent) => {
      const l = link.current;
      if (!l) return;
      end();
      const to = linkTargetId(terminalIdAt(e.clientX, e.clientY), l.fromId);
      if (!to) return;

      // Dispatch ONLY the row the server returns. The id is minted server-side and is the only
      // one a later delete or label edit can name; an optimistic client id is never replaced,
      // so the delete would target something that does not exist and leave the real edge
      // behind. A duplicate pair comes back as the EXISTING row, which is the id we want.
      void createEdge(l.fromId, to).then((edge) => {
        if (edge) dispatch(addEdge(edge));
      });
    };

    // A link drag has no other way out — the canvas Esc handler only runs while a node is
    // focused, and a focused node is exactly when this gesture cannot have started.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && link.current) end();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [dispatch]);

  return { onPointerDownCapture, ghost, linking, targetId };
}
