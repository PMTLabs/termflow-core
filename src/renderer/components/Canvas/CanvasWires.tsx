import React from 'react';
import { Rect } from './canvasGeometry';
import { CanvasEdge } from '../../store/slices/canvasSlice';
import { pickSides, portPoint, wirePath, wireMidpoint, edgeHeat } from './wireGeometry';

/**
 * Connection wires — `plan/013` Task 18, design 010 §4.6.
 *
 * **Each wire is drawn twice.** The under-layer sits below the nodes at full strength and is
 * naturally occluded wherever it crosses one; the over-layer is masked to the node shapes and
 * painted at 30%, so the segment crossing a terminal reads as a ghost instead of a stripe
 * through the user's output. Neither layer takes pointer events; the hit targets are separate
 * transparent paths (see `.canvas-wire-hit`).
 */

/** The mask's coordinate space. Wide enough that no realistic layout leaves it. */
const WORLD = 40000;
/** Origin offset, so a node dragged into negative world space is still inside the mask. */
const ORIGIN = -WORLD / 2;

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
  onWireContextMenu?: (edge: CanvasEdge, e: React.MouseEvent) => void;
}

interface DrawnWire {
  key: string;
  edge: CanvasEdge;
  d: string;
  cls: string;
  /** Where a label sits, when the edge has one. */
  mid: [number, number];
}

export function drawnWires(
  edges: CanvasEdge[],
  rects: Record<string, Rect>,
  hoveredId: string | null,
): DrawnWire[] {
  const out: DrawnWire[] = [];
  for (const e of edges) {
    const a = rects[e.from];
    const b = rects[e.to];
    if (!a || !b) continue;
    const [s1, s2] = pickSides(a, b);
    const heat = edgeHeat(e, hoveredId);
    const p1 = portPoint(a, s1);
    const p2 = portPoint(b, s2);
    out.push({
      key: e.id,
      edge: e,
      d: wirePath(p1, p2, s1, s2),
      mid: wireMidpoint(p1, p2, s1, s2),
      cls: ['canvas-wire', e.origin === 'agent' ? 'agent' : '', heat ?? '']
        .filter(Boolean)
        .join(' '),
    });
  }
  return out;
}

export const CanvasWires: React.FC<CanvasWiresProps> = ({
  edges, rects, masked, hoveredId, onWireContextMenu,
}) => {
  const wires = drawnWires(edges, rects, hoveredId);
  if (!wires.length) return null;

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
        {/* Wide transparent strokes, so a hairline wire is still right-clickable. Their own
            layer rather than a `pointer-events` on the visible paths: the stroke a user can hit
            has to be far wider than the one they can see. */}
        {onWireContextMenu && wires.map((w) => (
          <path
            key={`hit-${w.key}`}
            d={w.d}
            className="canvas-wire-hit"
            onContextMenu={(e) => onWireContextMenu(w.edge, e)}
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
            y={w.mid[1]}
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
    </>
  );
};

export default CanvasWires;
