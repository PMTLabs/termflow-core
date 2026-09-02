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
 *   GET /api/terminals   → `terminalId`, but NO agent
 * They share `id` (== processId), and neither alone can answer the question.
 *
 * Neither endpoint says which WINDOW is showing a terminal, and an earlier
 * version of this module believed `/api/terminals.sessionKey` did. It does not:
 * that field is the PTY-HOST's key, equal to `terminalId` for anything created
 * on this build, and `api_server.rs` labels it "Diagnostic only — nothing
 * addresses a terminal by this". Passing it to `windowIdFromSessionKey` (which
 * parses `auto-terminal-state#<windowId>` localStorage keys) returned `null`
 * every time, so the ownership filter never once excluded anything. The real
 * signal is each window's saved session blob — see `terminalIdsInOtherWindows`.
 */
import { getAllTerminalIds } from '../store/slices/paneTreeOps';
import { currentWindowId } from './windowScope';
import { terminalIdsInOtherWindows } from './sessionKeepSet';
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
  name?: string | null;
  promptHook?: boolean;
  /* `sessionKey` is deliberately NOT read here. It is the pty-host's own key,
     not a window identity — see the module doc. */
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
 * `ownedElsewhere` is that discriminator, and it has to be supplied by the
 * caller because it comes from localStorage rather than either endpoint: it is
 * the union of the terminal ids in every OTHER window's saved session
 * (`terminalIdsInOtherWindows`). A terminal in it is that window's business.
 *
 * Its lag is documented at the source and is the honest limit of this filter: a
 * terminal another window opened since its last session write is not in the set
 * yet, so it can still be offered here. That is narrower than the previous
 * behaviour, which excluded nothing at all, but it is not zero.
 */
