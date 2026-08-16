import React from 'react';
import { LodTier, CHIP_H } from './canvasGeometry';
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
  onChipClick?: () => void;
  children?: React.ReactNode;
}> = ({
  node, tier, zoom, selected, focused, dimmed, hidden,
  onPointerDown, onHeaderPointerDown, onChipClick, children,
}) => {
  const isChip = tier === 'chip';
  const { x, y, w, h } = node.rect;

  return (
    <div
      className={[
        'canvas-node',
        selected ? 'selected' : '',
        focused ? 'focused' : '',
        dimmed ? 'dimmed' : '',
        node.isRunning ? 'running' : '',
      ].filter(Boolean).join(' ')}
      data-terminal-id={node.terminalId}
      data-tab-id={node.tabId}
      data-lod={tier}
      // `visibility`, never `display` — see the note above.
      style={{ left: x, top: y, width: w, height: isChip ? CHIP_H : h, visibility: hidden ? 'hidden' : undefined }}
      onPointerDown={onPointerDown}
      onClick={isChip ? onChipClick : undefined}
    >
      <div
        className="canvas-node-head"
        style={isChip ? { fontSize: chipFontSize(zoom) } : undefined}
        onPointerDown={onHeaderPointerDown}
      >
        <span className="canvas-node-title">{node.title}</span>
        {!isChip && <span className="canvas-node-shell">{node.shellType}</span>}
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
