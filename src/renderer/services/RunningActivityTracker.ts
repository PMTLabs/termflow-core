import { store } from '../store';
import { setRunningTabs, markUnseenOutput } from '../store/slices/tabsSlice';
import { findTabIdByTerminalId, isTerminalMuted } from '../store/slices/paneTreeOps';
import { terminalService } from './TerminalService';
import {
  isRunningFromEvents,
  computeRunningTabIds,
  computeUnseenUpdate,
  shouldCountForRunning,
  isSubmitInput,
  WINDOW_MS,
  EVAL_INTERVAL_MS,
  MIN_CHUNKS,
  MIN_BYTES,
  RESIZE_COOLDOWN_MS,
  RECONNECT_COOLDOWN_MS,
  STARTUP_COOLDOWN_MS,
  UNSEEN_DEBOUNCE_MS,
  BURST_TAB_THRESHOLD,
} from './runningActivity';
import type { OutputEvent, UnseenInput } from './runningActivity';

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Observes the per-terminal output stream (pty:data, keyed by processId) and
 * marks tabs as "running" while a process is actively producing output. Pure
 * decision logic lives in runningActivity.ts; this class owns the live buffers,
 * the periodic evaluator, terminal→tab resolution, and Redux dispatch.
 */
class RunningActivityTrackerClass {
  private buffers = new Map<string, OutputEvent[]>(); // processId → recent output events
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunning = new Set<string>(); // last dispatched running tabIds
  private suppressUntil = 0; // ignore output until this time after a resize/reconnect
  // processId → newest output timestamp already counted toward the unseen bell.
  // Ensures each output chunk flags a tab at most once (see computeUnseenUpdate).
  private unseenMark = new Map<string, number>();
  // processId → its most recent output timestamp. UNLIKE `buffers`, this is NOT
  // pruned by the 1s running window, so the unseen bell can wait UNSEEN_DEBOUNCE_MS
  // (> WINDOW_MS) for output to settle before flagging. Pruned once accounted+stale,
  // and on exit/resize/visibility-reset.
  private lastOutputAt = new Map<string, number>();
  // processId → timestamp of the user's most recent keystroke to that terminal.
  // Fed by the `pty:input` event (renderer user writes only; API/MCP writes bypass
  // it). Used to echo-cancel typing so the tab sweep doesn't animate while the user
  // types. A bare Enter resets it to -Infinity so the command's output still counts.
  private lastInputAt = new Map<string, number>();
  private lastActiveTabId: string | null = null; // for focus-change detection
  private unsubscribe: (() => void) | null = null;
  private readonly opts = { windowMs: WINDOW_MS, minChunks: MIN_CHUNKS, minBytes: MIN_BYTES };

  private onData = (e: Event) => this.handleData(e as CustomEvent);
  private onInput = (e: Event) => this.handleInput(e as CustomEvent);
  private onExit = (e: Event) => this.handleExit(e as CustomEvent);
  private onResize = () => this.handleResize();
  private onVisibility = () => this.handleVisibility();

  start(startupGraceMs: number = STARTUP_COOLDOWN_MS): void {
    if (this.timer) return; // already running
    // App start/restore: restored tabs spawn (or reattach) their PTYs right after this
    // runs, so every shell prints its prompt/banner and reattached TUIs repaint at once
    // — a synchronized burst like a resize/reconnect. Freeze detection so this startup
    // output can't ring the unseen bell (nothing was missed on a fresh start) or flip a
    // tab "running". Honored by handleData and evaluate via suppressUntil.
    if (startupGraceMs > 0) this.suppressUntil = Date.now() + startupGraceMs;
    window.addEventListener('pty:data', this.onData);
    window.addEventListener('pty:input', this.onInput);
    window.addEventListener('pty:exit', this.onExit);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.lastActiveTabId = store.getState().tabs.activeTabId;
    this.unsubscribe = store.subscribe(() => this.handleActiveTabChange());
    this.timer = setInterval(() => this.evaluate(), EVAL_INTERVAL_MS);
  }

