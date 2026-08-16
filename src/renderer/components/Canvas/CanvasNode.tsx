import React from 'react';
import { LodTier, CHIP_H, HEAD_H, HOST_W, headScale, chromeScale } from './canvasGeometry';
import { CanvasNodeModel, chipFontSize } from './canvasSelectors';

/**
 * One terminal on the canvas.
 *
 * **This component's structure is permanent for the whole canvas session.** It never
 * returns `null`, never conditionally unmounts `.canvas-node-body`, and is never
 * hidden with `display:none`. That is a hard requirement, not a style:
 *
 * - Task 9 mounts the live terminal host INSIDE `.canvas-node-body`. Unmounting the
 *   node — on a pan, on a zoom past a tier threshold — would relocate `term.element`
 *   at gesture frequency, SIGWINCHing every ratatui/codex PTY on the canvas, each of
 *   which can answer with `ESC[2J ESC[3J` and wipe its scrollback
 *   (design 010 §4.4, `012` §6.5 RC1/RC4).
 * - Under a `display:none` ancestor, `FitAddon.proposeDimensions()` does not error —
 *   it resolves a percentage to the literal `"100%"`, `parseInt`s it to `100`, and
 *   returns a plausible, wrong `{cols:12, rows:6}`. Three `fit()` call sites are
 *   unguarded against that (`012` §6.5 RC3 / H10).
 *
 * So culling and tier demotion are expressed as `visibility` only, via the `hidden`
 * prop, and the body stays in the tree at every tier.
 */
export const CanvasNode: React.FC<{
  node: CanvasNodeModel;
  tier: LodTier;
  zoom: number;
  selected: boolean;
  focused: boolean;
  dimmed: boolean;
  /** Paint-culled, or below the chip tier. Hides the node — never unmounts it. */
  hidden: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onHeaderPointerDown?: (e: React.PointerEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onChipClick?: () => void;
  /** Leave the canvas for this terminal's own tab. */
  onOpenAsTab?: () => void;
  /** Enlarge this node to a near-full-screen overlay, without leaving the canvas. */
  onOpenOverlay?: () => void;
  /** True while this node IS the overlay. Swaps the enlarge control for a close one and
   *  suppresses the chip/fly-to gestures, which make no sense on something already filling
   *  the screen. */
  overlaid?: boolean;
  children?: React.ReactNode;
}> = ({
  node, tier, zoom, selected, focused, dimmed, hidden,
  onPointerDown, onHeaderPointerDown, onDoubleClick, onChipClick, onOpenAsTab, onOpenOverlay,
  overlaid, children,
}) => {
  const isChip = tier === 'chip' && !overlaid;
  const { x, y, w, h } = node.rect;

  // The title bar stops growing once it has reached its natural size — see `headScale`.
  // Above zoom 1 it counter-scales, so the header holds a constant HEAD_H on screen and every
  // pixel the zoom adds goes to the terminal instead of to the word "PowerShell".
  const k = headScale(zoom);
  const headH = HEAD_H * k;
  // The body stays EXACTLY `h - HEAD_H` tall at every zoom, which is what lets the surface
  // scale into it by width with no letterboxing. The node's own height gives up the header's
  // slack instead.
  const nodeH = (h - HEAD_H) + headH;

  return (
    <div
      className={[
        'canvas-node',
        selected ? 'selected' : '',
        focused ? 'focused' : '',
        dimmed ? 'dimmed' : '',
        overlaid ? 'overlaid' : '',
        node.isRunning ? 'running' : '',
      ].filter(Boolean).join(' ')}
      data-terminal-id={node.terminalId}
      data-tab-id={node.tabId}
      data-lod={tier}
      // `visibility`, never `display` — see the note above.
      style={{
        left: x,
        top: y,
        width: w,
        height: isChip ? CHIP_H : nodeH,
        visibility: hidden ? 'hidden' : undefined,
        // Per node rather than global, so a node of any width scales its host correctly.
        // This is the whole of the overlay's implementation: an overlaid node is a node with
        // a big world rect, and this line is what puts its terminal at screen scale 1.
        ['--node-surface-scale' as string]: `${w / HOST_W}`,
        // The title bar's counter-scale: capped at 1, so a small node's label still grows
        // with it. Also drives the corner radius, which follows the header's corners.
        ['--node-k' as string]: `${k}`,
        // The FRAME's counter-scale: uncapped, so the outline and the connector ports are one
        // screen pixel and 13 screen pixels at EVERY zoom. A hairline is a hairline whether
        // the node is 96 pixels wide or 1440.
        ['--node-chrome-k' as string]: `${chromeScale(zoom)}`,
      } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onClick={isChip ? onChipClick : undefined}
      onDoubleClick={isChip || overlaid ? undefined : onDoubleClick}
    >
      <div
        className="canvas-node-head"
        style={isChip ? undefined : { height: headH }}
        onPointerDown={onHeaderPointerDown}
      >
        {/* The header's contents are drawn at their natural size and scaled as ONE element.
            Scaling each of them — title, badge, buttons, padding, gap — would be six numbers
            that have to be kept in step, and the first one forgotten is the one that looks
            wrong. `width` is inflated by 1/k so that scaling it back lands on 100%. */}
        <div
          className="canvas-node-head-inner"
          style={isChip
            ? { fontSize: chipFontSize(zoom) }
            : { height: HEAD_H, width: `${100 / k}%`, transform: `scale(${k})` }}
        >
          <span className="canvas-node-title">{node.title}</span>
          {!isChip && <span className="canvas-node-shell">{node.shellType}</span>}
          {/* Every handler on these buttons stops propagation, and each one is stopping a
              DIFFERENT gesture the node itself owns: pointerdown selects (and, from Task 12,
              starts a drag), click would bubble to the chip handler, and dblclick flies to
              focus. Leaving any of them un-stopped makes the button do two things at once. */}
          {!isChip && onOpenOverlay && (
            <button
              type="button"
              className="canvas-node-open"
              title={overlaid ? 'Shrink back to the canvas' : 'Enlarge on the canvas'}
              aria-label={overlaid ? `Shrink ${node.title}` : `Enlarge ${node.title} on the canvas`}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onOpenOverlay(); }}
            >
              {overlaid ? '✕' : '⛶'}
            </button>
          )}
          {!isChip && onOpenAsTab && (
            <button
              type="button"
              className="canvas-node-open"
              title="Open in its tab"
              aria-label={`Open ${node.title} in its tab`}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onOpenAsTab(); }}
            >
              ⧉
            </button>
          )}
        </div>
      </div>
      <div className="canvas-node-body">{children}</div>
      <span className="canvas-port n" data-port="n" />
      <span className="canvas-port e" data-port="e" />
      <span className="canvas-port s" data-port="s" />
      <span className="canvas-port w" data-port="w" />
    </div>
  );
};

export default CanvasNode;