export function findHiddenAgentTerminals(
  processes: ReadonlyArray<ProcessRow>,
  identities: ReadonlyArray<IdentityRow>,
  visible: ReadonlySet<string>,
  ownedElsewhere: ReadonlySet<string>,
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

    // 3. Another window of this profile has it on screen (see the doc comment).
    if (ownedElsewhere.has(terminalId)) continue;

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
 * (50-200ms), so this interval is a real cost and is set accordingly.
 *
 * The interval is NOT how the badge keeps up with the user, and an earlier
 * version of this comment claimed it was ("refreshed on demand at the moments
 * that actually create hidden terminals"). It was not: the only on-demand
 * refreshes were the Layout Manager opening and a restore completing, so a
 * layout LOAD — the very thing that strands a terminal — waited out the full
 * interval before the badge appeared. The tracker now watches the workspace and
 * recomputes from cache the moment it changes (`watchWorkspace`); this poll only
 * keeps the backend half honest.
 */
const POLL_MS = 10_000;

type Listener = (hidden: HiddenAgentTerminal[]) => void;

class HiddenAgentTerminalsTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<Listener>();
  private hidden: HiddenAgentTerminal[] = [];
  private inFlight: Promise<void> | null = null;
  // The last BACKEND answer, kept so the set can be recomputed without another
  // process-table scan. See `watchWorkspace`.
  private lastProcesses: ProcessRow[] = [];
  private lastIdentities: IdentityRow[] = [];
  private lastTrees: unknown = undefined;
  private storeUnsub: (() => void) | null = null;
  /** Invalidates an in-flight refresh across a reset. See `__resetForTests`. */
  private generation = 0;

  /**
   * The last computed set. Never null — a tracker that has never polled reports
   * nothing hidden, which is the safe default for a badge (it under-claims
   * rather than inventing terminals that may not exist).
   *
   * Note the scoping: NEVER POLLED, not "not currently polling". `stop()`
   * deliberately retains `hidden` and the cached backend rows, so a stopped
   * tracker keeps reporting its last answer — which is what lets the hook seed
   * from `current` on remount instead of flashing an empty badge. The cost is
   * that a set which stopped being true while nothing was subscribed is served
   * until the restart's first tick lands.
   */
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

  /**
   * `tick()` skips every interval while the window is hidden, so without this
   * the badge would stay as stale as the moment the window was hidden for up to
   * a further POLL_MS after it is shown again — and being shown again is exactly
   * when the user looks at it. Refreshes through `refresh()`, so it shares the
   * single-flight guard with an interval that fires at the same moment.
   */
  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') void this.refresh();
  };

  private start(): void {
    this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
    this.watchWorkspace();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    void this.tick();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.storeUnsub?.();
    this.storeUnsub = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }

  /**
   * Recompute the instant the WORKSPACE changes, without re-fetching.
   *
   * This is what makes the badge appear as a layout switch strands a terminal
   * rather than up to `POLL_MS` later. The question has two halves and only one
   * of them is expensive: which terminals are alive and running a CLI needs the
   * backend, but which of them this workspace is SHOWING is local Redux state.
   * A layout load changes only the second half, so the cached first half still
   * answers it — no scan, no wait.
   *
   * Done by OBSERVING the store rather than by calling `refresh()` from
   * `loadLayout`/`revertWorkspace`/`resetToDefaultLayout`. Those are not the only
   * paths that strand a terminal — closing a tab, dragging a pane to another
   * window and an API-created tab all move the same needle — and a refresh
   * placed in each caller is one the NEXT such path silently opts out of.
   * Subscribing cannot be opted out of.
   *
   * Liveness stays on the poll: a terminal that exits is noticed within
   * `POLL_MS`, exactly as before.
   */
  private watchWorkspace(): void {
    const store = (window as any).__REDUX_STORE__;
    if (!store || this.storeUnsub) return;
    this.lastTrees = store.getState()?.panes?.treesByTabId;
    this.storeUnsub = store.subscribe(() => {
      const trees = store.getState()?.panes?.treesByTabId;
      // Reference equality is the whole point: Redux Toolkit hands back a new
      // object only when that slice actually changed, so this stays cheap on
      // the many dispatches that touch nothing here.
      if (trees === this.lastTrees) return;
      this.lastTrees = trees;
      this.publish(this.computeFromCache());
    });
  }

  /** The hidden set implied by the last backend answer and the CURRENT workspace. */
  private computeFromCache(): HiddenAgentTerminal[] {
    const elsewhere = otherWindowTerminals();
    // Cannot read some other window's session => cannot tell whose its terminals
    // are. Report nothing rather than offer a terminal that window may be showing;
    // the badge's contract is to under-claim, never to invent.
    if (!elsewhere.complete) return [];
    return findHiddenAgentTerminals(
      this.lastProcesses,
      this.lastIdentities,
      visibleTerminalIds((window as any).__REDUX_STORE__?.getState()?.panes?.treesByTabId ?? {}),
      elsewhere.ids,
    );
  }

  /** Store `next` and notify, but only when membership actually moved. */
  private publish(next: HiddenAgentTerminal[]): void {
    if (sameHiddenSet(this.hidden, next)) return;
    this.hidden = next;
    for (const listener of this.listeners) {
      try { listener(next); } catch (e) {
        console.warn('hiddenAgentTerminals: listener failed', e);
      }
    }
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
    // Captured before the await so a reset that happens WHILE this is in flight
    // can invalidate the result. Without it, `__resetForTests` could not honour
    // its own contract: clearing the caches does not cancel a request already
    // running, and that request would repopulate them after the reset.
    const generation = this.generation;
    let rows: LiveTerminalRows;
    try {
      rows = await fetchLiveTerminalRows();
    } catch (e) {
      // A failed poll must not clear a set the user is looking at, and must not
      // invent one either — keep the last known answer and try again next tick.
      console.warn('hiddenAgentTerminals: refresh failed, keeping the last known set', e);
      return;
    }
    if (generation !== this.generation) return;
    // Cached so a later workspace change is answered without another scan.
    this.lastProcesses = rows.processes;
    this.lastIdentities = rows.identities;
    this.publish(this.computeFromCache());
  }

  /**
   * Test seam: drop the cached backend answer and the observed workspace, so one
   * test does not inherit the previous one's tracker state.
   *
   * Bumping the generation is what makes that true rather than merely intended.
   * Clearing `inFlight` does not cancel a request already awaiting the network;
   * before the generation check in `doRefresh`, such a request would resolve
   * after the reset and quietly repopulate everything cleared here.
   */
  __resetForTests(): void {
    this.stop();
    this.generation++;
    this.listeners.clear();
    this.hidden = [];
    this.lastProcesses = [];
    this.lastIdentities = [];
    this.lastTrees = undefined;
    this.inFlight = null;
  }
}

/**
 * Compared by BOTH ids, not by deep equality.
 *
 * `name` is deliberately ignored: it flaps as a shell retitles itself, and
 * re-rendering the badge for that is noise. `processId` is deliberately NOT
 * ignored, and an earlier version of this function did ignore it. That was a
 * silent data-corruption bug rather than a cosmetic one: `publish()` returns
 * early when this says "same", so a poll that correctly replaced `tm-1 -> pc-old`
 * with `tm-1 -> pc-new` (the respawn-racing-a-close case the join dedupes just
 * above) left the OLD row in `this.hidden` forever. Restore binds `processId`,
 * so every later restore would attach to a process that no longer exists, and no
 * amount of polling would repair it.
 */
