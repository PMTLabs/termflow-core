/**
 * Terminals that are running an agent CLI but that no pane in this workspace is
 * showing.
 *
 * Processes keep running when a layout is switched (plan/025 §0.1 — a switch
 * destroys the Redux *description* of where terminals were, never the PTYs), so
 * a long-running agent can end up alive with nothing on screen pointing at it.
 * That is the state this module names, and it feeds two surfaces: the title-bar
 * indicator that says the terminals exist, and the Layout Manager button that
 * brings them back. ONE definition, two consumers — the mute selector and the
 * clean-reference lifecycle both cost a review round by being implemented twice.
 *
 * The join, and why it takes two endpoints:
 *   GET /api/processes   → `agent` / `agentExe`, but NO renderer identity
 *   GET /api/terminals   → `terminalId` / `sessionKey`, but NO agent
 * They share `id` (== processId), and neither alone can answer the question.
 */
import { getAllTerminalIds } from '../store/slices/paneTreeOps';
import { currentWindowId, windowIdFromSessionKey } from './windowScope';
import { apiBase } from '../api/apiBase';
import { apiTokenKey, currentProfile, isForeignInstance } from './profileScope';

/** The fields this module reads from `GET /api/processes`. Structural on
 *  purpose: the endpoint returns more, and none of the rest is our business. */
export interface ProcessRow {
  id: string;
  agent?: string | null;
  agentExe?: string | null;
  name?: string | null;
}

/** The fields this module reads from `GET /api/terminals`. */
export interface IdentityRow {
  id?: string;
  processId?: string;
  terminalId?: string | null;
  sessionKey?: string | null;
  name?: string | null;
  promptHook?: boolean;
}

export interface HiddenAgentTerminal {
  /** The renderer leaf id. Carried into the restored pane AS IS — this terminal
   *  is alive and the host already knows it by this id, so the pane must ATTACH
   *  to it, never re-mint. (Re-minting is for the opposite case: an id that
   *  collides with a terminal someone else owns — see `loadTabScopedLayout`.) */
  terminalId: string;
  processId: string;
  /** The detected CLI, e.g. `claude`, `codex`. Non-empty by construction. */
  agent: string;
  /** Best available label for the restored tab. */
  name: string;
  promptHook?: boolean;
}

/** Every terminal id a pane in the current workspace is showing. */
export function visibleTerminalIds(treesByTabId: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const tree of Object.values(treesByTabId ?? {})) {
    for (const id of getAllTerminalIds((tree as any) ?? null)) ids.add(id);
  }
  return ids;
}

/**
 * The pure core: which live agent terminals is this workspace not showing?
 *
 * Three filters, and the third is the one that is easy to miss. `/api/terminals`
 * returns every terminal the backend knows **across all windows**, so "not in MY
 * pane trees" is not the same as "not on screen anywhere". A terminal another
 * window is displaying would be offered for recovery here, and accepting the
 * offer would put a second pane on a terminal that already has one — the exact
 * duplicate-leaf state `findTabIdByTerminalId` cannot represent (it returns the
 * FIRST match, so the two panes would fight over routing and muting).
 *
 * `sessionKey` is the discriminator: it is window-scoped, so
 * `windowIdFromSessionKey` says which window owns the session. A terminal whose
 * key names a DIFFERENT window of this profile is that window's business.
 * A terminal with no session key at all has never been bound to a window's
 * session and is fair game.
 */
export function findHiddenAgentTerminals(
  processes: ReadonlyArray<ProcessRow>,
  identities: ReadonlyArray<IdentityRow>,
  visible: ReadonlySet<string>,
  myWindowId: string,
): HiddenAgentTerminal[] {
  const identityByProcess = new Map<string, IdentityRow>();
  for (const row of identities) {
    const processId = row.id ?? row.processId;
    if (processId) identityByProcess.set(processId, row);
  }

  const out: HiddenAgentTerminal[] = [];
  const seen = new Set<string>();

  for (const proc of processes) {
    // 1. It must actually be running a CLI. `agent` is null for a bare shell.
    const agent = proc.agent?.trim();
    if (!agent) continue;

    const identity = identityByProcess.get(proc.id);
    const terminalId = identity?.terminalId?.trim();
    // No renderer identity means nothing to rebuild a pane around.
    if (!terminalId) continue;

    // 2. Something on screen here is already showing it.
    if (visible.has(terminalId)) continue;

    // 3. Another window of this profile owns the session (see the doc comment).
    if (identity?.sessionKey) {
      const owner = windowIdFromSessionKey(identity.sessionKey);
      if (owner !== null && owner !== myWindowId) continue;
    }

    // The backend can briefly hold two rows for one leaf (a respawn racing a
    // close); offering it twice would build two tabs for one terminal.
    if (seen.has(terminalId)) continue;
    seen.add(terminalId);

    out.push({
      terminalId,
      processId: proc.id,
      agent,
      name: (identity?.name || proc.name || agent) as string,
      promptHook: identity?.promptHook,
    });
  }

  // Stable order so the indicator's count and the restore list agree between
  // renders, and so tests are not at the mercy of DashMap iteration order.
  return out.sort((a, b) => a.terminalId.localeCompare(b.terminalId));
}

