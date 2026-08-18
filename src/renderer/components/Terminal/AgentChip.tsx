import React from 'react';
import { useDetectedAgent } from './useDetectedAgent';
import './AgentChip.css';

interface AgentChipProps {
  terminalId: string;
}

/**
 * A small floating pill in the pane's top-right corner naming the coding-agent CLI
 * detected in this pane (codex/claude/agy/…), so the user can tell at a glance which
 * agent is running where. Hidden when no agent is detected — a plain shell, or after
 * the agent exits (detection clears within one tracker poll). Purely informational:
 * pointer-events are disabled so it never intercepts terminal selection/clicks.
 *
 * Detection and icon resolution live in `useDetectedAgent`, shared with Canvas Mode's
 * node-header chip (`CanvasNodeAgent`) — the two look nothing alike and answer the same
 * question. When the foreground exe is known we show its real binary icon (Phase 2,
 * backlog 016), falling back to a running-dot when no icon is available (non-Windows
 * without a themed icon, a protected process, or extraction failure).
 */
export const AgentChip: React.FC<AgentChipProps> = ({ terminalId }) => {
  const { agent, icon } = useDetectedAgent(terminalId);

  if (!agent) return null;

  return (
    <div className="agent-chip" title={`Agent running: ${agent}`} aria-label={`Agent running: ${agent}`}>
      {icon ? (
        <img className="agent-chip-icon" src={icon} alt="" aria-hidden="true" />
      ) : (
        <span className="agent-chip-dot" aria-hidden="true" />
      )}
      <span className="agent-chip-label">{agent}</span>
    </div>
  );
};
