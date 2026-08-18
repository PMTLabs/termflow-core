import React from 'react';
import { Rect } from './canvasGeometry';
import { CanvasEdge } from '../../store/slices/canvasSlice';
import { WireEnds, wireEnds, wirePath, wireMidpoint, edgeHeat } from './wireGeometry';

/**
 * Connection wires — `plan/013` Task 18, design 010 §4.6.
 *
 * **Each wire is drawn twice.** The under-layer sits below the nodes at full strength and is
 * naturally occluded wherever it crosses one; the over-layer is masked to the node shapes and
 * painted at 30%, so the segment crossing a terminal reads as a ghost instead of a stripe
 * through the user's output. Neither layer takes pointer events; the hit targets are separate
 * transparent paths (see `.canvas-wire-hit`).
 *
 * A third layer appears only for the SELECTED wire, and it has to be a third: its endpoint
 * handles sit exactly on a node's border, so anything drawn under the nodes would be half
 * covered by the node it is attached to — and a grab target you can only hit half of is the
 * kind of control people decide is broken.
 */

/** The mask's coordinate space. Wide enough that no realistic layout leaves it. */
const WORLD = 40000;
/** Origin offset, so a node dragged into negative world space is still inside the mask. */
const ORIGIN = -WORLD / 2;

/**
 * The selected wire's furniture, authored in SCREEN pixels.
 *
 * Everything in this file is world-space, so these are drawn inside a `scale(k)` where `k` is
 * the chrome counter-scale — the same `1/z` that keeps a wire a hairline and a node header
 * legible at every zoom. A handle sized in world units would be a dot at one end of the zoom
 * range and a plate at the other.
 */
const HANDLE_R = 7;
const BADGE_R = 9;
/** How far the label steps aside for the delete badge that takes its place at the midpoint. */
const LABEL_LIFT = 20;

export interface CanvasWiresProps {
  edges: CanvasEdge[];
  /**
   * Every node's world rect — including nodes that are culled or off screen.
   *
   * **Not the same set as `masked`, and the difference is deliberate.** A wire is geometry
   * between two points; dropping the ones whose endpoint is currently culled would make wires
   * vanish and reappear as the canvas pans, and a connection running off the edge of the screen
   * is exactly the thing the user needs to see to know it is there.
   */
  rects: Record<string, Rect>;
  /**
   * The nodes that actually PAINT. Only these punch holes in the mask.
   *
   * `plan/013` fed one `rects` prop to both jobs while its prose stated this rule, which cannot
   * hold for both at once: a mask rect for a node that is hidden shows the 30% ghost over open
   * canvas, where the under-layer is already drawing the wire at full strength — a bright
   * rectangle floating in empty space, in the shape of a node that is not there.
   */
  masked: Record<string, Rect>;
  /** The hovered node, or null for "no hover focus". */
  hoveredId: string | null;
  /** The selected connection, or null. Only this one shows handles and a delete badge. */
  selectedEdgeId?: string | null;
  /** `chromeScale(zoom)`. World units per screen pixel — see the note on `HANDLE_R`. */
  chromeK?: number;
  onWireClick?: (edge: CanvasEdge) => void;
  onWireDelete?: (edge: CanvasEdge) => void;
  onWireContextMenu?: (edge: CanvasEdge, e: React.MouseEvent) => void;
}

interface DrawnWire {
  key: string;
  edge: CanvasEdge;
  d: string;
  cls: string;
  /** Where a label sits, when the edge has one. */
  mid: [number, number];
  /** The two points the wire runs between — where its endpoint handles go. */
  ends: WireEnds;
  selected: boolean;
}

export function drawnWires(
  edges: CanvasEdge[],
  rects: Record<string, Rect>,
  hoveredId: string | null,
  selectedEdgeId: string | null = null,
): DrawnWire[] {
  const out: DrawnWire[] = [];
  for (const e of edges) {
    const a = rects[e.from];
    const b = rects[e.to];
    if (!a || !b) continue;
    const ends = wireEnds(a, b);
    const { p1, p2, s1, s2 } = ends;
    const heat = edgeHeat(e, hoveredId);
    const selected = e.id === selectedEdgeId;
    out.push({
      key: e.id,
      edge: e,
      ends,
      selected,
      d: wirePath(p1, p2, s1, s2),
      mid: wireMidpoint(p1, p2, s1, s2),
      // Selected LAST, so it survives `cold`: a wire you have picked is not one of the ones
      // the hover focus is dimming, whatever the pointer happens to be over.
      cls: ['canvas-wire', e.origin === 'agent' ? 'agent' : '', heat ?? '', selected ? 'selected' : '']
        .filter(Boolean)
        .join(' '),
    });
  }
  return out;
}