  stop(): void {
    window.removeEventListener('pty:data', this.onData);
    window.removeEventListener('pty:input', this.onInput);
    window.removeEventListener('pty:exit', this.onExit);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buffers.clear();
    this.lastRunning.clear();
    this.unseenMark.clear();
    this.lastOutputAt.clear();
    this.lastInputAt.clear();
    this.lastActiveTabId = null;
    this.suppressUntil = 0;
  }

  // When the user switches tabs, everything the tab they LEFT produced up to now
  // was on-screen — i.e. seen. Advance that tab's high-water marks so its buffered
  // output can't ring the bell on the next eval tick (the sub-tick focus race: a
  // tab focused and left again within EVAL_INTERVAL_MS never gets a tick while
  // active to advance its mark). Fires on every store change; cheap no-op unless
  // activeTabId actually changed.
  private handleActiveTabChange(): void {
    const activeTabId = store.getState().tabs.activeTabId;
    if (activeTabId === this.lastActiveTabId) return;
    const leftTabId = this.lastActiveTabId;
    this.lastActiveTabId = activeTabId;
    if (!leftTabId) return;
    const now = Date.now();
    // Everything the left tab produced UP TO NOW was on-screen (seen). Advance its
    // marks so neither buffered nor still-settling output can ring its bell later.
    // Iterate lastOutputAt (not buffers) — buffers may already be pruned while
    // lastOutputAt still holds the pending-but-not-yet-debounced output.
    for (const processId of this.lastOutputAt.keys()) {
      if (this.resolveTab(processId) === leftTabId) this.unseenMark.set(processId, now);
    }
  }

  // An OS session switch (RDP↔console connect / unlock) reattaches the desktop and
  // ConPTY repaints every TUI at once — the same synchronized burst as a reconnect,
  // which would falsely ring the unseen bell on every tab. The DOM visibilitychange
  // event does NOT fire on a session connect/disconnect, so the backend
  // (session_notify.rs) detects WM_WTSSESSION_CHANGE and calls this. Reuses the exact
  // reconnect cooldown the visibility path uses.
  notifyReconnectBurst(): void {
    this.resetForBurst(RECONNECT_COOLDOWN_MS);
  }

  private handleResize(): void {
    // A window resize sends SIGWINCH to every PTY, so every TUI app redraws its
    // whole screen at once — a synchronized output burst across all terminals that
    // otherwise reads as "every tab is running". Drop whatever is buffered and
    // freeze detection until the redraw settles (bumped on each resize event, so a
    // drag keeps it suppressed until the user stops). See evaluate().
    this.resetForBurst(RESIZE_COOLDOWN_MS);
  }

  private handleVisibility(): void {
    // Only the hidden→visible transition matters. Returning to the app (RDP
    // reconnect, un-minimize, refocus) makes ConPTY repaint every TUI at once —
    // the same synchronized burst as a SIGWINCH resize, which would otherwise
    // falsely ring the unseen bell on quiet tabs. Drop it and freeze detection.
    // Sticky bells already in Redux are untouched; we only reset our own maps.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    this.resetForBurst(RECONNECT_COOLDOWN_MS);
  }

  // Freeze activity detection for `cooldownMs` and drop all in-flight output state
  // so a synchronized redraw burst (resize / reconnect) can't flip tabs running or
  // ring the bell. handleData and evaluate both honor suppressUntil.
  private resetForBurst(cooldownMs: number): void {
    this.suppressUntil = Date.now() + cooldownMs;
    this.buffers.clear();
    this.unseenMark.clear(); // buffers gone → their marks can never be pruned otherwise
    this.lastOutputAt.clear();
  }

