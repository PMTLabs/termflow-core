import { store } from '../store';
import { terminalService } from './TerminalService';
import { computeEffectiveAgents, ProcSnapshot } from './agentSchemeLogic';
import { applyEffectiveThemes, applyActivePaneBackground } from '../store/terminalTheme';

// How often to poll the foreground-agent snapshot. GET /api/processes runs a
// full sysinfo enumeration (50-200ms) so we keep this modest and pause it while
// the window is hidden (see tick()).
const POLL_MS = 2000;

/** Order-independent equality for a terminalId→agent map (chip change detection). */
function sameStringMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Polls GET /api/processes for each owned terminal's foreground coding-agent,
 * maintains the per-terminal EFFECTIVE agent (with user-vs-API/MCP sticky/revert
 * via computeEffectiveAgents), and re-applies the effective color scheme for any
 * terminal whose agent changed. Mirrors RunningActivityTracker's singleton shape.
 */
class AgentSchemeTrackerClass {
  private timer: ReturnType<typeof setInterval> | null = null;
  private effective = new Map<string, string>(); // terminalId → effective agent label
  private detected = new Map<string, string>();  // terminalId → raw detected agent (for menus)
  private detectedExe = new Map<string, string>(); // terminalId → foreground exe path (for icon)
  private current: Promise<void> | null = null;  // the in-flight poll, if any
  private listeners = new Set<() => void>();      // notified when `detected` changes (agent chip)

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.effective.clear();
    this.detected.clear();
    this.detectedExe.clear();
    this.current = null;
  }

  /** Effective agent label for a terminal, or null. Read by the THEME appliers
   *  (resolveSchemaId): mapped + sticky/revert only, so an unmapped agent never
   *  themes the pane. */
  getAgentForTerminal(id: string): string | null {
    return this.effective.get(id) ?? null;
  }

  /** Raw detected agent for a terminal (whatever is running), or null. Read by
   *  the context menus so a not-yet-mapped agent can still be OFFERED a scheme —
   *  unlike getAgentForTerminal (effective), which only reflects mapped/sticky
   *  agents that actually theme the pane. */
  getDetectedAgentForTerminal(id: string): string | null {
    return this.detected.get(id) ?? null;
  }

  /** Absolute executable path of a terminal's detected foreground agent, or null.
   *  Read by the AgentChip to fetch the binary's icon (via agentIconService). */
  getDetectedAgentExeForTerminal(id: string): string | null {
    return this.detectedExe.get(id) ?? null;
  }

  /** Subscribe to DETECTED-agent changes (a poll where any terminal's detected
   *  agent appeared, changed, or cleared). Used by the per-pane AgentChip to
   *  re-render. Returns an unsubscribe fn. Listeners persist across start/stop;
   *  each subscriber owns its lifetime (unsubscribe on unmount). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Force an immediate poll (e.g. when a context menu opens) so the offered
   *  agent name is fresh. Rides an in-flight poll if one is running; otherwise
   *  runs one now, bypassing the idle gate so a not-yet-mapped agent is still
   *  detected (needed to OFFER assigning it a scheme). */
  async refreshNow(): Promise<void> {
    if (this.current) { await this.current; return; }
    await this.poll();
  }

  // Periodic tick: honors the visibility + idle gates and skips if a poll is running.
  private async tick(): Promise<void> {
    if (this.current) return;
    // Pause while hidden — a background window's sysinfo poll is wasted work,
    // and ConPTY repaint bursts on re-show are handled elsewhere.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // Idle fast-path: skip the expensive /api/processes enumeration only when NOTHING
    // consumes detection — no agent mappings, nothing themed, AND no chip subscriber.
    // The AgentChip subscribes for live detection, so a mounted chip must keep the poll
    // running even with zero color mappings; otherwise the chip only updates on a manual
    // refreshNow() (e.g. right-click), which looked like "works in dev, needs a
    // right-click in release" — dev had mappings, a fresh release config did not.
    // A mapping added later, or a chip mounting, re-arms it next tick.
    const hasMappings = Object.keys(store.getState().settings.agentColorSchemes).length > 0;
    if (!hasMappings && this.effective.size === 0 && this.listeners.size === 0) return;
    await this.poll();
  }

  // Run one poll, tracking it as the in-flight promise so concurrent callers ride it.
  private poll(): Promise<void> {
    const p = this.doPoll().finally(() => { if (this.current === p) this.current = null; });
    this.current = p;
    return p;
  }

  private async doPoll(): Promise<void> {
    try {
      const procs = (await window.electronAPI.getActiveProcesses?.()) ?? [];
      const snapshots: ProcSnapshot[] = [];
      const nextDetected = new Map<string, string>();
      const nextDetectedExe = new Map<string, string>();
      for (const p of procs) {
        const terminalId = terminalService.getTerminalIdForProcess(p.id);
        if (!terminalId) continue; // process not owned by this window
        if (p.agent) nextDetected.set(terminalId, p.agent);
        if (p.agent && p.agentExe) nextDetectedExe.set(terminalId, p.agentExe);
        snapshots.push({
          terminalId,
          agent: p.agent ?? null,
          lastInputSource: (p.lastInputSource as 'user' | 'api' | null) ?? null,
          lastInputAt: p.lastInputAt ?? null,
        });
      }

      const mapped = new Set(Object.keys(store.getState().settings.agentColorSchemes));
      const next = computeEffectiveAgents(snapshots, this.effective, mapped, Date.now());

      // If stop() ran while this poll was in flight (window unmount), discard the
      // result instead of repopulating the just-cleared state.
      if (!this.timer) return;

      // Raw detection powers the context menus (offer any running agent) and the
      // per-pane agent chip. It is independent of mappings, so an unmapped agent is
      // still surfaced. Notify chip subscribers only when it actually changed.
      const detectedChanged =
        !sameStringMap(this.detected, nextDetected) ||
        !sameStringMap(this.detectedExe, nextDetectedExe);
      this.detected = nextDetected;
      this.detectedExe = nextDetectedExe;
      if (detectedChanged) {
        for (const listener of this.listeners) {
          try { listener(); } catch (e) { console.warn('AgentSchemeTracker: listener failed', e); }
        }
      }

      // Which terminals changed effective agent → reapply only those.
      const changed = new Set<string>();
      for (const [id, agent] of next) {
        if (this.effective.get(id) !== agent) changed.add(id);
      }
      for (const [id] of this.effective) {
        if (!next.has(id)) changed.add(id);
      }

      this.effective = next;
      if (changed.size) {
        const st = store.getState();
        const agentFor = (id: string) => this.getAgentForTerminal(id);
        applyEffectiveThemes([...changed], st, agentFor);
        // The active pane may have gained/lost an override — keep the slack
        // background behind the canvas in sync.
        applyActivePaneBackground(st, agentFor);
      }
    } catch (e) {
      console.warn('AgentSchemeTracker: poll failed', e);
    }
  }
}

export const agentSchemeTracker = new AgentSchemeTrackerClass();