export const CanvasWires: React.FC<CanvasWiresProps> = ({
  edges, rects, masked, hoveredId, selectedEdgeId = null, chromeK = 1,
  onWireClick, onWireDelete, onWireContextMenu,
}) => {
  const wires = drawnWires(edges, rects, hoveredId, selectedEdgeId);
  if (!wires.length) return null;
  const picked = wires.find((w) => w.selected) ?? null;

  const svgProps = {
    width: WORLD,
    height: WORLD,
    viewBox: `${ORIGIN} ${ORIGIN} ${WORLD} ${WORLD}`,
    style: { left: ORIGIN, top: ORIGIN } as React.CSSProperties,
  };

  return (
    <>
      {/* Beneath the nodes: full strength, naturally occluded where it crosses one. */}
      <svg className="canvas-wires under" {...svgProps}>
        {wires.map((w) => <path key={w.key} d={w.d} className={w.cls} />)}
        {/* Wide transparent strokes, so a hairline wire is still clickable. Their own layer
            rather than a `pointer-events` on the visible paths: the stroke a user can hit has
            to be far wider than the one they can see. */}
        {wires.map((w) => (
          <path
            key={`hit-${w.key}`}
            d={w.d}
            className="canvas-wire-hit"
            onClick={() => onWireClick?.(w.edge)}
            onContextMenu={onWireContextMenu ? (e) => onWireContextMenu(w.edge, e) : undefined}
          />
        ))}
        {/* The user-typed label (design 010 D3). On the under-layer, so a node crossing the
            wire also covers the text — a label floating over someone's terminal output is the
            exact thing the two-layer split exists to prevent. */}
        {wires.filter((w) => w.edge.label).map((w) => (
          <text
            key={`label-${w.key}`}
            className={`canvas-wire-label${w.cls.includes('cold') ? ' cold' : ''}`}
            x={w.mid[0]}
            // Selecting a wire puts a delete badge on its midpoint, which is where the label
            // already was. The label steps up rather than the badge stepping aside: the badge
            // is the thing being aimed at, so it keeps the position the eye went to.
            y={w.mid[1] - (w.selected ? LABEL_LIFT * chromeK : 0)}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {w.edge.label}
          </text>
        ))}
      </svg>
      {/* Above the nodes, masked to node shapes: the 30% ghost over a screen. */}
      <svg className="canvas-wires over" {...svgProps} aria-hidden="true">
        <defs>
          <mask
            id="canvas-node-mask"
            maskUnits="userSpaceOnUse"
            x={ORIGIN}
            y={ORIGIN}
            width={WORLD}
            height={WORLD}
          >
            <rect x={ORIGIN} y={ORIGIN} width={WORLD} height={WORLD} fill="#000" />
            {Object.entries(masked).map(([id, r]) => (
              <rect key={id} x={r.x - 1} y={r.y - 1} width={r.w + 2} height={r.h + 2} rx="8" fill="#fff" />
            ))}
          </mask>
        </defs>
        <g mask="url(#canvas-node-mask)" opacity="0.3">
          {wires.map((w) => <path key={w.key} d={w.d} className={w.cls} />)}
        </g>
      </svg>
      {/* The selected wire's controls, above everything the wire can cross. */}
      {picked && (
        <svg className="canvas-wires handles" {...svgProps}>
          {([['from', picked.ends.p1], ['to', picked.ends.p2]] as const).map(([end, p]) => (
            <g key={end} transform={`translate(${p[0]},${p[1]}) scale(${chromeK})`}>
              <circle
                className="canvas-wire-handle"
                data-edge-id={picked.edge.id}
                data-end={end}
                r={HANDLE_R}
              >
                {/* An SVG `<title>` is the only tooltip a shape can carry, and these controls
                    need one: a dot on the end of a line says nothing about being draggable. */}
                <title>Drag to connect this end to another terminal</title>
              </circle>
            </g>
          ))}
          <g transform={`translate(${picked.mid[0]},${picked.mid[1]}) scale(${chromeK})`}>
            {/* Tam: "user can click on the connection line and then delete it if they want."
                Delete and the right-click menu both do this too; a control you can see is what
                makes the other two discoverable rather than trivia. */}
            <g
              className="canvas-wire-badge"
              onClick={() => onWireDelete?.(picked.edge)}
              role="button"
              aria-label="Delete connection"
            >
              <title>Delete connection (Del)</title>
              <circle r={BADGE_R} />
              <path d="M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5" />
            </g>
          </g>
        </svg>
      )}
    </>
  );
};

export default CanvasWires;
