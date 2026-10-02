import { paneIncarnations, accepted, describePanes, type PaneCapture, type CreateMode, type PaneIncarnations } from './paneIncarnations';
import { termDiag } from '../utils/diag';
import { findTabIdByTerminalId } from '../store/slices/paneTreeOps';
import type { PaneNode } from '../store/slices/panesSlice';
import { isHostOwnershipPending, isLifecycleBusy } from './hostOwnershipPending';
import { isHostSessionContended } from './hostSessionContention';
import { clearZoom } from '../store/slices/zoomSlice';
import { reassertOwnerAfterSpawn } from './paneOwnership';
import { reassertLabelAfterSpawn } from './terminalLabelSync';
import { reassertTitleColorAfterSpawn } from './terminalTitleColorSync';
import type { KeyboardProtocolStateData, PromptGate } from '@termflow/terminal-core';

// The destination's create is refused as soon as the other window holds the session, but that
// window offers it only once its own create returns, which can take as long as the host
// request (bounded at 10 s). While the backend says a create for the leaf is still running the
// destination keeps asking, for longer than that bound; when nothing is running it asks only a
// few times, enough to cover the offer's own round trip.
const HANDOFF_IN_FLIGHT_POLL_MS = 250;
const HANDOFF_IN_FLIGHT_BUDGET_MS = 15_000;
const HANDOFF_IDLE_ATTEMPTS = 3;
const HANDOFF_IDLE_DELAY_MS = 200;

export type HostWaitState = 'waiting' | 'retry' | undefined;

export interface TerminalProcess {
  id: string;
  terminalId: string;
}

export class TerminalServiceClass {
  private processes: Map<string, TerminalProcess> = new Map();
  private listenersInitialized = false;
  // Backlog 011 prompt-gate handoff for a cross-window attach: stashed here by
  // attachExistingTerminal, consumed once by TerminalDisplay's mount effect
  // (as TerminalEngine's initialPromptGate option) before the engine's own
  // terminalCache entry exists in this window.
  private promptGateHandoff: Map<string, PromptGate> = new Map();
  // Terminals reattaching to a PTY that outlived this renderer (hot-swap update /
  // webview reload). Consumed once by TerminalDisplay as `initialWin32InputMode`;
  // see markReattachedSession.
  private win32InputModeHandoff: Set<string> = new Set();
  // Kitty / modifyOtherKeys state carried by a cross-window attach (the live
  // object stayed in the source window's heap). Consumed once by TerminalDisplay
  // as `initialKeyboardProtocol`, same lifecycle as promptGateHandoff.
  private keyboardProtocolHandoff: Map<string, KeyboardProtocolStateData> = new Map();
  // Double Restart clicks share a promise, but a different pane copy must still
  // ask for its own admission. Older backends retain the leaf-keyed guard.
  // Cleared in finally so a failed create never poisons the next attempt.
  private inFlightCreates = new Map<string | PaneCapture, { terminalId: string; promise: Promise<string> }>();
  // Leaves closed (not moved) in THIS window while their create was in flight. A create
  // that comes back for a leaf this window no longer has closes the new shell instead of
  // offering it to another window when the user closed the pane here. A close in any
  // other window is not seen by this one.
  private closedWhileCreating: Set<string> = new Set();

  private hostWaitStates = new Map<string, HostWaitState>();

