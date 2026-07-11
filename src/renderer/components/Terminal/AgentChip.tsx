import React, { useEffect, useState } from 'react';
import { agentSchemeTracker } from '../../services/AgentSchemeTracker';
import { getAgentIcon } from '../../services/agentIconService';
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
 * Detection comes from AgentSchemeTracker.getDetectedAgentForTerminal; we re-render
 * via the tracker's subscription (fires only when a detected agent or its exe path
 * changes). When the foreground exe is known we show its real binary icon (Phase 2,
 * backlog 016) — falling back to a running-dot when no icon is available (non-Windows
 * without a themed icon, a protected process, or extraction failure).
 */
export const AgentChip: React.FC<AgentChipProps> = ({ terminalId }) => {
  const [agent, setAgent] = useState<string | null>(() =>
    agentSchemeTracker.getDetectedAgentForTerminal(terminalId),
  );
  const [exe, setExe] = useState<string | null>(() =>
    agentSchemeTracker.getDetectedAgentExeForTerminal(terminalId),
  );
  const [icon, setIcon] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      setAgent(agentSchemeTracker.getDetectedAgentForTerminal(terminalId));
      setExe(agentSchemeTracker.getDetectedAgentExeForTerminal(terminalId));
    };
    sync(); // reconcile immediately on mount / when the pane's terminalId changes
    return agentSchemeTracker.subscribe(sync);
  }, [terminalId]);

  // Resolve the icon: a curated override for known agents (keyed by label), else the
  // native binary icon for the exe (cached in the service). Reset to null first so a
  // stale icon never lingers while the new one resolves; a late resolve after the
  // agent/exe changed or the chip unmounted is dropped via `alive`.
  useEffect(() => {
    let alive = true;
    setIcon(null);
    getAgentIcon(exe, agent).then((url) => {
      if (alive) setIcon(url);
    });
    return () => {
      alive = false;
    };
  }, [exe, agent]);

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
