import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { CanvasEdge, addEdge, removeEdge, selectEdge } from '../../store/slices/canvasSlice';
import { createEdge, reconnectEdge } from '../../services/canvasGraph';
import { worldPoint } from './canvasMutations';
import { exceedsDragSlop } from './canvasGestures';
import { Rect } from './canvasGeometry';
import {
  Side, WireEnd, pickSides, portPoint, wirePath, oppositeSide, linkTargetId, anchorOf,
  reconnectPair,
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
  /** The node this drag PIVOTS ABOUT — the port's own node for a fresh wire, and the end that
   *  is staying put when an existing one is being re-pointed. */
  anchorId: string;
  side: Side;
  /** World-space start point, frozen at pointerdown. */
  from: [number, number];
  /** `.canvas-viewport`'s box, for screen→world. */
  rect: { left: number; top: number };
  /** Where the press landed, in SCREEN pixels — the origin the drag slop is measured from.
   *  Screen rather than world so the threshold is a constant number of pixels the user moved,
   *  not a distance that shrinks with the zoom. */
  origin: { x: number; y: number };
  /** True once the pointer has travelled past `DRAG_SLOP`. Until then the press is still a
   *  candidate click, and no ghost wire is drawn. */
  moved: boolean;
  /**
   * Set when an EXISTING connection is being re-pointed rather than a new one drawn.
   *
   * The edge is snapshotted at pointerdown deliberately: it is the row the drop will replace,
   * and re-reading it mid-gesture would let a label edit in another window change what this
   * drag is holding.
   */
  reconnect?: { edge: CanvasEdge; end: WireEnd };
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

/** A port press that never moved — Tam's item 4. Carries the port so the caller can put its
 *  menu on it, and the node so the caller knows what to connect the new terminal to. */
export interface PortClick {
  fromId: string;
  side: Side;
  /** Where to open the menu, in client coordinates. */
  x: number;
  y: number;
}

/** What a recognised pointerdown yields: the box to measure screen→world against, and the
 *  half of a `Link` that depends on WHERE the press landed. */
interface Started {
  viewport: HTMLElement;
  link: Pick<Link, 'anchorId' | 'side' | 'from' | 'reconnect'>;
}

type RectOf = (id: string) => Rect | undefined;

/** A press on one of a node's four port dots: draw a NEW wire out of that face. */
function startFromPort(el: Element | null, rectOf: RectOf): Started | null {
  const port = el?.closest('.canvas-port') as HTMLElement | null;
  if (!port) return null;
  const side = port.getAttribute('data-port') as Side | null;
  const anchorId = port.closest('.canvas-node')?.getAttribute('data-terminal-id');
  const viewport = port.closest('.canvas-viewport') as HTMLElement | null;
  if (!side || !anchorId || !viewport) return null;
  const rect = rectOf(anchorId);
  if (!rect) return null;
  return { viewport, link: { anchorId, side, from: portPoint(rect, side) } };
}

/**
 * A press on one of a SELECTED wire's two endpoint handles: move that end somewhere else.
 *
 * The gesture then behaves exactly like drawing a new wire out of the OTHER end — which is why
 * it can share everything below rather than being a second drag implementation. All this has to
 * establish is which node the wire is pivoting about.
 */
function startFromHandle(
  el: Element | null,
  edges: readonly CanvasEdge[],
  rectOf: RectOf,
): Started | null {
  const handle = el?.closest('.canvas-wire-handle');
  if (!handle) return null;
  const edgeId = handle.getAttribute('data-edge-id');
  const end = handle.getAttribute('data-end') as WireEnd | null;
  const viewport = handle.closest('.canvas-viewport') as HTMLElement | null;
  if (!edgeId || (end !== 'from' && end !== 'to') || !viewport) return null;
  const edge = edges.find((x) => x.id === edgeId);
  if (!edge) return null;
  const anchor = rectOf(anchorOf(edge, end));
  // The rect of the end being MOVED is needed too, and only for the departure face: starting
  // the ghost anywhere but where the wire already leaves the anchor makes the drag begin with
  // the wire snapping to a different side of the node the user did not touch.
  const moving = rectOf(end === 'from' ? edge.from : edge.to);
  if (!anchor || !moving) return null;
  const [side] = pickSides(anchor, moving);
  return {
    viewport,
    link: { anchorId: anchorOf(edge, end), side, from: portPoint(anchor, side), reconnect: { edge, end } },
  };
}

/**
 * @param rects Every node's DRAWN box, keyed by terminal id — the same map `CanvasWires` is
 *   given. Passed rather than derived from the model on purpose: a node draws shorter than its
 *   layout rect above zoom 1, so a hook that read `model.nodes[].rect` would start its ghost
 *   at a different point from the wire the drop creates, and the wire would jump on release.
 */
export function useWireDrag(
  rects: Record<string, Rect>,
  onPortClick?: (click: PortClick) => void,
): WireDragState {
  const dispatch = useDispatch();
  const vp = useSelector((s: RootState) => s.canvas.viewport);
  // Read here rather than passed in: a re-endpoint drag starts from a handle that carries only
  // an edge id, and this hook is the only thing that has to turn that back into the row.
  const edges = useSelector((s: RootState) => s.canvas.edges);

  // Read through a ref for the reason the model and viewport are: the pointerup listener below
  // is registered once, and re-registering it whenever the callback identity changed would
  // drop a release mid-gesture.
  const onPortClickRef = useRef(onPortClick);
  onPortClickRef.current = onPortClick;

  const link = useRef<Link | null>(null);
  const [ghost, setGhost] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);

  // Read through a ref inside listeners registered once — see `useCanvasDrag`.
  const latest = useRef({ rects, vp, edges });
  latest.current = { rects, vp, edges };

  const rectOf = (id: string) => latest.current.rects[id];

  const onPointerDownCapture = useCallback((e: React.PointerEvent) => {
    const el = e.target as Element | null;
    // Both gestures below are the same drag with a different starting point, so they share one
    // capture handler and one `Link`. The handle is tested FIRST: it is drawn above the nodes
    // and their ports, so an overlapping port must not steal a press aimed at an endpoint.
    const started = startFromHandle(el, latest.current.edges, rectOf)
      ?? startFromPort(el, rectOf);
    if (!started) return;

    // Capture, and stop: this press must not also select the node, start a header drag or reach
    // the viewport's pan. It is its own gesture in design §5's table.
    e.preventDefault();
    e.stopPropagation();

    const box = started.viewport.getBoundingClientRect();
    link.current = {
      ...started.link,
      rect: { left: box.left, top: box.top },
      origin: { x: e.clientX, y: e.clientY },
      moved: false,
    };
    // `linking` is NOT set here any more: it reveals every node's ports as candidate targets,
    // which is feedback for a drag and a flash of visual noise for a click. It arms on the
    // first move past the slop instead, along with the ghost.
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
      // Below the slop this press is still a candidate click: no ghost, no target highlight,
      // no revealed ports. Once past it, it is a drag for good — `moved` never goes back, so a
      // drag that happens to return to its origin does not turn into a click on release.
      if (!l.moved) {
        if (!exceedsDragSlop(e.clientX - l.origin.x, e.clientY - l.origin.y)) return;
        l.moved = true;
        setLinking(true);
      }
      const { vp: v } = latest.current;
      const over = linkTargetId(terminalIdAt(e.clientX, e.clientY), l.anchorId);
      setTargetId(over);

      const target = over ? rectOf(over) : undefined;
      const source = rectOf(l.anchorId);
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

      // A press that never travelled is a CLICK on the port: offer a shell profile and create
      // a terminal already connected to this one (item 4). It cannot also be a drop — the
      // pointer is still over the source node's own port, and `linkTargetId` refuses an edge
      // from a node to itself — so this returns rather than falling through.
      //
      // A click on an endpoint HANDLE is not that gesture and is not any gesture: the wire is
      // already selected, which is what put the handle on screen, so the press has nothing left
      // to say. Spawning a terminal there would be a shell profile menu opening because someone
      // tapped a connection they had just selected.
      if (!l.moved) {
        if (!l.reconnect) {
          onPortClickRef.current?.({ fromId: l.anchorId, side: l.side, x: e.clientX, y: e.clientY });
        }
        return;
      }

      const to = linkTargetId(terminalIdAt(e.clientX, e.clientY), l.anchorId);
      if (!to) return;

      if (l.reconnect) {
        const { edge, end } = l.reconnect;
        const pair = reconnectPair(edge, end, to);
        // Dropped back where it started, or on the node at the other end. Neither is a failure,
        // and neither may cost the user the connection they were holding.
        if (!pair) return;
        void reconnectEdge(edge, pair.from, pair.to).then((done) => {
          if (!done) return;
          // Only what the SERVER agreed to. A delete that failed leaves the old wire in the
          // mirror, where it belongs: it is still stored, and hiding it here would make it
          // reappear on the next restart with nothing to explain it.
          if (done.removedId) dispatch(removeEdge(done.removedId));
          dispatch(addEdge(done.edge));
          // The selection follows the wire the user is still holding — otherwise the handles
          // vanish mid-adjustment and a second nudge needs a fresh click.
          dispatch(selectEdge(done.edge.id));
        });
        return;
      }

      // Dispatch ONLY the row the server returns. The id is minted server-side and is the only
      // one a later delete or label edit can name; an optimistic client id is never replaced,
      // so the delete would target something that does not exist and leave the real edge
      // behind. A duplicate pair comes back as the EXISTING row, which is the id we want.
      void createEdge(l.anchorId, to).then((edge) => {
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
