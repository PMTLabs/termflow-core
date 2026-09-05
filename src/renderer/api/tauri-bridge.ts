import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import type { TerminalSnapshot, ActiveProcess, PeerInfo, PeerRequestInfo, PairingCode, FabricStatus, GrantLevel, AutomationRule, AutomationLogEntry, AutomationSaveResult, WatchableTerminal, DryRunReport } from '../types/electron';
import type { AutomationStatePayload } from '../services/automationEvents';
import { shouldHandleForWindow } from './windowRouting';
import { emitPtyInput } from '../utils/ptyInputSignal';
import { emitPtyResize } from '../utils/ptyResizeSignal';
import { apiTokenKey } from '../services/profileScope';
import { apiBase, invalidateApiBase } from './apiBase';

export interface NetworkConfig {
  apiPort: number;
  mcpPort: number;
  exposeOnNetwork: boolean;
  authToken: string;
}

/** See `EffectiveEndpoints` in `../types/electron`. */
export interface EffectiveEndpoints {
  apiPort: number | null;
  mcpPort: number | null;
}

// Velopack update availability (mirrors the Rust UpdateStatus enum).
export type UpdateStatus =
  | { state: 'notInstalled' }
  | { state: 'upToDate' }
  | { state: 'available'; version: string }
  | { state: 'unavailable' };

export interface NetworkInterfaceInfo {
  name: string;
  label: string;
  ip: string;
}

