import React from 'react';
import { useDetectedAgent } from '../Terminal/useDetectedAgent';

/**
 * The agent/CLI chip in a canvas node's title bar — Tam's item 6.
 *
 * The pane already has one (`AgentChip`), but it is a pill absolutely positioned over the
 * terminal's own content, and on the canvas that content is not where the chip would be: Canvas
 * Mode relocates `term.element` into a node host, while `TerminalPane` — and therefore its chip
 * — stays behind in the background tab. So the canvas showed no agent anywhere.
 *
 * It sits beside `.canvas-node-shell` rather than floating, for the same reason that one does:
 * the node body is a live terminal scaled into a small box, and anything overlaid on it covers
 * text the user is trying to read at a size where every line counts.
 *
 * **This is a different fact from `shellType`.** The shell is what the pane was launched as and
 * never changes; the agent is what is running in it right now, appears when `claude` starts and
 * clears within one tracker poll when it exits. Showing only the shell answered "pwsh" for
 * every node on a canvas full of agents, which is exactly the question the canvas exists to
 * answer at a glance.
 *
 * Renders nothing for a plain shell — an empty chip on every node would cost the title bar its
 * width and say less than the space it took.
 */
const CanvasNodeAgentImpl: React.FC<{ terminalId: string }> = ({ terminalId }) => {
  const { agent, icon } = useDetectedAgent(terminalId);

  if (!agent) return null;

  return (
    <span className="canvas-node-agent" title={`Agent running: ${agent}`}>
      {icon && <img className="canvas-node-agent-icon" src={icon} alt="" aria-hidden="true" />}
      <span className="canvas-node-agent-label">{agent}</span>
    </span>
  );
};

/**
 * Memoised, and the props are why it can be.
 *
 * Canvas Mode re-renders on every frame of a pan or zoom — `setViewport` fires per pointer
 * event — and without this every node's agent-detection subscription re-ran with it, for the whole workspace
 * including the nodes culled off screen. The props here are primitives, so the equality
 * check is exact and cheap; `CanvasNode` itself is deliberately NOT memoised, because it
 * takes `children` and seven per-node closures that are rebuilt each render, and a memo
 * that never bails is only a slower render.
 */
export const CanvasNodeAgent = React.memo(CanvasNodeAgentImpl);

export default CanvasNodeAgent;