export function sameHiddenSet(
  a: ReadonlyArray<HiddenAgentTerminal>,
  b: ReadonlyArray<HiddenAgentTerminal>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => row.terminalId === b[i].terminalId && row.processId === b[i].processId);
}

export const hiddenAgentTerminals = new HiddenAgentTerminalsTracker();

/**
 * Force a fresh BACKEND read now, rather than waiting out the interval.
 *
 * Note what this is NOT for: reacting to a workspace change. The tracker
 * observes the store for that and recomputes instantly from its cache (see
 * `watchWorkspace`), so a layout load needs no call here. Use it when the
 * backend's own answer may have moved — a terminal exiting, a CLI starting —
 * and the user is about to look, as the Layout Manager does when it opens.
 */
export function refreshHiddenAgentTerminals(): Promise<void> {
  return hiddenAgentTerminals.refresh();
}

/** The raw backend answer, before it is joined against the workspace. */
export interface LiveTerminalRows {
  processes: ProcessRow[];
  identities: IdentityRow[];
}

/**
 * One backend round: both endpoints, and the instance owner check.
 *
 * Split from the join so the tracker can CACHE this half. The workspace half is
 * free to recompute and changes far more often; keeping the two together forced
 * a full process-table scan every time a tab moved.
 *
 * The instance owner check is not optional. The configured API port can be
 * bound by a SIBLING profile that started first, in which case `/api/terminals`
 * answers with that instance's terminals — and offering to "restore" those would
 * put panes on another app's PTYs. `StateManager.reconcileExistingTerminals`
 * makes the same check for the same reason.
 */
export async function fetchLiveTerminalRows(): Promise<LiveTerminalRows> {
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
    // Empty rather than a throw: a sibling instance answering is a definite
    // "nothing of ours here", not a failed read, so it should REPLACE the cached
    // set rather than leave the last one standing.
    return { processes: [], identities: [] };
  }

  return {
    processes: (processes as ProcessRow[]) ?? [],
    identities: (data?.terminals as IdentityRow[]) ?? [],
  };
}

/**
 * Which terminals other windows of this profile are showing.
 *
 * Wrapped so both the tracker and the one-shot query ask the same question of
 * the same storage, and so a test can point it at a stub.
 */
export function otherWindowTerminals(): { ids: ReadonlySet<string>; complete: boolean } {
  try {
    const { ids, complete } = terminalIdsInOtherWindows(localStorage, currentWindowId());
    return { ids, complete };
  } catch (e) {
    // localStorage can throw outright (private mode, blocked site data). Unknown
    // ownership, so say so and let the caller under-claim.
    console.warn('hiddenAgentTerminals: could not read other windows\' sessions', e);
    return { ids: new Set(), complete: false };
  }
}

/**
 * `terminalId -> processId` for every terminal that is alive AND still running
 * an agent, straight from a backend answer.
 *
 * Same join as `findHiddenAgentTerminals`, minus the workspace filters. Restore
 * needs it because the tracker's rows are up to POLL_MS old and `processId` is
 * the value it binds: attaching to a process that has since exited registers a
 * mapping the backend does not own, and a pane mounted on it looks alive.
 */
export function liveAgentProcessIds(rows: LiveTerminalRows): Map<string, string> {
  const identityByProcess = new Map<string, IdentityRow>();
  for (const row of rows.identities) {
    const processId = row.id ?? row.processId;
    if (processId) identityByProcess.set(processId, row);
  }
  const out = new Map<string, string>();
  for (const proc of rows.processes) {
    if (!proc.agent?.trim()) continue;
    const terminalId = identityByProcess.get(proc.id)?.terminalId?.trim();
    // First row wins, matching the detector's dedupe: the backend can briefly
    // hold two rows for one leaf while a respawn races a close.
    if (terminalId && !out.has(terminalId)) out.set(terminalId, proc.id);
  }
  return out;
}

/** The whole question in one call: fetch, then join against this workspace. */
export async function fetchHiddenAgentTerminals(): Promise<HiddenAgentTerminal[]> {
  const rows = await fetchLiveTerminalRows();
  const trees = (window as any).__REDUX_STORE__?.getState()?.panes?.treesByTabId ?? {};
  const elsewhere = otherWindowTerminals();
  if (!elsewhere.complete) return [];
  return findHiddenAgentTerminals(
    rows.processes,
    rows.identities,
    visibleTerminalIds(trees),
    elsewhere.ids,
  );
}