  private handleData(e: CustomEvent): void {
    const { processId, data } = (e.detail || {}) as { processId?: string; data?: string };
    if (!processId) return;
    // terminal:data is broadcast to every window, so only buffer output for terminals
    // this window actually owns — otherwise each open window would track (and evaluate)
    // output for terminals it doesn't own (wasted work in multi-window; they resolve to
    // no tab anyway).
    if (!terminalService.getTerminalIdForProcess(processId)) return;
    const now = Date.now();
    // Within a resize/reconnect cooldown: drop the burst entirely so it touches
    // neither the running buffers nor the unseen lastOutputAt timeline.
    if (now < this.suppressUntil) return;
    const bytes = typeof data === 'string' ? data.length : 0;
    // Echo-cancel: while the user types, the shell echoes / re-renders the input line
    // back as output (a per-key line-repaint in PowerShell/PSReadLine, not just 1-byte
    // echo). Excluding output that lands within the echo window of a keystroke stops
    // live typing from animating the tab sweep. This gates ONLY the running buffer —
    // lastOutputAt (the unseen bell) is always updated so genuine background activity is
    // never lost. Keystrokes only reach the terminal the user is typing in, so background
    // tabs (no recent input) are unaffected.
    if (shouldCountForRunning(now, this.lastInputAt.get(processId) ?? -Infinity)) {
      const buf = this.buffers.get(processId) ?? [];
      buf.push({ t: now, bytes });
      this.buffers.set(processId, buf);
    }
    this.lastOutputAt.set(processId, now);
  }

  // Record the time of a user keystroke/paste to a terminal so handleData can
  // echo-cancel the shell's echo of it. A bare Enter (submit) resets the mark to
  // -Infinity so the OUTPUT the command produces is counted normally rather than
  // being mistaken for echo. Fed by the `pty:input` event emitted from the renderer
  // write choke point (user input only; API/MCP writes never emit it).
  private handleInput(e: CustomEvent): void {
    const { processId, data, t } = (e.detail || {}) as {
      processId?: string;
      data?: string;
      t?: number;
    };
    if (!processId) return;
    // No ownership guard needed here (unlike handleData): pty:input is dispatched
    // LOCALLY by the writing window's own bridge, so a window only ever receives
    // input events for terminals it is actually driving. (pty:data, by contrast, is
    // broadcast to every window by the backend, hence its ownership filter.)
    const dataStr = typeof data === 'string' ? data : '';
    this.lastInputAt.set(processId, isSubmitInput(dataStr) ? -Infinity : (t ?? Date.now()));
  }

  private handleExit(e: CustomEvent): void {
    const { processId, terminalId } = (e.detail || {}) as {
      processId?: string;
      terminalId?: string;
    };
    // A process exit SETTLES its final output immediately (no more is coming), so
    // flag it now rather than waiting out the idle debounce — otherwise a one-shot
    // command that prints then exits would never ring the bell. Resolve via the
    // event's terminalId: TerminalService removes the processId→terminalId mapping
    // BEFORE dispatching pty:exit, so resolveTab(processId) would already be null.
    if (processId && Date.now() >= this.suppressUntil) {
      this.flagOnExit(processId, terminalId);
    }
    if (processId) {
      this.buffers.delete(processId);
      this.unseenMark.delete(processId);
      this.lastOutputAt.delete(processId);
      this.lastInputAt.delete(processId); // avoid a per-process leak across a long session
    }
    this.evaluate(); // recompute the running sweep without the dead PTY
  }

