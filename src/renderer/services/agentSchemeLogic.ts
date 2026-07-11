/** One terminal's foreground-agent snapshot, distilled from GET /api/processes. */
export interface ProcSnapshot {
  terminalId: string;
  agent: string | null;
  lastInputSource: 'user' | 'api' | null;
  lastInputAt: number | null;
}

/**
 * Compute the new per-terminal EFFECTIVE agent map. Only agents that have a
 * color mapping (`mappedAgents`) ever produce an entry — an unmapped agent
 * yields no override. Per terminal present in `snapshots`:
 *
 *  - a mapped agent is currently running          → effective = that agent
 *  - was effective before, now gone:
 *      - last write was `api`                     → keep sticky (API/MCP is driving it)
 *      - otherwise                                → drop (user ended it → revert)
 *  - never mapped/effective                       → absent
 *
 * Stickiness keys off the LAST-WRITER source, not a time window: while API/MCP is
 * the last thing that wrote to the terminal it stays sticky (even for a long task
 * that exits minutes after its prompt); the moment the user types, the source
 * flips to `user` and the next poll reverts. This matches "don't revert when
 * API/MCP ended the agent" without wrongly reverting long-running API tasks.
 *
 * Terminals absent from `snapshots` (pane closed, or owned by another window)
 * are dropped. Pure: returns a new Map, never mutates `prev`.
 */
export function computeEffectiveAgents(
  snapshots: ProcSnapshot[],
  prev: Map<string, string>,
  mappedAgents: Set<string>,
  _now: number, // retained for call-site stability; last-writer logic no longer time-gates
): Map<string, string> {
  const next = new Map<string, string>();
  for (const s of snapshots) {
    if (s.agent && mappedAgents.has(s.agent)) {
      next.set(s.terminalId, s.agent);
      continue;
    }
    const wasAgent = prev.get(s.terminalId);
    if (!wasAgent) continue; // never had an override → nothing to keep
    // Only keep an override that still has a mapping — if the user removed the
    // mapping, there's nothing to be sticky about, so drop it and revert.
    if (!mappedAgents.has(wasAgent)) continue;
    if (s.lastInputSource === 'api') next.set(s.terminalId, wasAgent); // sticky
    // else (user / unknown): drop → the pane reverts to its tab/default scheme
  }
  return next;
}