// Define the interface to match existing usage
interface ElectronAPI {
  getTerminalOutput: (terminalId: string, lines?: number, offset?: number) => Promise<{
    totalLines: number;
    offset: number;
    raw: string;
  }>;
  getTerminalSnapshot: (terminalId: string, cols?: number, rows?: number) => Promise<TerminalSnapshot>;
  getTerminalFullScrollback: (terminalId: string) => Promise<{ blob: string; rows: number; cols: number }>;
  /// PLAIN text of the current visible screen, from the backend's vt100 parser.
  /// Distinct from `getTerminalSnapshot`, which returns a STYLED blob meant to be
  /// replayed into an xterm instance; this one is text a caller can match against
  /// directly. `screen` is the whole viewport in one string, not a row array.
  getTerminalScreenText: (terminalId: string) => Promise<{ screen: string; rows: number; cols: number }>;
  getActiveProcesses: () => Promise<ActiveProcess[]>;
  createTerminal: (profile?: string, name?: string, cwd?: string, tabId?: string, cols?: number, rows?: number, owningTabId?: string, sessionKey?: string) => Promise<string>;
  /// Windows: make THIS window the owner of the shell's ConPTY pseudo-console
  /// window, so dialogs a console program parents to `GetConsoleWindow()` (the
  /// `az login` WAM prompt) open in front instead of behind the app. Fired on
  /// every process bind, so a pane moved between windows re-owns to the new one.
  adoptConsoleWindow: (processId: string) => Promise<void>;
  /// Re-point a live terminal's owning tab after its pane was moved into a
  /// different tab. Keyed by the renderer LEAF — two id FORMS, naming who minted
  /// the leaf and NOT the pane's shape: `tb-*` for a renderer-created tab root,
  /// `tm-*` for split panes AND for every API-created terminal, including a solo
  /// root. Shape comes only from the pane tree, and a leaf keeps its id when
  /// moved — see services/paneOwnership.ts.
  setTerminalOwningTab: (rendererTerminalId: string, owningTabId: string) => Promise<void>;
  /// Push the tab/pane title this window shows for a terminal down to the backend, keyed by the
  /// durable `tm-` LEAF. Writes `Terminal.display_label`, never `Terminal.name` — `name` is on the
  /// wire in `/api/terminals` and is what MCP returns, so changing what it holds would change what
  /// agents see. See services/terminalLabelSync.ts.
  setTerminalDisplayLabel: (rendererTerminalId: string, label: string) => Promise<void>;
  getActiveWindow: () => Promise<string>;
  setActiveWindow: (label: string) => Promise<void>;
  /// Ask the backend to open/activate the Settings tab in the current main window
  /// (broadcasts `settings:open`; see services/openSettings.ts) and focus it,
  /// regardless of which window this was invoked from.
  openSettingsInMainWindow: (category?: string) => Promise<void>;
  closeTerminal: (id: string) => Promise<void>;
  pruneTerminalHistory: (keepIds: string[]) => Promise<void>;
  writeToTerminal: (id: string, data: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  getTerminalSize: (id: string) => Promise<{ cols: number; rows: number }>;
  updateTerminalName: (id: string, name: string) => Promise<boolean>;
  getTerminalCwd: (processId: string) => Promise<string | null>;
  getTerminalCwds: (processIds: string[]) => Promise<Record<string, string | null>>;
  /// Backlog 011: drain the reattach prompt-gate hook for a terminal id (Some only
  /// when it was reattached after a core-restart hot-swap; null otherwise). Used to
  /// re-seed the command-suggest prompt gate after createTerminal resolves.
  takeReattachPromptHook: (id: string) => Promise<{ promptHook: boolean; atPrompt: boolean } | null>;
  /// Design 006 pre-mount probe (non-consuming): would the gate arm right now?
  probeReattachPromptGate: (processId: string) => Promise<{ promptHook: boolean; atPrompt: boolean } | null>;
  resolveTerminalPath: (processId: string, rel: string) => Promise<string[]>;
  openExternal: (url: string) => Promise<void>;
  /// Settings → Updates “Open developer tools”. The WebView2 right-click menu is
  /// cancelled in the backend (context_menu.rs), so this is the only way to DevTools.
  openDevtools: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  openInEditor: (editor: string, path: string, line?: number, col?: number) => Promise<void>;
  pickExecutablePath: () => Promise<string | null>;
  pickSnippetsExportPath: () => Promise<string | null>;
  pickSnippetsImportPath: () => Promise<string | null>;
  exportSnippetsFile: (path: string, json: string) => Promise<void>;
  importSnippetsFile: (path: string) => Promise<string>;
  sendToPty: (processId: string, data: string) => Promise<void>;
  resizePty: (processId: string, cols: number, rows: number) => Promise<void>;
  onTerminalData: (callback: (id: string, data: string) => void) => void;
  onTerminalExit: (callback: (id: string, code: number, cwd?: string | null) => void) => void;
  getShellProfiles: () => Promise<any[]>;
  getExecutableIcon: (path: string) => Promise<string>;
  getSystemInfo: () => Promise<any>;
  getConfig: () => Promise<any>;
  updateConfig: (updates: any) => Promise<void>;
  getConfigValue: (key: string) => Promise<any>;
  setConfigValue: (key: string, value: any) => Promise<void>;
  // Read a bundled legal document (EULA/privacy/licenses/notices) by filename.
  readLegalDocument: (name: string) => Promise<string>;
  // Open a bundled legal document in the OS-native text editor (bypasses IPC/DOM).
  openLegalDocument: (name: string) => Promise<void>;
  // Backlog 011: global command history for the suggestion popup.
  addCommandHistory: (command: string) => Promise<void>;
  loadCommandHistory: (limit?: number) => Promise<string[]>;
  deleteCommandHistory: (command: string) => Promise<void>;
  // Stream 4: per-directory command usage for cwd-relevant suggestion ranking.
  addCommandDirUsage: (command: string, dir: string) => Promise<void>;
  loadCommandDirUsage: (cwd: string) => Promise<import('../types/electron').DirUsageRow[]>;
  // Stream 5: "Open in TermFlow" folder context menu.
  takePendingOpenPath: () => Promise<string | null>;
  installFileManagerIntegration: () => Promise<void>;
  uninstallFileManagerIntegration: () => Promise<void>;
  isFileManagerIntegrationInstalled: () => Promise<boolean>;
  getDefaultProfile: () => Promise<string>;
  setDefaultProfile: (profileId: string) => Promise<void>;
  getTheme: () => Promise<any>;
  setTheme: (theme: any) => Promise<void>;
  generateAPIToken: (clientId: string, permissions?: string[]) => Promise<string>;
  getAPIConfig: () => Promise<any>;
  // Network settings (ports, expose-on-network, access token)
  getNetworkConfig: () => Promise<NetworkConfig>;
  getEffectiveEndpoints: () => Promise<EffectiveEndpoints>;
  setNetworkConfig: (apiPort: number, mcpPort: number, exposeOnNetwork: boolean) => Promise<NetworkConfig>;
  rotateAuthToken: () => Promise<NetworkConfig>;
  listNetworkInterfaces: () => Promise<NetworkInterfaceInfo[]>;
  stopServers: (target?: 'all' | 'api' | 'mcp') => Promise<void>;
  startServers: (target?: 'all' | 'api' | 'mcp') => Promise<void>;
  /// Arm the PTY host to keep terminals alive, then close the app so the exe can
  /// be rebuilt (hot-swap "offload"). Resolves never on success (the process
  /// exits); rejects with the refusal reason if hot-swap isn't possible.
  restartForUpdate: () => Promise<void>;
  /// Preflight for the offload/hot-swap: resolves if it would keep all terminals
  /// alive, rejects with the reason if it would currently be refused.
  ///
  /// THIS instance only. A sibling profile is not consulted: offload arms our own
  /// pty-host and exits this process, so it cannot reach one (design 014 B1.2).
  hotswapAvailable: () => Promise<void>;
  /// Move persisted scrollback from an old renderer leaf to a new one, for the
  /// design-014 migration of pre-014 tb- root leaves (StateManager restore).
  renameTerminalHistory: (from: string, to: string) => Promise<void>;
  /// Preflight for a Velopack update: ours PLUS every sibling, because the apply
  /// kills every process under the install root. Rejects naming any sibling that
  /// cannot be prepared. Deliberately separate from hotswapAvailable — the two
  /// verdicts differ, and sharing one made the panel disagree with the button.
  updateAvailable: () => Promise<void>;
  /// Check for a Velopack update. `unavailable` = no updater in this build.
  checkForUpdates: () => Promise<UpdateStatus>;
  /// The running app's version (from the Tauri config at build time).
  getAppVersion: () => Promise<string>;
  /// Download + arm + apply a Velopack update, keeping terminals alive.
  updateAndRestart: () => Promise<void>;
  getActiveTabAndPane: () => Promise<any>;
  createTerminalInTab: (tabId: string, paneId: string, profile: string, name: string) => Promise<any>;
  getTabs: () => Promise<any>;
  sendToMain: (channel: string, data: any) => void;
  checkConnectionHealth: () => Promise<Array<{name: string; url: string; healthy: boolean; active_clients?: number; conflict?: boolean}>>;
  confirmCloseApp: () => Promise<void>;
  /** Plan 018: report that this window has persisted its session, so a quit can proceed. */
  flushSessionAck: () => Promise<void>;
  /** Plan 018: every window id the backend registry currently holds. */
  listWindowSessionIds: () => Promise<string[]>;
  // Detach / cross-window pane handoff
  stashDetachPayload: (token: string, payload: any) => Promise<void>;
  takeDetachPayload: (token: string) => Promise<any | null>;
  createDetachedWindow: (token: string, x?: number, y?: number) => Promise<string>;
  createNewWindow: () => Promise<string>;
  getWindowLabel: () => string;
  // Canvas connection graph (plan/013 Task 18) — see the note in `types/electron.d.ts`.
  canvasApiRequest: (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
  // Cross-window drag broker (Phase 4)
  beginGlobalPaneDrag: (token: string, payload: any) => Promise<void>;
  claimGlobalPaneDrag: (token: string) => Promise<any | null>;
  resolveOrphanGlobalDrag: (token: string) => Promise<boolean>;
  cancelGlobalPaneDrag: (token: string) => Promise<void>;
  // Tab tear-off preview window
  showDragPreview: (title: string, x: number, y: number) => Promise<void>;
  moveDragPreview: (x: number, y: number) => Promise<void>;
  hideDragPreview: () => Promise<void>;
  // Cross-window tab drop (source-driven hit-test)
  resolveTabDrop: (token: string, x: number, y: number) => Promise<boolean>;
  // Rebuild the native Window menu (after a window's title changes)
  refreshWindowMenu: () => Promise<void>;
  // Set this window's display title (active tab) and rebuild the Window menu
  setWindowTitle: (title: string) => Promise<void>;
  // Destroy the current window (used when its last tab is dragged away)
  closeCurrentWindow: () => Promise<void>;
  // Quit the whole app (used by the first-run EULA "Decline").
  quitApp: () => Promise<void>;
  // Peering (termflow-fabric sidecar; Plan 010)
  peersList: () => Promise<PeerInfo[]>;
  pendingApprovalsList: () => Promise<PeerRequestInfo[]>;
  pairingCodeCreate: () => Promise<PairingCode>;
  peerAdd: (address: string, code: string) => Promise<void>;
  peerApprove: (deviceId: string, accept: boolean) => Promise<void>;
  peerRevoke: (deviceId: string) => Promise<void>;
  peerSetGrant: (deviceId: string, terminalId: string, level: GrantLevel | 'None') => Promise<void>;
  peerSetFleetExec: (deviceId: string, enabled: boolean) => Promise<void>;
  setAcceptPeers: (enabled: boolean) => Promise<void>;
  fabricStatus: () => Promise<FabricStatus>;
  // Background mode (Plan 010)
  setKeepRunningInBackground: (enabled: boolean) => Promise<void>;
  // Terminal Automations (Plan 028)
  listAutomations: () => Promise<AutomationRule[]>;
  getAutomationRuntime: () => Promise<AutomationStatePayload>;
  loadAutomationLog: (ruleId: string | null, newestFirst: boolean, limit: number) => Promise<AutomationLogEntry[]>;
  listWatchableTerminals: (ruleId: string | null, includeIds: string[] | null) => Promise<WatchableTerminal[]>;
  dryRunAutomation: (rule: AutomationRule, terminalId: string) => Promise<DryRunReport>;
  saveAutomation: (rule: AutomationRule, origin: string) => Promise<AutomationSaveResult>;
  deleteAutomation: (id: string, origin: string) => Promise<boolean>;
  duplicateAutomation: (id: string, origin: string) => Promise<AutomationRule>;
  setAutomationEnabled: (id: string, enabled: boolean, origin: string) => Promise<void>;
  resetAutomation: (id: string, origin: string) => Promise<void>;
  rearmAutomation: (ruleId: string, terminalId: string | null) => Promise<void>;
  addAutomationTarget: (ruleId: string, terminalId: string, origin: string) => Promise<boolean>;
  removeAutomationTarget: (
    ruleId: string,
    terminalIds: string[],
    origin: string,
  ) => Promise<boolean>;
  setAutomationVerbose: (
    ruleId: string,
    verboseUntil: number | null,
    origin: string,
  ) => Promise<boolean>;
}

// Every listen() returns Promise<UnlistenFn>; discarding it makes the
// subscription permanent (and they multiply on dev reload/HMR). Track them all
// so teardown can actually unlisten.
const bridgeUnlistens: Array<Promise<UnlistenFn>> = [];
const trackUnlisten = (p: Promise<UnlistenFn>): void => {
  bridgeUnlistens.push(p);
};
export const disposeBridgeListeners = (): void => {
  bridgeUnlistens.splice(0).forEach((p) => {
    p.then((un) => un()).catch(() => undefined);
  });
};

console.log('Initializing Tauri Bridge...');

// The API base URL is resolved from the port the backend actually BOUND, not the
// one it was configured with, and every call site awaits it — see `apiBase.ts`
// for why a compiled-in default or the configured port is another instance's
// server rather than a safe fallback.

// The auth token is per-instance CONFIG (not an address), so it still comes from
// `get_network_config`. When exposed on the network the backend enforces it on ALL
// requests, including this renderer's loopback calls; harmless in localhost mode.
invoke<{ authToken: string }>('get_network_config')
  .then((cfg) => {
    if (cfg?.authToken) {
      localStorage.setItem(apiTokenKey(), cfg.authToken);
    }
  })
  .catch(() => { /* the token stays whatever a previous session stored */ });

// Windows OS build number for xterm's `windowsPty.buildNumber` (the codex/ratatui ConPTY
// rendering fix). Fetched once at startup and cached so terminals can read it
// synchronously at mount; stays 0 until resolved and on non-Windows, in which case the
// engine assumes a modern ConPTY build (>= 21376, heuristic off). A terminal that mounts
// before this resolves just uses that safe modern fallback.
let windowsBuildNumber = 0;
invoke<number>('get_os_build_number')
  .then((n) => { if (typeof n === 'number' && n > 0) windowsBuildNumber = n; })
  .catch(() => { /* keep 0 → engine falls back to a modern build */ });

/** Cached Windows OS build number (0 until resolved or on non-Windows). */
export function getWindowsBuildNumber(): number {
  return windowsBuildNumber;
}

const buildAuthHeaders = (): Record<string, string> => {
  const token = localStorage.getItem(apiTokenKey());
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const tauriBridge: ElectronAPI = {
  getTerminalOutput: async (terminalId, lines = 1000, offset = 0) => {
    const response = await fetch(`${await apiBase()}/terminals/${terminalId}/output?lines=${lines}&offset=${offset}`, {
      headers: {
        ...buildAuthHeaders(),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch terminal output: ${response.status} ${response.statusText}`);
    }

    return response.json();
  },

  getTerminalSnapshot: async (terminalId, cols, rows) => {
    const params = new URLSearchParams();
    if (cols && cols > 0) params.set('cols', String(cols));
    if (rows && rows > 0) params.set('rows', String(rows));
    const query = params.toString();
    const response = await fetch(
      `${await apiBase()}/terminals/${terminalId}/snapshot${query ? `?${query}` : ''}`,
      { headers: { ...buildAuthHeaders() } }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch terminal snapshot: ${response.status} ${response.statusText}`);
    }

    return response.json();
  },

  getTerminalFullScrollback: async (terminalId) => {
    const response = await fetch(
      `${await apiBase()}/terminals/${terminalId}/full-scrollback`,
      { headers: { ...buildAuthHeaders() } }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch terminal full scrollback: ${response.status} ${response.statusText}`);
    }

    return response.json();
  },

  // GET /api/terminals/:id/screen — the visible screen as PLAIN text.
  //
  // Same host, port and bearer-token handling as the two calls above, deliberately:
  // `apiBase()` resolves the port this instance actually BOUND (never the configured
  // one — see apiBase.ts), so a second instance reads its own terminal rather than a
  // sibling's. No CSP change is needed for this route: `connect-src` in index.html is
  // origin-scoped (`http://localhost:*`), not path-scoped, so the entry that already
  // admits /snapshot admits /screen on the same origin.
  //
  // The body also echoes `terminalId`, which the return type omits — it only repeats
  // the id the caller passed in, so nothing downstream can learn from it. Passing the
  // parsed body straight through (as the neighbours do) leaves that extra field
  // present but untyped rather than paying for a copy to drop it.
  getTerminalScreenText: async (terminalId) => {
    const response = await fetch(
      `${await apiBase()}/terminals/${terminalId}/screen`,
      { headers: { ...buildAuthHeaders() } }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch terminal screen text: ${response.status} ${response.statusText}`);
    }

    return response.json();
  },

  // Live foreground-process info for all terminals (across all windows). Callers
  // filter to the relevant tabs by mapping each terminal via TerminalService.
  getActiveProcesses: async () => {
    const response = await fetch(`${await apiBase()}/processes`, {
      headers: { ...buildAuthHeaders() },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch active processes: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return Array.isArray(data?.processes) ? (data.processes as ActiveProcess[]) : [];
  },

  // Terminal Operations
  createTerminal: async (profile?: string, _name?: string, cwd?: string, tabId?: string, cols?: number, rows?: number, owningTabId?: string, sessionKey?: string) => {
    // We pass profile (id) to Rust, it resolves to path/args
    // We also pass cwd if provided; use fitted size when known, else fall back to 80×24
    return invoke('create_terminal', {
      cols: cols && cols > 0 ? cols : 80,
      rows: rows && rows > 0 ? rows : 24,
      profileId: profile,
      cwd,
      tabId,
      // Tauri maps camelCase JS keys onto snake_case Rust parameters, so this
      // reaches `create_terminal(… owning_tab_id: Option<String>)`.
      owningTabId,
      // The pty-host session key for a MIGRATED pane, whose host session is
      // still keyed by its old `tb-` id. Undefined for every pane created on
      // this build, where the host key follows the leaf (design 014 A2.1).
      sessionKey,
    });
  },

  adoptConsoleWindow: async (processId: string) => {
    await invoke('adopt_console_window', { terminalId: processId });
  },

  setTerminalOwningTab: async (rendererTerminalId: string, owningTabId: string) => {
    // Tauri maps camelCase JS keys onto the snake_case Rust parameters.
    await invoke('set_terminal_owning_tab', { rendererTerminalId, owningTabId });
  },

  setTerminalDisplayLabel: async (rendererTerminalId: string, label: string) => {
    await invoke('set_terminal_display_label', { rendererTerminalId, label });
  },

  closeTerminal: async (id) => {
    return invoke('close_terminal', { id });
  },

  pruneTerminalHistory: async (keepIds: string[]) => {
    await invoke('prune_terminal_history', { keepIds });
  },

  writeToTerminal: async (id, data) => {
    emitPtyInput(id, data); // let the tracker echo-cancel typing (see ptyInputSignal)
    return invoke('write_terminal', { id, data });
  },

  resizeTerminal: async (id, cols, rows) => {
    emitPtyResize(id, cols, rows); // let the tracker brace for the repaint (see ptyResizeSignal)
    return invoke('resize_terminal', { id, cols, rows });
  },

  getTerminalSize: async (id) => {
    return invoke('get_terminal_size', { id });
  },

  updateTerminalName: async (_id, _name) => {
    return true;
  },

  getTerminalCwd: async (processId) => {
    return invoke('get_terminal_cwd', { id: processId });
  },

  getTerminalCwds: async (processIds) => {
    return invoke('get_terminal_cwds', { ids: processIds });
  },

  takeReattachPromptHook: async (id) => {
    const r = await invoke<unknown>('take_reattach_prompt_hook', { id });
    // Version-skew safety (e.g. dev hot-reload against an older core): an old
    // backend returns a bare boolean — normalize to the object shape, DISARMED.
    if (typeof r === 'boolean') return { promptHook: r, atPrompt: false };
    return r as { promptHook: boolean; atPrompt: boolean } | null;
  },

  probeReattachPromptGate: async (processId) =>
    invoke('probe_reattach_prompt_gate', { id: processId }),

  resolveTerminalPath: async (processId, rel) => {
    return invoke('resolve_terminal_path', { id: processId, rel });
  },

  openExternal: async (url) => {
    await invoke('open_external', { url });
  },
  openDevtools: async () => {
    await invoke('open_devtools');
  },
  openPath: async (path) => {
    await invoke('open_path', { path });
  },
  openInEditor: async (editor, path, line, col) => {
    await invoke('open_in_editor', { editor, path, line, col });
  },

  // Settings "Default editor" Browse… button. Opens a native single-file picker.
  // Filters surface common executables per-OS while still letting the user pick
  // any file (e.g. a Unix binary with no extension) via "All files".
  pickExecutablePath: async () => {
    const selection = await openFileDialog({
      multiple: false,
      directory: false,
      title: 'Select editor executable',
      filters: [
        { name: 'Executables', extensions: ['exe', 'bat', 'cmd', 'com', 'app'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return typeof selection === 'string' ? selection : null;
  },

  // Snippets import/export (plan/029 §8). The dialog config lives here beside
  // `pickExecutablePath` because this file is the only place the dialog plugin is
  // imported; `services/snippetPorting.ts` owns the format and merge semantics.
  // Both resolve to null when the user dismisses the dialog — a normal outcome.
  pickSnippetsExportPath: async () => {
    const selection = await saveFileDialog({
      title: 'Export snippets',
      defaultPath: 'termflow-snippets.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    return typeof selection === 'string' ? selection : null;
  },

  pickSnippetsImportPath: async () => {
    const selection = await openFileDialog({
      multiple: false,
      directory: false,
      title: 'Import snippets',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    return typeof selection === 'string' ? selection : null;
  },

  // Narrow by design (decision D10): these two carry snippet JSON to and from a
  // `.json` path the user picked in a native dialog, and are reachable ONLY over
  // Tauri IPC — never from the embedded REST API or the MCP sidecar.
  exportSnippetsFile: async (path, json) => {
    await invoke('export_snippets_file', { path, json });
  },

  importSnippetsFile: async (path) => {
    return invoke('import_snippets_file', { path });
  },

  // Aliases for PTY (same as above)
  sendToPty: async (id, data) => {
    emitPtyInput(id, data); // keep echo-cancel working if a caller uses this alias
    return invoke('write_terminal', { id, data });
  },

  resizePty: async (id, cols, rows) => {
    emitPtyResize(id, cols, rows); // keep the burst suppression working via this alias too
    return invoke('resize_terminal', { id, cols, rows });
  },

  // Events
  onTerminalData: (callback) => {
    trackUnlisten(listen('terminal:data', (event: any) => {
      const { id, data } = event.payload;
      callback(id, data);
    }));
  },

  onTerminalExit: (callback) => {
    trackUnlisten(listen('terminal:exit', (event: any) => {
      const { id, exitCode, cwd } = event.payload;
      callback(id, exitCode, cwd);
    }));
  },

  // Mocks / System
  getShellProfiles: async () => {
    try {
      return await invoke('get_shell_profiles');
    } catch (error) {
      console.error('Failed to get shell profiles', error);
      return [];
    }
  },

  getExecutableIcon: async (path: string) => {
    return invoke('get_executable_icon', { path });
  },

  getSystemInfo: async () => {
    return { platform: 'win32', arch: 'x64' }; // Mock or use taure api
  },

  // Config
  getConfig: async () => {
    try {
      const configStr = await invoke<string>('load_config');
      return configStr ? JSON.parse(configStr) : {};
    } catch (e) {
      console.error('Failed to load config:', e);
      return {};
    }
  },

  // Merge in the BACKEND, under an inter-process lock. Reading the whole config
  // here and saving it back lost every key written in between — by the backend,
  // or by another instance now that profiles let two run at once.
  updateConfig: async (updates) => {
    try {
      await invoke('merge_config', { updates });
    } catch (e) {
      console.error('Failed to update config:', e);
    }
  },

  getConfigValue: async (key) => {
    const config = await tauriBridge.getConfig();
    return config[key];
  },

  setConfigValue: async (key, value) => {
    await tauriBridge.updateConfig({ [key]: value });
  },

  readLegalDocument: async (name) => invoke<string>('read_legal_document', { name }),
  openLegalDocument: async (name) => invoke<void>('open_legal_document', { name }),

  // Backlog 011: command history (errors are non-fatal — suggestions degrade
  // to session-only, the terminal itself is never affected).
  addCommandHistory: async (command) => {
    try {
      await invoke('add_command_history', { command });
    } catch (e) {
      console.error('Failed to persist command history entry:', e);
    }
  },

  loadCommandHistory: async (limit) => {
    try {
      return await invoke<string[]>('load_command_history', { limit });
    } catch (e) {
      console.error('Failed to load command history:', e);
      return [];
    }
  },

  deleteCommandHistory: async (command) => {
    try {
      await invoke('delete_command_history', { command });
    } catch (e) {
      console.error('Failed to delete command history entry:', e);
    }
  },

  // Stream 4: per-directory command usage (errors non-fatal — ranking degrades to
  // the global recency order, the terminal is never affected).
  addCommandDirUsage: async (command, dir) => {
    try {
      await invoke('add_command_dir_usage', { command, dir });
    } catch (e) {
      console.error('Failed to persist command dir-usage:', e);
    }
  },

  loadCommandDirUsage: async (cwd) => {
    try {
      return await invoke<import('../types/electron').DirUsageRow[]>('load_command_dir_usage', { cwd });
    } catch (e) {
      console.error('Failed to load command dir-usage:', e);
      return [];
    }
  },

  // Stream 5: "Open in TermFlow" folder context menu.
  takePendingOpenPath: async () => {
    try {
      return await invoke<string | null>('take_pending_open_path');
    } catch (e) {
      console.error('Failed to take pending open path:', e);
      return null;
    }
  },
  installFileManagerIntegration: async () => {
    await invoke('install_file_manager_integration');
  },
  uninstallFileManagerIntegration: async () => {
    await invoke('uninstall_file_manager_integration');
  },
  isFileManagerIntegrationInstalled: async () => {
    try {
      return await invoke<boolean>('is_file_manager_integration_installed');
    } catch (e) {
      console.error('Failed to query file-manager integration:', e);
      return false;
    }
  },

  getDefaultProfile: async () => {
    return await tauriBridge.getConfigValue('defaultProfile');
  },

  setDefaultProfile: async (profileId) => {
    await tauriBridge.setConfigValue('defaultProfile', profileId);
  },

  getTheme: async () => {
    return await tauriBridge.getConfigValue('theme');
  },

  setTheme: async (theme) => {
    await tauriBridge.setConfigValue('theme', theme);
  },

  // API Operations
  generateAPIToken: async (clientId: string, permissions?: string[]) => {
    return invoke('generate_api_token', { clientId, permissions: permissions || ['*'] });
  },
  getAPIConfig: async () => ({}),

  // Network settings
  getNetworkConfig: async () => invoke('get_network_config'),
  getEffectiveEndpoints: async () => invoke('get_effective_endpoints'),
  setNetworkConfig: async (apiPort, mcpPort, exposeOnNetwork) => {
    // Invalidated on BOTH sides of the call. The native command rebinds the listener near
    // its start and can then spend seconds respawning sidecars, so invalidating only
    // afterwards leaves a window in which the old memo is live but the port behind it has
    // already been released — and released is precisely when a sibling can take it.
    invalidateApiBase();
    const cfg = await invoke<NetworkConfig>('set_network_config', { apiPort, mcpPort, exposeOnNetwork });
    // Re-point the bridge at the (possibly new) port so REST calls — terminal
    // scrollback/snapshot, the canvas graph — don't keep hitting the old one after
    // the hot-restart. Re-resolved from the backend rather than taken from `cfg`:
    // what came back is the CONFIGURED port, and the restart is what decides which
    // one is actually ours.
    invalidateApiBase();
    if (cfg?.authToken) localStorage.setItem(apiTokenKey(), cfg.authToken);
    return cfg;
  },
  rotateAuthToken: async () => {
    const cfg = await invoke<NetworkConfig>('rotate_auth_token');
    if (cfg?.authToken) localStorage.setItem(apiTokenKey(), cfg.authToken);
    return cfg;
  },
  listNetworkInterfaces: async () => invoke('list_network_interfaces'),
  // Both move (or remove) the listener, so the resolved base URL is stale afterwards.
  // A stopped API clears its effective port precisely so this window cannot keep
  // addressing a port a sibling instance is now free to take.
  stopServers: async (target = 'all') => {
    invalidateApiBase();
    await invoke('stop_servers', { target });
    invalidateApiBase();
  },
  startServers: async (target = 'all') => {
    invalidateApiBase();
    await invoke('start_servers', { target });
    invalidateApiBase();
  },
  restartForUpdate: async () => { await invoke('restart_for_update'); },
  updateAvailable: async () => {
    await invoke('update_available');
  },

  hotswapAvailable: async () => { await invoke('hotswap_available'); },
  renameTerminalHistory: async (from: string, to: string) => {
    await invoke('rename_terminal_history', { from, to });
  },
  checkForUpdates: async () => invoke<UpdateStatus>('check_for_updates'),
  updateAndRestart: async () => { await invoke('update_and_restart'); },
  // `@tauri-apps/api/app`'s getVersion() is exactly this invoke; calling it
  // directly avoids importing the app module (whose image.cjs can't load in
  // the jsdom test environment).
  getAppVersion: async () => invoke<string>('plugin:app|version'),

  // UI Mocks
  getActiveTabAndPane: async () => ({}),
  createTerminalInTab: async () => { },
  getTabs: async () => [],

  sendToMain: (_channel, _data) => { },

  checkConnectionHealth: async () => {
    try {
      return await invoke('check_connection_health');
    } catch (error) {
      console.error('Failed to check connection health:', error);
      return [];
    }
  },

  // Exit the app after the user confirms in the in-app close dialog.
  confirmCloseApp: async () => {
    await invoke('confirm_close_app');
  },

  // Plan 018: the quit handshake, and the live window list the orphan sweep
  // measures against.
  flushSessionAck: async () => {
    await invoke('flush_session_ack');
  },
  listWindowSessionIds: async () => {
    return invoke('list_window_session_ids');
  },

  // Detach / cross-window pane handoff
  stashDetachPayload: async (token, payload) => {
    await invoke('stash_detach_payload', { token, payload });
  },
  takeDetachPayload: async (token) => {
    return invoke('take_detach_payload', { token });
  },
  createDetachedWindow: async (token, x, y) => {
    return invoke('create_detached_window', { token, x, y });
  },
  createNewWindow: async () => {
    return invoke('create_new_window');
  },
  getWindowLabel: () => {
    try {
      return getCurrentWindow().label;
    } catch {
      return 'main';
    }
  },

  canvasApiRequest: async (path, init) => {
    const method = init?.method ?? 'GET';
    const response = await fetch(`${await apiBase()}${path}`, {
      method,
      headers: {
        ...buildAuthHeaders(),
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) {
      throw new Error(`Canvas API ${method} ${path} failed: ${response.status} ${response.statusText}`);
    }
    // DELETE answers 204 with no body; `.json()` on that throws.
    return response.status === 204 ? null : response.json();
  },
  beginGlobalPaneDrag: async (token, payload) => {
    await invoke('begin_global_pane_drag', { token, payload });
  },
  claimGlobalPaneDrag: async (token) => {
    return invoke('claim_global_pane_drag', { token });
  },
  resolveOrphanGlobalDrag: async (token) => {
    return invoke('resolve_orphan_global_drag', { token });
  },
  cancelGlobalPaneDrag: async (token) => {
    await invoke('cancel_global_pane_drag', { token });
  },

  // Tab tear-off preview window
  showDragPreview: async (title, x, y) => {
    await invoke('show_drag_preview', { title, x, y });
  },
  moveDragPreview: async (x, y) => {
    await invoke('move_drag_preview', { x, y });
  },
  hideDragPreview: async () => {
    await invoke('hide_drag_preview');
  },

  // Cross-window tab drop: hit-test the release point against other windows.
  resolveTabDrop: async (token, x, y) => {
    return invoke('resolve_tab_drop', { token, x, y });
  },

  // Rebuild the native Window menu so its window list reflects current titles.
  refreshWindowMenu: async () => {
    await invoke('refresh_window_menu');
  },

  // Set this window's display title (active tab) and rebuild the Window menu in a
  // single call, so the menu never reads a stale/not-yet-committed native title.
  setWindowTitle: async (title: string) => {
    await invoke('set_window_title', { title });
  },

  // Destroy the current window (no close-confirm).
  closeCurrentWindow: async () => {
    await invoke('close_self_window');
  },

  quitApp: async () => {
    await invoke('quit_app');
  },

  // P0a: which window receives API/MCP-created terminals (per-window toggle).
  getActiveWindow: () => invoke<string>('get_active_window'),
  setActiveWindow: (label: string) => invoke<void>('set_active_window', { label }),
  openSettingsInMainWindow: (category?: string) => invoke<void>('open_settings_in_main_window', { category }),

  // Peering (termflow-fabric sidecar; Plan 010). Each proxies one fabric
  // control-API route via a Rust #[tauri::command]; camelCase args are mapped
  // to the command's snake_case params by Tauri.
  peersList: async () => invoke<PeerInfo[]>('peers_list'),
  pendingApprovalsList: async () => invoke<PeerRequestInfo[]>('pending_approvals_list'),
  pairingCodeCreate: async () => invoke<PairingCode>('pairing_code_create'),
  peerAdd: async (address, code) => { await invoke('peer_add', { address, code }); },
  peerApprove: async (deviceId, accept) => { await invoke('peer_approve', { deviceId, accept }); },
  peerRevoke: async (deviceId) => { await invoke('peer_revoke', { deviceId }); },
  peerSetGrant: async (deviceId, terminalId, level) => {
    await invoke('peer_set_grant', { deviceId, terminalId, level });
  },
  peerSetFleetExec: async (deviceId, enabled) => {
    await invoke('peer_set_fleet_exec', { deviceId, enabled });
  },
  setAcceptPeers: async (enabled) => { await invoke('set_accept_peers', { enabled }); },
  fabricStatus: async () => invoke<FabricStatus>('fabric_status'),

  // Background mode (Plan 010): persist + mirror into the Rust AppState atomic.
  setKeepRunningInBackground: async (enabled) => {
    await invoke('set_keep_running_in_background', { enabled });
  },

  // --- Terminal Automations (Plan 028) ---
  //
  // Thin `invoke` wrappers over `automation_commands.rs`, one per command. The first
  // eleven follow that file's declaration order; the three id-only writers that replaced a
  // whole-rule `saveAutomation` are appended last here as the newest of them, wherever
  // they sit in the Rust module. Every argument name
  // here is the camelCase form Tauri derives from the Rust parameter — `rule_id` on the
  // Rust side is `ruleId` on the wire, and a mismatch is a silent 422 rather than a type
  // error (`mcp-split-pane-422`), which is why these live in one place instead of at each
  // call site.
  listAutomations: async () => invoke<AutomationRule[]>('list_automations'),
  getAutomationRuntime: async () => invoke<AutomationStatePayload>('get_automation_runtime'),
  loadAutomationLog: async (ruleId, newestFirst, limit) =>
    invoke<AutomationLogEntry[]>('load_automation_log', { ruleId, newestFirst, limit }),
  listWatchableTerminals: async (ruleId, includeIds) =>
    invoke<WatchableTerminal[]>('list_watchable_terminals', { ruleId, includeIds }),
  dryRunAutomation: async (rule, terminalId) =>
    invoke<DryRunReport>('dry_run_automation', { rule, terminalId }),
  saveAutomation: async (rule, origin) =>
    invoke<AutomationSaveResult>('save_automation', { rule, origin }),
  deleteAutomation: async (id, origin) => invoke<boolean>('delete_automation', { id, origin }),
  duplicateAutomation: async (id, origin) =>
    invoke<AutomationRule>('duplicate_automation', { id, origin }),
  setAutomationEnabled: async (id, enabled, origin) => {
    await invoke('set_automation_enabled', { id, enabled, origin });
  },
  resetAutomation: async (id, origin) => {
    await invoke('reset_automation', { id, origin });
  },
  rearmAutomation: async (ruleId, terminalId) => {
    await invoke('rearm_automation', { ruleId, terminalId });
  },
  // Pin one more terminal onto an existing rule's target list.
  //
  // The boolean is a RESULT, not a success flag: `false` means the rule id no longer
  // names a rule (deleted from another window between the moment the caller read the
  // list and this write), so nothing was written. That is an ordinary outcome of a
  // multi-window app, which is why it comes back as a value the caller must handle
  // rather than as a rejection — a rejection here is a genuine IPC/store failure.
  //
  // Only `{ ruleId, terminalId, origin }` goes on the wire — never a second, snake_case
  // spelling of the same argument. Tauri deserialises the args object into the command's
  // parameters, so sending both forms is a serde duplicate-key error at the boundary
  // (422), which surfaces as "the button did nothing" rather than as a type error here.
  addAutomationTarget: async (ruleId, terminalId, origin) =>
    invoke<boolean>('add_automation_target', { ruleId, terminalId, origin }),
  // Unpin terminals from an existing rule's target list — the same shape as the add, and
  // the same reason for existing. The Settings list's *Forget it* button used to filter
  // `targetIds` on a rule object it had read out of a cached list and write the whole
  // thing back through `saveAutomation`, which is an unconditional upsert: a rule deleted
  // in another window came back, and a concurrent edit to any other column was reverted.
  //
  // The boolean reads exactly as the add's does: `false` means the rule id no longer names
  // a rule and NOTHING was written; `true` covers ids the rule was not watching anyway,
  // because the caller's "pinned but missing" list can be a commit behind.
  removeAutomationTarget: async (ruleId, terminalIds, origin) =>
    invoke<boolean>('remove_automation_target', { ruleId, terminalIds, origin }),
  // Move a rule's *Log every check* deadline. `null` switches it off.
  //
  // The third site of that class. `verboseUntil` is one nullable column, and setting it
  // through `saveAutomation` sent fifteen others back with it — so a logging switch could
  // resurrect a deleted rule and revert someone else's edit to the message.
  setAutomationVerbose: async (ruleId, verboseUntil, origin) =>
    invoke<boolean>('set_automation_verbose', { ruleId, verboseUntil, origin }),
};

// Global event listeners to bridge Tauri events to DOM events
if (typeof window !== 'undefined') {
  // Bridge API creation events
  trackUnlisten(listen('api:createTerminalTab', (event: any) => {
    // P0a: the event is broadcast to every window; only the active target window
    // (carried in payload.targetWindow) should create the tab. A missing target
    // means "any window" for backward compatibility.
    let myLabel = '';
    try { myLabel = getCurrentWindow().label; } catch { /* not inside a tauri window */ }
    if (!shouldHandleForWindow(event.payload?.targetWindow, myLabel)) {
      return;
    }
    console.log('Tauri Bridge: Received api:createTerminalTab event', event.payload);
    window.dispatchEvent(new CustomEvent('api:createTerminalTab', {
      detail: event.payload
    }));
  }));

  // Flash the owning tab when an external MCP/API call interacts with a terminal.
  trackUnlisten(listen('terminal:external-activity', (event: any) => {
    window.dispatchEvent(new CustomEvent('terminal:external-activity', {
      detail: event.payload, // { terminalId, processId, tabId, rendererTerminalId, owningTabId }
    }));
  }));

  // Peer/pairing events from the fabric SSE stream (re-emitted by fabric_manager).
  // Peer state is GLOBAL, not per-window, so unlike api:createTerminalTab this is
  // intentionally NOT filtered via shouldHandleForWindow.
  trackUnlisten(listen('peer:event', (event: any) => {
    window.dispatchEvent(new CustomEvent('peer:event', {
      detail: event.payload,
    }));
  }));

  // Tray "Peers…" menu item (Plan 010): open Settings → Peers. Global (the tray
  // isn't window-scoped), so it's intentionally not filtered by window.
  trackUnlisten(listen('tray:open-peers', () => {
    window.dispatchEvent(new CustomEvent('tray:open-peers'));
  }));

  // Bridge the native window-close request so App can show a confirm dialog.
  // The event is delivered to every window's global listener, so only react when
  // the payload label matches THIS window — otherwise closing one window would
  // pop the confirm dialog in all of them.
  trackUnlisten(listen('app:close-requested', (event: any) => {
    const targetLabel = event?.payload;
    let myLabel = 'main';
    try { myLabel = getCurrentWindow().label; } catch { /* default */ }
    if (typeof targetLabel === 'string' && targetLabel !== myLabel) return;
    window.dispatchEvent(new CustomEvent('app:close-requested'));
  }));

  // Dev full-reload / window close: drop all Tauri subscriptions before the page
  // goes away so the backend doesn't accumulate dead listeners per reload.
  window.addEventListener('beforeunload', disposeBridgeListeners);

  // Note: the `pty:exit` DOM event is dispatched by TerminalService.onTerminalExit
  // (which also resolves the UI terminalId). We intentionally do NOT dispatch it
  // here too — a second dispatch (without terminalId) would double the exit banner.
}

// Expose to window
(window as any).electronAPI = tauriBridge;

// Dev-only console helpers for manual testing. `withGlobalTauri` is off, so
// `window.__TAURI__` does NOT exist — use these instead of raw `invoke` from
// DevTools. `restartForUpdate()` triggers the PTY-host hot-swap; `tauriInvoke`
// is a generic escape hatch. Both return the invoke promise so `.catch` surfaces
// a refusal reason.
if (process.env.NODE_ENV === 'development') {
  (window as any).tauriInvoke = (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args);
  (window as any).restartForUpdate = () => invoke('restart_for_update');
}

export default tauriBridge;
