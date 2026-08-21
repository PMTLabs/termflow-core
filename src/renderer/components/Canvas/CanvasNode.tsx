import React from 'react';
import { LodTier, HEAD_H, headScale, headFontSize, paintedNodeH, surfaceShift } from './canvasGeometry';
import { useCanvasMetrics } from './canvasMetricsContext';
import { CanvasNodeModel, chipFontSize } from './canvasSelectors';
import { CanvasNodeAgent } from './CanvasNodeAgent';
import type { CanvasBusyCue } from './canvasBusyCue';

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
 * So culling and tier demotion are expressed as `visibility` — plus
 * `content-visibility: hidden`, which is what makes the hiding actually stop WORK — via
 * the `hidden` prop, and the body stays in the tree at every tier.
 *
 * `visibility` alone hides pixels without pausing anything: the node still intersects the
 * viewport, so xterm's RenderService keeps rendering into a node nobody can see. That is
 * invisible for a CULLED node (off-screen, so it stops intersecting and pauses by itself)
 * but not for the two on-screen cases `isHidden` also covers — a whole-canvas collapse,
 * and the `group` tier. `content-visibility` skips the subtree while keeping its layout
 * box, so it buys the pause without the `display:none` hazard above.
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
  /** Which busy cue this node draws while `node.isRunning` — the user's `canvasBusyCue`
   *  setting (`plan/023`). Read ONCE by `CanvasMode` and threaded down, rather than with a
   *  `useSelector` here: that would be one store subscription per node, on a surface whose
   *  whole design is "many nodes at once".
   *
   *  REQUIRED on purpose. A default here would keep a future second render site compiling
   *  while it silently drew no cue at all — the failure would be a node that never says it
   *  is busy, which looks exactly like a node that isn't. */
  busyCue: CanvasBusyCue;
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
  node, tier, zoom, selected, focused, dimmed, linkTarget, hidden, busyCue,
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
  //
  // Taken from `paintedNodeH` rather than written out here, because the group frame and every
  // wire endpoint now ask that function where this node ends. Restating the arithmetic is how
  // they drift, and the drift is invisible: a frame with a dead band under it and a wire
  // starting below the node still look like a spacing preference rather than a bug.
  const nodeH = paintedNodeH(h, zoom, isChip);

  return (
    <div
      className={[
        'canvas-node',
        selected ? 'selected' : '',
        focused ? 'focused' : '',
        dimmed ? 'dimmed' : '',
        linkTarget ? 'link-target' : '',
        overlaid ? 'overlaid' : '',
        // `running` is conditional on MORE than `node.isRunning` — it is the sweep cue's own
        // existence (`plan/023`), so a busy node in `dot` mode deliberately does not carry it.
        // The dot below is the mirror of this: exactly one of the two is ever in the DOM, and
        // neither is rendered-then-hidden, so "which cue is this node showing?" stays a
        // question the DOM can answer. The sidebar is untouched by the setting and keeps its
        // own `.running`, because there the icon renders either way and only an ancestor
        // selector can blink it.
        busyCue === 'sweep' && node.isRunning ? 'running' : '',
      ].filter(Boolean).join(' ')}
      data-terminal-id={node.terminalId}
      data-tab-id={node.tabId}
      data-lod={tier}
      // `visibility`, never `display` — see the note above.
      style={{
        left: x,
        top: y,
        width: w,
        height: nodeH,
        visibility: hidden ? 'hidden' : undefined,
        // Pairs with the line above — see the note at the top of this file. Kept on the
        // NODE rather than the surface because the two on-screen cases `isHidden` covers
        // (whole-canvas collapse, `group` tier) hide the whole node, chrome included.
        contentVisibility: hidden ? 'hidden' : undefined,
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
        // The scale above fits by WIDTH, so a portrait pane's replica is taller than the body
        // and the body clips the overflow off the bottom — where the newest rows are. This
        // lifts it back (`plan/020` §1). Zero whenever the surface already fits, and provably
        // zero in the overlay, whose `h` is `hostH * w / hostW + HEAD_H` by construction.
        ['--node-surface-shift' as string]: `${surfaceShift(host, w, h - HEAD_H)}px`,
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
          {/* The `dot` cue (`plan/020` §3 Req 7, reshaped by `plan/023`). Cheap enough to
              animate on every node at once, and — unlike the sweep — a permanent status light:
              it renders whether or not the terminal is busy, muted and static while idle, and
              carries `.running` only while it is working. So here the CLASS is the running
              state and the ELEMENT is the cue setting, which is why both are mutation-checkable
              (hard-code either one and a test fails).

              Still nothing at the chip tier: there the header IS the node and there is room for
              a title and nothing else. That leaves a collapsed tile with no cue in `dot` mode —
              a real gap, and the reason `sweep` is the default. It is stated in the Settings
              help text rather than left to be discovered. */}
          {!isChip && busyCue === 'dot' && (
            <span className={node.isRunning ? 'canvas-node-dot running' : 'canvas-node-dot'} />
          )}
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