// ---------------------------------------------------------------------------
// The tracker: one poll, any number of subscribers.
// ---------------------------------------------------------------------------

/**
 * Deliberately NOT piggybacked onto `AgentSchemeTracker`, even though that class
 * already polls `/api/processes`. Its poll is gated off entirely when no agent
 * colour schemes are configured and nothing is themed — the common case — so
 * subscribing to it would force a 2s poll for a signal that changes on the scale
 * of a layout switch. This costs one request per 10s instead, and only while a
 * consumer is mounted and the window is visible.
 *
 * `/api/processes` enumerates the whole OS process table on the backend
 * (50-200ms), so this interval is a real cost and is set accordingly. The
 * signal is also refreshed ON DEMAND at the moments that actually create hidden
 * terminals — see `refreshHiddenAgentTerminals`.
 */
const POLL_MS = 10_000;

type Listener = (hidden: HiddenAgentTerminal[]) => void;

class HiddenAgentTerminalsTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<Listener>();
  private hidden: HiddenAgentTerminal[] = [];
  private inFlight: Promise<void> | null = null;

  /** The last computed set. Never null — an un-polled tracker reports nothing
   *  hidden, which is the safe default for a badge (it under-claims rather than
   *  inventing terminals that may not exist). */
  get current(): HiddenAgentTerminal[] {
    return this.hidden;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (!this.timer) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private start(): void {
    this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
    void this.tick();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    // A hidden window cannot show the indicator, and the poll is expensive.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    await this.refresh();
  }

  /** Single-flight: concurrent callers ride the in-flight request rather than
   *  each triggering their own process-table scan. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const p = this.doRefresh().finally(() => { if (this.inFlight === p) this.inFlight = null; });
    this.inFlight = p;
    return p;
  }

  private async doRefresh(): Promise<void> {
    let next: HiddenAgentTerminal[];
    try {
      next = await fetchHiddenAgentTerminals();
    } catch (e) {
      // A failed poll must not clear a set the user is looking at, and must not
      // invent one either — keep the last known answer and try again next tick.
      console.warn('hiddenAgentTerminals: refresh failed, keeping the last known set', e);
      return;
    }
    if (sameHiddenSet(this.hidden, next)) return;
    this.hidden = next;
    for (const listener of this.listeners) {
      try { listener(next); } catch (e) {
        console.warn('hiddenAgentTerminals: listener failed', e);
      }
    }
  }
}

/** Compared by id, not by deep equality: `name` can flap as a shell retitles
 *  itself, and re-rendering the badge for that is noise. */
export function sameHiddenSet(
  a: ReadonlyArray<HiddenAgentTerminal>,
  b: ReadonlyArray<HiddenAgentTerminal>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => row.terminalId === b[i].terminalId);
}

export const hiddenAgentTerminals = new HiddenAgentTerminalsTracker();

/** Re-poll now. Call after anything that can strand a terminal — a layout load,
 *  a revert, a reset — rather than waiting out the interval. */
export function refreshHiddenAgentTerminals(): Promise<void> {
  return hiddenAgentTerminals.refresh();
}

/**
 * One round of the join. Exported for tests; the tracker is the normal caller.
 *
 * The instance owner check is not optional. The configured API port can be
 * bound by a SIBLING profile that started first, in which case `/api/terminals`
 * answers with that instance's terminals — and offering to "restore" those would
 * put panes on another app's PTYs. `StateManager.reconcileExistingTerminals`
 * makes the same check for the same reason.
 */
export async function fetchHiddenAgentTerminals(): Promise<HiddenAgentTerminal[]> {
  const base = await apiBase();
  const token = localStorage.getItem(apiTokenKey());
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const [identityRes, processes] = await Promise.all([
    fetch(`${base}/terminals`, { headers }),
    (window as any).electronAPI?.getActiveProcesses?.() ?? Promise.resolve([]),
  ]);
  if (!identityRes.ok) throw new Error(`/terminals ${identityRes.status}`);
  const data = await identityRes.json();

  const owner: string | undefined = data?.instance;
  const mine = currentProfile().key;
  if (isForeignInstance(owner, mine)) {
    console.warn(
      `hiddenAgentTerminals: /api/terminals answered by instance '${owner}', not '${mine}' — ` +
        'reporting nothing hidden rather than offering another instance\'s terminals',
    );
    return [];
  }

  const store = (window as any).__REDUX_STORE__;
  const trees = store?.getState()?.panes?.treesByTabId ?? {};
  return findHiddenAgentTerminals(
    (processes as ProcessRow[]) ?? [],
    (data?.terminals as IdentityRow[]) ?? [],
    visibleTerminalIds(trees),
    currentWindowId(),
  );
}