  // Flag the exiting process's tab as unseen if it had pending output the user
  // hasn't accounted for, the tab still resolves, and it isn't the active tab.
  private flagOnExit(processId: string, terminalId: string | undefined): void {
    const last = this.lastOutputAt.get(processId);
    if (last === undefined || last <= (this.unseenMark.get(processId) ?? -Infinity)) return;
    // Prefer the terminalId carried on the exit event; fall back to resolving it
    // from the processId. Use this ONE resolved id for BOTH the tab lookup and the
    // pane-mute check so the two can never disagree — using the bare param for the
    // mute check while resolving the tab another way would let a muted pane's
    // exit-settled output leak a bell whenever the event omits terminalId.
    const effectiveTerminalId = terminalId ?? terminalService.getTerminalIdForProcess(processId);
    const tabId = effectiveTerminalId
      ? findTabIdByTerminalId(store.getState().panes.treesByTabId, effectiveTerminalId)
      : null;
    if (!tabId) return;
    const tabsState = store.getState().tabs;
    if (tabId === tabsState.activeTabId) return;
    // Mute gate: suppress this exit-settled bell if the tab is muted, or the
    // exiting pane itself is muted (an unmuted sibling in the same tab is
    // unaffected). Mirrors the source-mute check in computeUnseenUpdate.
    const tabMuted = tabsState.tabs.some(t => t.id === tabId && t.notifyMuted);
    const paneMuted = effectiveTerminalId
      ? isTerminalMuted(store.getState().panes.treesByTabId, effectiveTerminalId)
      : false;
    if (tabMuted || paneMuted) return;
    // Skip a redundant dispatch if the tab is already flagged (mirrors computeUnseenUpdate);
    // markUnseenOutput is itself a no-op for the active/missing tab.
    const alreadyUnseen = tabsState.tabs.some(t => t.id === tabId && t.hasUnseenOutput);
    if (!alreadyUnseen) {
      store.dispatch(markUnseenOutput({ tabId }));
      this.emitBell(tabId, last); // exit-settled output is the causal time
    }
  }

  private resolveTab(processId: string): string | null {
    const terminalId = terminalService.getTerminalIdForProcess(processId);
    if (!terminalId) return null;
    return findTabIdByTerminalId(store.getState().panes.treesByTabId, terminalId);
  }

  private evaluate(): void {
    const now = Date.now();
    if (now < this.suppressUntil) {
      // Within the post-resize cooldown: keep dropping the redraw burst and leave
      // the dispatched running set frozen (genuinely-running tabs keep sweeping;
      // idle tabs never flip on from the burst).
      this.buffers.clear();
      return;
    }
    const cutoff = now - WINDOW_MS;
    const runningProcessIds: string[] = [];
    for (const [processId, events] of this.buffers) {
      const pruned = events.filter(ev => ev.t >= cutoff);
      if (pruned.length === 0) {
        this.buffers.delete(processId); // idle past the running window → drop buffer
        continue;
      }
      this.buffers.set(processId, pruned);
      if (isRunningFromEvents(pruned, now, this.opts)) runningProcessIds.push(processId);
    }
    // Resolve each process to its tab ONCE per tick (findTabIdByTerminalId is a tree
    // walk) and share the result between the running and unseen passes.
    const tabCache = new Map<string, string | null>();
    const resolveOnce = (processId: string): string | null => {
      const cached = tabCache.get(processId);
      if (cached !== undefined) return cached;
      const tabId = this.resolveTab(processId);
      tabCache.set(processId, tabId);
      return tabId;
    };
    const next = new Set(computeRunningTabIds(runningProcessIds, resolveOnce));
    if (!setsEqual(next, this.lastRunning)) {
      this.lastRunning = next;
      store.dispatch(setRunningTabs(Array.from(next)));
    }
    // Unseen-output bell: built from lastOutputAt (NOT the 1s running window) so it
    // can wait UNSEEN_DEBOUNCE_MS for output to settle. Output on an INACTIVE tab
    // flags it once settled (sticky until the tab is focused). Dispatched in the
    // SAME synchronous pass as setRunningTabs so React-Redux batches both into one
    // render. Runs after the suppressUntil guard, so a redraw burst never marks unseen.
    const outputs: UnseenInput[] = [];
    for (const [processId, last] of this.lastOutputAt) outputs.push({ processId, newest: last });
    this.markUnseen(outputs, resolveOnce, now);
    // Prune accounted + settled entries so lastOutputAt stays bounded (re-output
    // simply re-seeds it with a fresh timestamp). Keep unaccounted/unsettled ones.
    for (const [processId, last] of this.lastOutputAt) {
      if (last <= (this.unseenMark.get(processId) ?? -Infinity) && now - last > UNSEEN_DEBOUNCE_MS) {
        this.lastOutputAt.delete(processId);
        this.unseenMark.delete(processId);
      }
    }
  }

