import { useEffect, useState } from 'react';
import { agentSchemeTracker } from '../../services/AgentSchemeTracker';
import { getAgentIcon } from '../../services/agentIconService';

export interface DetectedAgent {
  /** The agent CLI detected in this terminal (codex/claude/agy/…), or null for a plain shell. */
  agent: string | null;
  /** Its binary's icon as a data URL, or null while resolving or when none is available. */
  icon: string | null;
}

/**
 * Which coding-agent CLI is running in a terminal, kept in step with the tracker.
 *
 * Extracted from `AgentChip` when Canvas Mode needed the same answer in a different shape.
 * The pane's chip is a pill floating over the terminal; the canvas node's is a chip in a
 * 29-px title bar — nothing about the markup is shared, and everything about getting the
 * value is:
 *
 *  - the tracker's subscription fires only when a DETECTED agent or its exe path changes,
 *    not on every poll, so a re-render means something actually moved;
 *  - `sync()` runs when the effect does, not only on notify. The FIRST mount is covered by
 *    `useState`'s lazy initializer; what this catches is `terminalId` changing under a hook
 *    that is already mounted, where the initializer will never run again and the chip would
 *    keep naming the previous terminal's agent until the tracker next polls;
 *  - the icon resets to null before each resolve, so a stale icon never sits next to a new
 *    agent's name, and `alive` drops a resolve that lands after the agent changed or the
 *    component went away.
 *
 * Each of those three is a bug someone already had. Duplicating the hook would have meant
 * having them again, in the copy.
 */
export function useDetectedAgent(terminalId: string): DetectedAgent {
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
    sync(); // reconcile immediately on mount / when the terminalId changes
    return agentSchemeTracker.subscribe(sync);
  }, [terminalId]);

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

  return { agent, icon };
}