  constructor(
    private readonly paneTrees: () => Record<string, PaneNode | null> =
      () => (window as any).__REDUX_STORE__?.getState().panes.treesByTabId ?? {},
    private readonly api: () => typeof window.electronAPI = () => window.electronAPI,
    private readonly incarnations: () => PaneIncarnations = () => paneIncarnations,
  ) {
    // Initialize listeners immediately and synchronously
    this.initializeListeners();
    // Also try to initialize on DOMContentLoaded if not already done
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.initializeListeners());
    }
  }

  private initializeListeners(): void {
    if (this.listenersInitialized || !window.electronAPI) {
      console.log(`TerminalService: Skipping listener init - initialized: ${this.listenersInitialized}, API available: ${!!window.electronAPI}`);
      return;
    }

    console.log('TerminalService: Initializing IPC listeners');

    // Set up global listeners once
    window.electronAPI.onTerminalData((processId: string, data: string) => {
      // Behind the diag gate, like every other hot-path trace in this file (see the
      // PTY-resize trace below). This ran on EVERY chunk of PTY output, ungated, for
      // the life of the session — and `termDiag` takes a thunk, so with diag off the
      // template is never even built. An always-on log here is not free: with DevTools
      // attached the console retains every message, so a long agent session grows the
      // renderer's memory and slows the console down the longer it runs.
      termDiag(() => `[TERM-DIAG] terminal data (processId=${processId} length=${data.length})`);
      // Always emit the event - let TerminalDisplay filter by processId
      window.dispatchEvent(new CustomEvent('pty:data', {
        detail: { processId, data }
      }));
    });

    window.electronAPI.onTerminalExit((processId: string, exitCode: number, cwd?: string | null) => {
      // Resolve the UI terminalId mapped to this backend process so listeners
      // (e.g. tab close/mark-terminated logic) know which tab/pane exited.
      let exitedTerminalId: string | undefined;
      for (const [terminalId, process] of this.processes) {
        if (process.id === processId) {
          exitedTerminalId = terminalId;
          this.processes.delete(terminalId);
          // An attached-but-never-mounted pane's handoff would otherwise leak, and
          // — since terminalId reuse is exactly what this cleanup enables below —
          // a later fresh session on the same id could wrongly inherit a stale gate.
          this.promptGateHandoff.delete(terminalId);
          this.keyboardProtocolHandoff.delete(terminalId);

          // Also clean up from the global terminal init map (if available)
          // This allows re-creation if the same terminalId is used again
          if ((window as any).terminalInitMap) {
            (window as any).terminalInitMap.delete(terminalId);
          }
          if ((window as any).terminalInitPromises) {
            (window as any).terminalInitPromises.delete(terminalId);
          }
          if ((window as any).terminalInitLock) {
            (window as any).terminalInitLock.delete(terminalId);
          }
          break;
        }
      }

      // Always emit the event (with the resolved terminalId when known)
      // `cwd` (spec 045 §3.3): the shell's last directory, captured backend-side
      // before cleanup. The renderer cannot read it back after this event.
      window.dispatchEvent(new CustomEvent('pty:exit', {
        detail: { processId, exitCode, terminalId: exitedTerminalId, cwd }
      }));
    });

    this.listenersInitialized = true;
  }

  async createTerminal(
    terminalId: string,
    shellType: string = 'default',
    name?: string,
    cwd?: string,
    cols?: number,
    rows?: number,
    /** The `tb-` id of the tab that owns this pane — always a SEPARATE identity
     *  from `terminalId`, and since design 014 never equal to it: every root leaf
     *  is a minted `tm-*`, exactly like a split's. Root-vs-split is tree
     *  structure, not an id relationship. Design 011 §6: the backend cannot
     *  derive this — ownership lives only in `panes.treesByTabId`. Undefined
     *  when the tree has not been committed yet; `reassertOwnerAfterSpawn`
     *  supplies the owner once it lands. */
    owningTabId?: string,
    /** The pty-host session key when it differs from `terminalId` — set only on
     *  a pane migrated from a pre-014 build, whose armed session the host still
     *  knows by its old `tb-` id. Dropping this argument would silently orphan
     *  that session: the same trap design 011 6 called out for `owningTabId`,
     *  where assigning the Rust field without plumbing is a no-op. */
    sessionKey?: string,
    /** Plan 045: spawn this pane against the UAC-elevated sidecar instead of
     *  the primary one. Undefined/false for every ordinary pane. */
    elevated?: boolean,
    mode: CreateMode = 'Mount',
    paneId?: string,
  ): Promise<string> {
    // Re-entrant calls for this copy share the pending placement, not another copy's authority.
    const protocol = this.incarnations();
    const createKey = protocol.enabled ? this.capturePane(terminalId, paneId) ?? terminalId : terminalId;
    const pending = this.inFlightCreates.get(createKey)
      ?? (!protocol.enabled ? [...this.inFlightCreates.values()].find(entry => entry.terminalId === terminalId) : undefined);
    if (pending) {
      console.log(`TerminalService: Create already in flight for ${terminalId}, reusing pending promise`);
      return pending.promise;
    }
    // A close recorded for an earlier create of this leaf says nothing about this one.
    this.closedWhileCreating.delete(terminalId);
    // Keep the ordinary path explicit at the renderer/bridge boundary.  Leaving
    // this as `undefined` relies on JSON serialization to omit the field and
    // makes an old bridge/backend pair indistinguishable from an admin request
    // that failed to carry its flag.  Every non-admin pane is deliberately
    // routed as `false`; only the pane-tree marker can opt into elevation.
    const createPromise = this.createTerminalWithRetry(
      terminalId, shellType, name, cwd, cols, rows, owningTabId, sessionKey,
      elevated === true, mode, paneId, typeof createKey === 'string' ? undefined : createKey,
    );
    this.inFlightCreates.set(createKey, { terminalId, promise: createPromise });
    try {
      return await createPromise;
    } finally {
      // Only clear if we're still the current entry (guards against a later
      // caller having already replaced it, though callers always await before
      // starting a new one so this is effectively always true).
      if (this.inFlightCreates.get(createKey)?.promise === createPromise) {
        this.inFlightCreates.delete(createKey);
        this.closedWhileCreating.delete(terminalId);
      }
    }
  }

  getHostWaitState(terminalId: string): HostWaitState {
    return this.hostWaitStates.get(terminalId);
  }

  private setHostWaitState(terminalId: string, state: HostWaitState): void {
    if (state) this.hostWaitStates.set(terminalId, state);
    else this.hostWaitStates.delete(terminalId);
    window.dispatchEvent(new CustomEvent('pty:host-wait', { detail: { terminalId, state } }));
  }

  /** The single-flight promise includes sleeps, so a remount cannot race the next attach. */
  private async createTerminalWithRetry(
    terminalId: string, shellType: string, name?: string, cwd?: string,
    cols?: number, rows?: number, owningTabId?: string, sessionKey?: string, elevated?: boolean,
    mode: CreateMode = 'Mount', paneId?: string, pi?: PaneCapture,
  ): Promise<string> {
    let hostDeadline: number | undefined;
    let lifecycleDeadline: number | undefined;
    let hostDelay = 1000;
    let firstAttempt = true;
    this.setHostWaitState(terminalId, undefined);
    while (true) {
      if (this.incarnations().ended
          || (this.incarnations().enabled && (this.incarnations().capture(terminalId, paneId) !== pi || (pi && this.incarnations().isSuppressed(pi))))) return '';
      // A move is not a close. Only this webview's trees may authorize its next attempt.
      const owner = findTabIdByTerminalId(this.paneTrees(), terminalId);
      if (!owner) {
        this.setHostWaitState(terminalId, undefined);
        return ''; // Silent cancellation; never forget restore intent on a move.
      }
      const attemptOwner = firstAttempt ? owningTabId : owner;
      firstAttempt = false;
      try {
        const pid = await this.createTerminalInner(
          terminalId, shellType, name, cwd, cols, rows, attemptOwner, sessionKey, elevated, mode, paneId, pi,
        );
        this.setHostWaitState(terminalId, undefined);
        return pid;
      } catch (error) {
        if (this.incarnations().ended
            || (this.incarnations().enabled && (this.incarnations().capture(terminalId, paneId) !== pi || (pi && this.incarnations().isSuppressed(pi))))) return '';
        // An attempt can be in flight when the pane moves away. Whatever it
        // reports, this window no longer has a pane to report it to.
        if (!findTabIdByTerminalId(this.paneTrees(), terminalId)) {
          this.setHostWaitState(terminalId, undefined);
          return '';
        }
        // The other side of that move: the window the pane left won the session
        // while this window's own create was refused, and offers it to whichever
        // window has the pane now. Only a contention can mean that.
        if (isHostSessionContended(error) && !this.incarnations().enabled) {
          const adopted = await this.takeOfferedSession(terminalId);
          if (adopted !== undefined) {
            this.setHostWaitState(terminalId, undefined);
            return adopted;
          }
        }
        if (!isHostOwnershipPending(error) && !isLifecycleBusy(error)) {
          this.setHostWaitState(terminalId, undefined);
          throw error;
        }
        const now = Date.now();
        const hostPending = isHostOwnershipPending(error);
        if (hostPending) hostDeadline ??= now + 90_000;
        else lifecycleDeadline ??= now + 10_000;
        const deadline = hostPending ? hostDeadline! : lifecycleDeadline!;
        if (now >= deadline) {
          this.setHostWaitState(terminalId, hostPending ? 'retry' : undefined);
          throw error;
        }
        if (hostPending) this.setHostWaitState(terminalId, 'waiting');
        const delay = Math.min(hostPending ? hostDelay : 500, deadline - now);
        if (hostPending) hostDelay = Math.min(hostDelay * 2, 8000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Bind to the session another window offered for this leaf. The offer may still
   * be on its way: while the backend reports the other window's create as running
   * this keeps asking (up to the in-flight budget); once nothing is running it asks
   * a few more times, counted from the last answer that said something was. `undefined`
   * when no offer shows up (a recovery pane that lost to another pane, or a shell
   * another window is showing, keeps its refusal); `''` when the leaf left this window
   * meanwhile.
   */
  private async takeOfferedSession(terminalId: string): Promise<string | undefined> {
    const deadline = Date.now() + HANDOFF_IN_FLIGHT_BUDGET_MS;
    let idleAnswers = 0;
    let delay = 0;
    while (true) {
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
        if (!findTabIdByTerminalId(this.paneTrees(), terminalId)) return '';
      }
      let answer: Awaited<ReturnType<typeof window.electronAPI.takeSessionHandoff>> | undefined;
      try {
        answer = await this.api().takeSessionHandoff?.(terminalId);
      } catch (error) {
        console.warn(`TerminalService: could not take the offered session of ${terminalId}:`, error);
        return undefined;
      }
      if (answer?.status === 'taken') {
        const processId = answer.processId;
        if (!findTabIdByTerminalId(this.paneTrees(), terminalId)) {
          // The offer is spent; whoever has the pane now needs it again.
          await this.releaseAbsentCreate(terminalId, processId);
          return '';
        }
        console.log(`TerminalService: ${terminalId} took over the session ${processId} offered for it`);
        this.bindCreated(terminalId, processId, undefined);
        return processId;
      }
      if (answer?.status === 'inFlight') {
        if (Date.now() >= deadline) return undefined;
        idleAnswers = 0;
        delay = HANDOFF_IN_FLIGHT_POLL_MS;
        continue;
      }
      if (++idleAnswers >= HANDOFF_IDLE_ATTEMPTS) return undefined;
      delay = HANDOFF_IDLE_DELAY_MS;
    }
  }

  /**
   * A create produced `processId` for a leaf this window no longer has. A pane the
   * user closed in this window gets its new shell closed; a pane that moved has the
   * shell offered to the window that has it now. Binding it here would leave two
   * windows holding one shell.
   */
  private async releaseAbsentCreate(terminalId: string, processId: string): Promise<void> {
    // Ownership follows the pane/transfer in the backend, even if placement finishes later.
    if (this.incarnations().enabled || this.incarnations().ended) return;
    if (this.closedWhileCreating.has(terminalId)) {
      console.log(`TerminalService: ${terminalId} was closed during its create; closing process ${processId}`);
      try {
        await this.api().closeTerminal(processId);
      } catch (error) {
        console.error(`TerminalService: could not close the shell ${processId} of the closed pane ${terminalId}:`, error);
      }
      return;
    }
    console.log(`TerminalService: ${terminalId} left this window during its create; offering process ${processId} to its new window`);
    try {
      await this.api().offerSessionHandoff?.(terminalId, processId);
    } catch (error) {
      console.warn(`TerminalService: could not offer the session of ${terminalId}:`, error);
    }
  }

  private async createTerminalInner(
    terminalId: string,
    shellType: string = 'default',
    name?: string,
    cwd?: string,
    cols?: number,
    rows?: number,
    owningTabId?: string,
    sessionKey?: string,
    elevated: boolean = false,
    mode: CreateMode = 'Mount', paneId?: string, attemptPi?: PaneCapture,
  ): Promise<string> {
    try {
      console.log(`TerminalService: Creating terminal ${terminalId} with shell type: "${shellType}", name: ${name}, cwd: ${cwd}`);

      // A reaching-this-far create always spawns. The reuse decision belongs to
      // TerminalPane's mount effect, which checks `getProcessId` before calling
      // at all; a caller that gets here with a stale binding (restart in place)
      // wants a NEW process.
      //
      // There was a root-vs-split branch here — `tm-`/`pane-terminal-` leaves fell
      // through to a fresh spawn, anything else returned the existing process.
      // Design 014 mints a `tm-` leaf for every pane, so the "anything else" arm
      // could no longer be reached.
      const existingProcess = this.processes.get(terminalId);
      if (existingProcess) {
        console.log(`TerminalService: Terminal ${terminalId} has existing process ${existingProcess.id}, will create new one`);
      }

      // Call IPC to create actual PTY process
      console.log(`TerminalService: Calling electronAPI.createTerminal with profileId: "${shellType}", cwd: "${cwd}", tabId: "${terminalId}"`);
      let processId: string;
      const protocol = this.incarnations();
      let admission: Awaited<ReturnType<PaneIncarnations['admit']>> = { status: 'Inert' };
      if (protocol.enabled) {
        if (!attemptPi) throw new Error('host-session-contended: pane copy is not present');
        admission = await protocol.admit(attemptPi, mode);
      }
      if (admission.status === 'Inert') {
        processId = await this.api().createTerminal(shellType, name, cwd, terminalId, cols, rows, owningTabId, sessionKey, elevated);
      } else if (admission.status === 'Existing' || admission.status === 'AlreadyBound') {
        processId = admission.pc;
      } else if (admission.status === 'Create' || admission.status === 'Join') {
        const created = await protocol.create(admission.cg, {
          leaf: terminalId, profile: shellType, name, cwd, cols, rows, owningTabId, sessionKey, elevated,
        });
        if (protocol.ended) return '';
        processId = created ?? await this.api().createTerminal(shellType, name, cwd, terminalId, cols, rows, owningTabId, sessionKey, elevated);
      } else if (admission.status === 'Retry' || admission.status === 'Pending') {
        throw new Error('LIFECYCLE_BUSY: placement is pending');
      } else {
        throw new Error('host-session-contended: pane copy does not own this shell');
      }
      console.log(`TerminalService: Got process ID ${processId} for terminal ${terminalId} with shell type "${shellType}"`);

      // The pane may have left this window while this create was in flight.
      if (protocol.ended) return '';
      if (!findTabIdByTerminalId(this.paneTrees(), terminalId)
          || (protocol.enabled && (protocol.capture(terminalId, paneId) !== attemptPi || (attemptPi && protocol.isSuppressed(attemptPi))))) {
        await this.releaseAbsentCreate(terminalId, processId);
        return '';
      }

      this.bindCreated(terminalId, processId, owningTabId);

      return processId;
    } catch (error) {
      if (!isHostOwnershipPending(error) && !isLifecycleBusy(error)) {
        console.error('Failed to create terminal:', error);
        console.error('Shell type was:', shellType);
      }
      throw error;
    }
  }

  /** Everything a window does once a create has produced the process for `terminalId`. */
  private bindCreated(terminalId: string, processId: string, owningTabId: string | undefined): void {
    // Store the mapping
    this.bindProcess(terminalId, processId);
    console.log(`TerminalService: Mapped terminal ${terminalId} to process ${processId}`);

    // A FRESH spawn. Announced so RunningActivityTracker can give this shell's startup
    // banner the same grace the app-start path already gives a restored one — see
    // SPAWN_GRACE_MS. Without it a terminal notifies about its own prompt.
    //
    // Here rather than in `bindProcess`, which looks like the tidier home and is the wrong
    // one: that is also where a cross-window attach and a hot-swap reattach bind, and those
    // processes are already running — their output is genuine activity the user may well
    // have missed, not a banner they just asked for.
    //
    // An event rather than a direct call, for the reason `pty:resize` documents below: the
    // tracker already imports this module, so calling it would be a cycle.
    window.dispatchEvent(new CustomEvent('pty:spawn', {
      detail: { processId, terminalId },
    }));

    // The spawn carried the owner resolved BEFORE the await, and the backend
    // only registers the terminal at the very end of it — so a pane dragged to
    // another tab while this create was in flight had its ownership update
    // land on a terminal that did not exist yet, and nothing re-sends it
    // (external review 101, F2). This is the first moment the leaf is
    // registered, so it is where that correction belongs. No-ops unless the
    // tree moved under us.
    reassertOwnerAfterSpawn(terminalId, owningTabId);
    // Same race, and labels need it MORE: the owner was at least sent as a spawn parameter, so
    // the re-assert only corrects a move. No label is sent at spawn, so without this a terminal
    // created before its tree was committed has no label for the rest of the session.
    reassertLabelAfterSpawn(terminalId);
    reassertTitleColorAfterSpawn(terminalId);
  }

  async writeToTerminal(terminalId: string, data: string): Promise<void> {
    const process = this.processes.get(terminalId);
    if (!process) {
      // Don't throw error, just log warning - terminal might be initializing
      console.warn(`No process found for terminal ${terminalId} - might be initializing. Available terminals:`, Array.from(this.processes.keys()));
      return;
    }

    try {
      await window.electronAPI.writeToTerminal(process.id, data);
    } catch (error) {
      console.error('Failed to write to terminal:', error);
      throw error;
    }
  }

  async resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
    const process = this.processes.get(terminalId);
    if (!process) {
      // Don't throw error, just log warning - terminal might be initializing
      console.warn(`No process found for terminal ${terminalId} - might be initializing`);
      return;
    }

    try {
      termDiag(() => `[TERM-DIAG] PTY resize -> ${cols}x${rows} (terminalId=${terminalId} processId=${process.id})`);
      // The `pty:resize` announcement that arms RunningActivityTracker's view-change burst
      // suppression is emitted by `electronAPI.resizeTerminal` itself (see `ptyResizeSignal`),
      // NOT here.
      //
      // It used to be dispatched on this line, on the strength of this being "the single
      // choke point every renderer-caused resize goes through". It was not one: input and
      // resize flow engine -> bridge -> electronAPI (spec §6.1 / §17 R2), so this method's
      // only remaining caller is the `onResize` prop `TerminalDisplay` discards as vestigial,
      // and the event was never dispatched in the running app. Moving it one level down onto
      // the entry point every sender actually shares is what makes it impossible for a sender
      // to opt out — and leaving a second dispatch here would put two writers on one signal,
      // where the live one masks the next caller that forgets it.
      await window.electronAPI.resizeTerminal(process.id, cols, rows);
    } catch (error) {
      console.error('Failed to resize terminal:', error);
      throw error;
    }
  }

  capturePane(terminalId: string, paneId?: string): PaneCapture | undefined {
    const protocol = this.incarnations();
    const captured = protocol.capture(terminalId, paneId);
    if (captured) return captured;
    const panes = Object.values(this.paneTrees()).flatMap(tree => describePanes(tree));
    const pane = panes.find(p => p.leaf === terminalId && (!paneId || p.paneId === paneId));
    return pane ? protocol.prepare([pane])[0] : undefined;
  }

  async authorizeExisting(terminalId: string, processId: string, paneId?: string): Promise<boolean> {
    const protocol = this.incarnations();
    if (!protocol.enabled) return true;
    const pi = this.capturePane(terminalId, paneId);
    return !!pi && accepted(await protocol.bind(pi, processId, 'restore'));
  }

  async closeTerminal(terminalId: string, captured?: PaneCapture | PaneCapture[]): Promise<void> {
    console.log(`TerminalService: closeTerminal called for ${terminalId}`);
    const protocol = this.incarnations();
    if (protocol.ended) return;
    const pi = captured ?? protocol.captureClose(terminalId);
    const pis = Array.isArray(pi) ? pi : pi ? [pi] : [];
    // Queue every copy before any await: a tab can hold several copies of one leaf.
    const closing = Promise.all(pis.map(copy => protocol.close(copy)));
    const process = this.processes.get(terminalId);
    const results = protocol.enabled ? await closing : [{ status: 'Inert' } as const];
    const ownedClose = results.every(result => result.status !== 'Inert');
    if (ownedClose && !results.some(accepted)) return;
    if (!process) {
      console.log(`TerminalService: No process found for terminal ${terminalId} - already closed?`);
      if (!ownedClose && [...this.inFlightCreates.values()].some(entry => entry.terminalId === terminalId)) this.closedWhileCreating.add(terminalId);
      this.setHostWaitState(terminalId, undefined);
      return; // A waiting restored pane has no process, but still has restore intent.
    }

    console.log(`TerminalService: Found process ${process.id} for terminal ${terminalId}, calling electronAPI.closeTerminal`);
    try {
      if (!ownedClose) await this.api().closeTerminal(process.id);
      if (this.processes.get(terminalId) !== process) return;
      this.processes.delete(terminalId);
      // Forget this terminal's per-pane zoom so closed terminals don't pile up in
      // the zoom slice. Moves use detachTerminal (which keeps the entry so zoom
      // survives the move), so clearing here only affects genuine closes. Dispatch
      // via the global store ref to avoid a static import of the whole store chain.
      (window as any).__REDUX_STORE__?.dispatch(clearZoom(terminalId));
      // Same reasoning for a handoff gate that never got consumed — e.g. a
      // cross-window-attached pane closed again before its mount effect ran.
      this.promptGateHandoff.delete(terminalId);
      this.keyboardProtocolHandoff.delete(terminalId);
      console.log(`TerminalService: Successfully closed and removed terminal ${terminalId} from process map`);
    } catch (error) {
      console.error('Failed to close terminal:', error);
      throw error;
    }
  }

  registerExistingTerminal(terminalId: string, processId: string): void {
    console.log(`TerminalService: Registering existing terminal ${terminalId} with process ${processId}`);
    this.bindProcess(terminalId, processId);
  }

  /**
   * The single point every path binds a terminal id to its backend process:
   * fresh spawn, cross-window attach, and hot-swap reattach all land here.
   *
   * Claiming the console window from here rather than at spawn time is
   * deliberate — the owner has to track the window the pane is CURRENTLY in, so
   * a pane dragged to another window re-owns instead of leaving its dialogs
   * pointed at the window it came from. Best-effort: the only thing a failure
   * costs is the (Windows-only) console-dialog fix.
   */
  private bindProcess(terminalId: string, processId: string): void {
    this.processes.set(terminalId, {
      id: processId,
      terminalId
    });
    this.api()?.adoptConsoleWindow?.(processId)?.catch(() => { });
  }

  /**
   * Attach a pane in THIS window to an already-running PTY owned by the shared
   * backend (used when a pane is detached into a new window or dropped onto
   * another window). Beyond registering the id→process mapping, it pre-seeds the
   * global init guards so TerminalPane's mount effect reuses the live process and
   * never spawns a duplicate — including for `tm-`/`pane-terminal-` ids, which
   * normally always create a fresh process.
   */
  attachExistingTerminal(terminalId: string, processId: string, promptGate?: PromptGate | null): void {
    this.registerExistingTerminal(terminalId, processId);
    const w = window as any;
    if (w.terminalInitLock) w.terminalInitLock.set(terminalId, true);
    if (w.terminalInitPromises) w.terminalInitPromises.set(terminalId, Promise.resolve(processId));
    if (w.terminalInitMap) w.terminalInitMap.set(terminalId, true);
    if (promptGate) this.promptGateHandoff.set(terminalId, promptGate);
    console.log(`TerminalService: Attached existing terminal ${terminalId} -> process ${processId} (guards seeded)`);
  }

  /**
   * Stash a prompt-gate for `terminalId`'s next engine mount WITHOUT touching the
   * process registration (unlike attachExistingTerminal, which also seeds the
   * reuse guards). Used by the core-restart hot-swap path: the pane spawns via
   * createTerminal (so the process is already registered), then this seeds the
   * gate the backend reattach reported, to be consumed by takePromptGateHandoff
   * when the engine mounts. Null clears any pending stash.
   */
  stashPromptGate(terminalId: string, gate: PromptGate | null): void {
    if (gate) this.promptGateHandoff.set(terminalId, gate);
    else this.promptGateHandoff.delete(terminalId);
  }

  /**
   * Single-use: returns the prompt-gate carried by a cross-window attach for
   * `terminalId` (if any) and clears it, so it's applied only to that pane's
   * first-ever mount in this window.
   */
  takePromptGateHandoff(terminalId: string): PromptGate | undefined {
    const gate = this.promptGateHandoff.get(terminalId);
    this.promptGateHandoff.delete(terminalId);
    return gate;
  }

  /**
   * Mark `terminalId` as REATTACHING to a PTY session that outlived this renderer
   * (hot-swap update or webview reload), so its next engine mount re-seeds
   * Win32-Input-Mode. ConPTY announced ?9001h once at session start, long before
   * this renderer existed, and no stream we can still read replays it — without
   * the seed the pane sends legacy bytes to a ConPTY expecting records and Escape
   * never reaches the app. Platform-agnostic on purpose: the engine ignores it
   * off-Windows, so callers stay dumb.
   */
  markReattachedSession(terminalId: string): void {
    this.win32InputModeHandoff.add(terminalId);
  }

  /**
   * Single-use companion to markReattachedSession, consumed by TerminalDisplay as
   * the engine's `initialWin32InputMode` — so an ordinary same-session remount
   * (which adopts the live state from the terminalCache) never gets seeded.
   */
  takeWin32InputModeHandoff(terminalId: string): boolean {
    return this.win32InputModeHandoff.delete(terminalId);
  }

  /**
   * Stash the Kitty / modifyOtherKeys state a cross-window detach carried for
   * `terminalId`'s first-ever mount in this window. The app pushed its flags once
   * in the SOURCE window and will not repeat them here; without this the pane
   * sends legacy encodings to a TUI that negotiated CSI u. Null clears any stash.
   */
  stashKeyboardProtocol(terminalId: string, data: KeyboardProtocolStateData | null): void {
    if (data) this.keyboardProtocolHandoff.set(terminalId, data);
    else this.keyboardProtocolHandoff.delete(terminalId);
  }

  /**
   * Single-use companion to stashKeyboardProtocol, consumed by TerminalDisplay as
   * the engine's `initialKeyboardProtocol` — first-ever mount only, like the
   * prompt gate; a same-window remount adopts the live cache entry instead.
   */
  takeKeyboardProtocolHandoff(terminalId: string): KeyboardProtocolStateData | undefined {
    const data = this.keyboardProtocolHandoff.get(terminalId);
    this.keyboardProtocolHandoff.delete(terminalId);
    return data;
  }

  /**
   * Drop this window's mapping + init guards for a terminal WITHOUT closing the
   * PTY — used when a pane is moved out of this window (detach / cross-window
   * drop). The process keeps running in the shared backend for the new owner.
   */
  detachTerminal(terminalId: string): void {
    this.processes.delete(terminalId);
    this.hostWaitStates.delete(terminalId);
    const w = window as any;
    w.terminalInitLock?.delete(terminalId);
    w.terminalInitPromises?.delete(terminalId);
    w.terminalInitMap?.delete(terminalId);
    // A pane attached-but-not-yet-mounted here, then detached again to a THIRD
    // window before it ever mounted, would otherwise leak this entry forever.
    this.promptGateHandoff.delete(terminalId);
    this.keyboardProtocolHandoff.delete(terminalId);
    console.log(`TerminalService: Detached terminal ${terminalId} (PTY left running)`);
  }

  getProcessId(terminalId: string): string | undefined {
    return this.processes.get(terminalId)?.id;
  }

  getProcessIdForTerminal(terminalId: string): string | undefined {
    return this.processes.get(terminalId)?.id;
  }

  // Reverse of getProcessIdForTerminal: find the UI terminalId for a backend
  // processId (used to attribute pty:data output, which is keyed by processId).
  getTerminalIdForProcess(processId: string): string | undefined {
    for (const [terminalId, proc] of this.processes) {
      if (proc.id === processId) return terminalId;
    }
    return undefined;
  }
}

export const terminalService = new TerminalServiceClass();