  // Flag inactive tabs that produced NEW output as having unseen content. Uses a
  // per-process high-water mark so each output chunk flags a tab at most once —
  // stale buffered output can't re-flag after a focus/clear, and output seen live
  // on the active tab is never reclassified as unseen.
  private markUnseen(
    outputs: UnseenInput[],
    resolveTab: (processId: string) => string | null,
    now: number,
  ): void {
    if (outputs.length === 0) return;
    const tabsState = store.getState().tabs;
    const alreadyUnseen = new Set(
      tabsState.tabs.filter(t => t.hasUnseenOutput).map(t => t.id),
    );
    // Mute predicate: a source is muted when its tab is muted, or its own pane
    // (the leaf carrying its terminalId) is muted. Read the current trees/tabs
    // once per tick. computeUnseenUpdate still advances the mark for muted
    // sources, so unmuting later doesn't ring a backlog of old output.
    const mutedTabIds = new Set(tabsState.tabs.filter(t => t.notifyMuted).map(t => t.id));
    const treesByTabId = store.getState().panes.treesByTabId;
    const isSourceMuted = (processId: string, tabId: string): boolean => {
      if (mutedTabIds.has(tabId)) return true;
      const terminalId = terminalService.getTerminalIdForProcess(processId);
      return terminalId ? isTerminalMuted(treesByTabId, terminalId) : false;
    };
    const { toFlag, marks, causalByTab } = computeUnseenUpdate(
      outputs,
      resolveTab,
      tabsState.activeTabId,
      alreadyUnseen,
      this.unseenMark,
      now,
      UNSEEN_DEBOUNCE_MS,
      isSourceMuted,
    );
    this.unseenMark = marks;
    // Synchronized repaint burst (window resize / RDP↔console reattach / un-minimize):
    // the desktop reattaches and ConPTY redraws EVERY TUI at once, so many inactive tabs
    // settle together and would all be flagged in THIS single tick. That is a repaint,
    // not genuine per-tab activity (independent activity settles at independent times →
    // one tab per tick), so suppress the whole batch. The marks were already advanced
    // above, so this same output can't ring on a later tick either. Trigger-independent
    // backstop: catches bursts the resize/visibility/session-change cooldowns miss
    // (e.g. an OS session switch the Page Visibility API never reports).
    if (toFlag.length >= BURST_TAB_THRESHOLD) {
      console.debug(
        `RunningActivityTracker: suppressed ${toFlag.length}-tab simultaneous flag as a repaint burst`,
      );
      return;
    }
    // causalByTab (from computeUnseenUpdate) holds the settled, eligible output time for
    // EACH flagged tab — carried on the bell so the notification gate compares against
    // the OUTPUT time, not the (later) Redux transition. Built only from contributing
    // outputs, so an unsettled sibling process can't lend a newer timestamp.
    for (const tabId of toFlag) {
      store.dispatch(markUnseenOutput({ tabId }));
      this.emitBell(tabId, causalByTab.get(tabId) ?? now);
    }
  }

  // Notify listeners (NotificationService) that a tab just rang the unseen bell — ONLY
  // for bells that passed all of the tracker's suppression (startup/resize/reconnect/
  // burst), carrying the causal output time. Fire-and-forget; must never break tracking.
  private emitBell(tabId: string, causalTime: number): void {
    try {
      window.dispatchEvent(
        new CustomEvent('activity:bell', { detail: { tabId, causalTime } }),
      );
    } catch {
      /* no-op */
    }
  }
}

export const runningActivityTracker = new RunningActivityTrackerClass();
