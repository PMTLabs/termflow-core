import { termDiag } from '../utils/diag';
import { clearZoom } from '../store/slices/zoomSlice';
import { reassertOwnerAfterSpawn } from './paneOwnership';
import type { PromptGate } from '@termflow/terminal-core';

export interface TerminalProcess {
  id: string;
  terminalId: string;
}

class TerminalServiceClass {
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
  // Single-flight guard keyed by leaf (terminalId): a re-entrant restart/create
  // for the same leaf (e.g. a double Restart click or Ctrl+R key-repeat while
  // `closedInfo` is still set — review 109 H1) must not reach the backend twice,
  // since two spawns for one leaf register two `Terminal` rows under the same
  // `renderer_terminal_id`, breaking the PRIMARY KEY invariant. Cleared in a
  // `finally` so a failed create does not permanently poison the leaf.
  private inFlightCreates: Map<string, Promise<string>> = new Map();

  constructor() {
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
      console.log(`TerminalService: Received terminal data for process ${processId}, length: ${data.length}`);
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
    /** The tab that owns this pane. Equal to `terminalId` for a tab root; the
     *  owning `tb-` id for a split (`tm-`) pane. Design 011 §6: the backend
     *  cannot derive it — ownership lives only in `panes.treesByTabId`. */
    owningTabId?: string,
  ): Promise<string> {
    // Re-entrant call for the same leaf while a create is already pending:
    // return the SAME in-flight promise instead of starting a second spawn.
    const pending = this.inFlightCreates.get(terminalId);
    if (pending) {
      console.log(`TerminalService: Create already in flight for ${terminalId}, reusing pending promise`);
      return pending;
    }
    const createPromise = this.createTerminalInner(terminalId, shellType, name, cwd, cols, rows, owningTabId);
    this.inFlightCreates.set(terminalId, createPromise);
    try {
      return await createPromise;
    } finally {
      // Only clear if we're still the current entry (guards against a later
      // caller having already replaced it, though callers always await before
      // starting a new one so this is effectively always true).
      if (this.inFlightCreates.get(terminalId) === createPromise) {
        this.inFlightCreates.delete(terminalId);
      }
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
  ): Promise<string> {
    try {
      console.log(`TerminalService: Creating terminal ${terminalId} with shell type: "${shellType}", name: ${name}, cwd: ${cwd}`);

      // For pane terminals (created via splits), always create a new process
      const isPaneTerminal = terminalId.startsWith('tm-') || terminalId.startsWith('pane-terminal-');

      // Check if we already have a process for this terminal
      const existingProcess = this.processes.get(terminalId);
      if (existingProcess && !isPaneTerminal) {
        console.log(`TerminalService: Terminal ${terminalId} already has process ${existingProcess.id}, returning existing`);
        return existingProcess.id;
      } else if (existingProcess && isPaneTerminal) {
        console.log(`TerminalService: Terminal ${terminalId} is a pane terminal with existing process ${existingProcess.id}, will create new one`);
      }

      // Call IPC to create actual PTY process
      console.log(`TerminalService: Calling electronAPI.createTerminal with profileId: "${shellType}", cwd: "${cwd}", tabId: "${terminalId}"`);
      const processId = await window.electronAPI.createTerminal(shellType, name, cwd, terminalId, cols, rows, owningTabId);
      console.log(`TerminalService: Got process ID ${processId} for terminal ${terminalId} with shell type "${shellType}"`);

      // Store the mapping
      this.bindProcess(terminalId, processId);
      console.log(`TerminalService: Mapped terminal ${terminalId} to process ${processId}`);

      // The spawn carried the owner resolved BEFORE the await, and the backend
      // only registers the terminal at the very end of it — so a pane dragged to
      // another tab while this create was in flight had its ownership update
      // land on a terminal that did not exist yet, and nothing re-sends it
      // (external review 101, F2). This is the first moment the leaf is
      // registered, so it is where that correction belongs. No-ops unless the
      // tree moved under us.
      reassertOwnerAfterSpawn(terminalId, owningTabId);

      return processId;
    } catch (error) {
      console.error('Failed to create terminal:', error);
      console.error('Shell type was:', shellType);
      throw error;
    }
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
      await window.electronAPI.resizeTerminal(process.id, cols, rows);
    } catch (error) {
      console.error('Failed to resize terminal:', error);
      throw error;
    }
  }

  async closeTerminal(terminalId: string): Promise<void> {
    console.log(`TerminalService: closeTerminal called for ${terminalId}`);
    const process = this.processes.get(terminalId);
    if (!process) {
      console.log(`TerminalService: No process found for terminal ${terminalId} - already closed?`);
      return; // Already closed
    }

    console.log(`TerminalService: Found process ${process.id} for terminal ${terminalId}, calling electronAPI.closeTerminal`);
    try {
      await window.electronAPI.closeTerminal(process.id);
      this.processes.delete(terminalId);
      // Forget this terminal's per-pane zoom so closed terminals don't pile up in
      // the zoom slice. Moves use detachTerminal (which keeps the entry so zoom
      // survives the move), so clearing here only affects genuine closes. Dispatch
      // via the global store ref to avoid a static import of the whole store chain.
      (window as any).__REDUX_STORE__?.dispatch(clearZoom(terminalId));
      // Same reasoning for a handoff gate that never got consumed — e.g. a
      // cross-window-attached pane closed again before its mount effect ran.
      this.promptGateHandoff.delete(terminalId);
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
    window.electronAPI?.adoptConsoleWindow?.(processId)?.catch(() => { });
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
   * Drop this window's mapping + init guards for a terminal WITHOUT closing the
   * PTY — used when a pane is moved out of this window (detach / cross-window
   * drop). The process keeps running in the shared backend for the new owner.
   */
  detachTerminal(terminalId: string): void {
    this.processes.delete(terminalId);
    const w = window as any;
    w.terminalInitLock?.delete(terminalId);
    w.terminalInitPromises?.delete(terminalId);
    w.terminalInitMap?.delete(terminalId);
    // A pane attached-but-not-yet-mounted here, then detached again to a THIRD
    // window before it ever mounted, would otherwise leak this entry forever.
    this.promptGateHandoff.delete(terminalId);
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