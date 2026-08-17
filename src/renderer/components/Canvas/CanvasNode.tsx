import React from 'react';
import { LodTier, CHIP_H, HEAD_H, headScale, headFontSize } from './canvasGeometry';
import { useCanvasMetrics } from './canvasMetricsContext';
import { CanvasNodeModel, chipFontSize } from './canvasSelectors';
import { CanvasNodeAgent } from './CanvasNodeAgent';

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
  /** A link drag is in flight and would land here. Purely feedback — the drop itself is
   *  decided by `linkTargetId`, so the highlight and the effect share one rule. */
  linkTarget?: boolean;
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
  /** Close this terminal. Routed through the app's existing pane/tab close flows — see
   *  `canvasClose.ts` — so the canvas never tears a PTY down itself. */
  onClose?: () => void;
  /** Right-click anywhere on the node. */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** True while this node IS the overlay. Swaps the enlarge control for a close one and
   *  suppresses the chip/fly-to gestures, which make no sense on something already filling
   *  the screen. */
  overlaid?: boolean;
  /** This terminal's own host box, measured from its pane before the canvas took it
   *  (`plan/017`). Omitted only by tests and by a terminal with nothing to measure. */
  hostBox?: { w: number; h: number };
  children?: React.ReactNode;
}> = ({
  node, tier, zoom, selected, focused, dimmed, linkTarget, hidden,
  onPointerDown, onHeaderPointerDown, onDoubleClick, onChipClick, onOpenAsTab, onOpenOverlay,
  onClose, onContextMenu, overlaid, hostBox, children,
}) => {
  const isChip = tier === 'chip' && !overlaid;
  const { x, y, w, h } = node.rect;
  // THIS TERMINAL's host box (`plan/017`) — a pixel replica of the pane it came from, so the
  // relocation fit measures an identical container and takes FitAddon's early return instead of
  // resizing the PTY. Falls back to the session box, which is what a terminal with no rendered
  // element to copy gets. Passed in rather than measured here: the measurement is only valid
  // during CanvasMode's render, BEFORE this component's ref callback registers the host that
  // `term.element` is about to move into. See `canvasHostBoxes.measureHostBox`.
  const fallback = useCanvasMetrics();
  const host = hostBox ?? { w: fallback.hostW, h: fallback.hostH };

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
        linkTarget ? 'link-target' : '',
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
        // The host's CSS box, per node. It is a replica of this terminal's PANE box, which is
        // what makes the relocation fit find the same cols/rows it already had (`plan/017`).
        // These must be real pixel lengths and must never be a percentage of the node: the body
        // collapses at the chip tier, and a percentage host would then resize a live PTY on a
        // zoom-out (`012` §6.5 RC2).
        ['--node-host-w' as string]: `${host.w}px`,
        ['--node-host-h' as string]: `${host.h}px`,
        // Per node rather than global, so a node of any width scales its host correctly.
        // This is the whole of the overlay's implementation: an overlaid node is a node with
        // a big world rect, and this line is what puts its terminal at screen scale 1.
        ['--node-surface-scale' as string]: `${w / host.w}`,
      } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onClick={isChip ? onChipClick : undefined}
      onDoubleClick={isChip || overlaid ? undefined : onDoubleClick}
      onContextMenu={onContextMenu}
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
            : {
                height: HEAD_H,
                width: `${100 / k}%`,
                transform: `scale(${k})`,
                // Floored so the title stays readable across the live and snapshot tiers —
                // `headScale`'s growth is capped by the frame's padding, so the bar alone
                // cannot hold the glyph up all the way down. Overrides the 12px in Canvas.css,
                // which stays as the natural size and the fallback.
                fontSize: headFontSize(zoom),
              }}
        >
          <span className="canvas-node-title">{node.title}</span>
          {/* Before the shell badge, because it is the one that changes and the one being
              looked for. Both are suppressed at the chip tier, where the header IS the node
              and there is room for a title and nothing else. */}
          {!isChip && <CanvasNodeAgent terminalId={node.terminalId} />}
          {!isChip && <span className="canvas-node-shell">{node.shellType}</span>}
          {/* Every handler on these buttons stops propagation, and each one is stopping a
              DIFFERENT gesture the node itself owns: pointerdown selects (and, from Task 12,
              starts a drag), click would bubble to the chip handler, and dblclick flies to
              focus. Leaving any of them un-stopped makes the button do two things at once. */}
          {!isChip && onOpenOverlay && (
            <button
              type="button"
              className="canvas-node-open"
              // Both hotkeys are named here because neither is discoverable: `E` is a bare
              // letter, and the chord that shrinks it back is pressed from inside a terminal
              // that is covering the whole screen — with the button itself hidden behind it.
              title={overlaid ? 'Shrink back to the canvas (Ctrl+Shift+E)' : 'Enlarge on the canvas (E)'}
              aria-label={overlaid ? `Shrink ${node.title}` : `Enlarge ${node.title} on the canvas`}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onOpenOverlay(); }}
            >
              {/* NOT `✕` when overlaid, which is what shipped first. ✕ is the universal close
                  glyph, so the control that shrank a node back to the canvas read as the one
                  that killed its shell — and with a real close button now sitting beside it,
                  the two would have been the same character doing different things. This
                  toggles a size, so both faces of it are sizing glyphs. */}
              {overlaid ? '⤡' : '⛶'}
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
          {/* Last, so it is the top-RIGHT control Tam asked for, and so the destructive one is
              not where a finger lands reaching for either of the two above it. */}
          {!isChip && onClose && (
            <button
              type="button"
              className="canvas-node-open canvas-node-close"
              title="Close terminal"
              aria-label={`Close ${node.title}`}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onClose(); }}
            >
              ✕
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
