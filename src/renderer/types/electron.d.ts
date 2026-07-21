// Faithful styled snapshot of a terminal's current visible screen, used for
// reconnect/hydration. Shared by the Tauri and browser bridges.
export interface TerminalSnapshot {
  snapshot: string;
  rows: number;
  cols: number;
}

export interface NetworkConfig {
  apiPort: number;
  mcpPort: number;
  exposeOnNetwork: boolean;
  authToken: string;
}

export interface NetworkInterfaceInfo {
  name: string;
  label: string;
  ip: string;
}

// --- Peering (termflow-fabric sidecar; Plan 010) ---

/** Access level granted to a peer for a terminal. `None` (used only as a
 *  `peerSetGrant` argument) means "revoke the grant". */
export type GrantLevel = 'View' | 'Control';

/** One known peer device as reported by the fabric control API. */
export interface PeerInfo {
  deviceId: string;
  name: string;
  addresses: string[];
  online: boolean;
  lastSeen: number | null;
  grants: Record<string, GrantLevel>;
  /** OS captured at pairing (canonical "windows" | "macos" | "linux", or other). */
  os?: string;
  /** Per-peer consent to create-and-run NEW fleet terminals here (default false). */
  fleetExec: boolean;
}

/** A short-lived pairing code this machine offers to a peer. */
export interface PairingCode {
  code: string;
  expiresInSecs: number;
}

/** An incoming pairing request awaiting the local user's Accept/Decline. */
export interface PeerRequestInfo {
  deviceId: string;
  name: string;
  addr: string;
}

/** Result of `fabricStatus`: `installed:false` when the fabric binary is absent
 *  (the whole peering feature degrades gracefully), plus any health fields.
 *  `peerPort` is the inbound listener remote peers dial (the port to open on a
 *  firewall); present only when installed. */
export interface FabricStatus {
  installed: boolean;
  peerPort?: number;
  [key: string]: unknown;
}

/**
 * One live terminal process as reported by `GET /api/processes`.
 * `id` is the backend processId (matches TerminalService `process.id`, NOT the
 * UI terminalId stored on pane nodes). `currentApp.name` is the foreground
 * process — the shell's own name (pwsh/bash/…) when the terminal is idle.
 */
export interface ActiveProcess {
  id: string;
  pid: number;
  shell: string;
  name: string;
  currentApp: { pid: number; name: string };
  /** Friendly coding-agent label (codex/claude/gemini/…) derived from the
   *  foreground process's command line, or null when none is recognized. */
  agent?: string | null;
  /** Absolute path of the foreground agent's executable, for icon extraction.
   *  Null when there's no agent or the OS won't report the path. */
  agentExe?: string | null;
  /** Source of the most recent PTY write: user keystrokes vs API/MCP. */
  lastInputSource?: 'user' | 'api' | null;
  /** Epoch ms of the most recent PTY write. */
  lastInputAt?: number | null;
  createdAt?: string | number;
  isAlive: boolean;
}

/** Stream 4: one (command, directory) usage row for cwd-relevant suggestion ranking. */
export interface DirUsageRow {
  command: string;
  dir: string;
  useCount: number;
  lastUsedAt: number;
}

export interface ElectronAPI {
  // Terminal output history
  getTerminalOutput: (terminalId: string, lines?: number, offset?: number) => Promise<{
    totalLines: number;
    offset: number;
    raw: string;
  }>;

  // Faithful styled snapshot of the current visible screen, for reconnect/hydration
  getTerminalSnapshot?: (terminalId: string, cols?: number, rows?: number) => Promise<TerminalSnapshot>;

  // Lightweight PTY-size fetch for dimension auto-heal (no snapshot render).
  getTerminalSize?: (id: string) => Promise<{ cols: number; rows: number }>;

  // Live foreground-process info for every terminal (GET /api/processes). Used to
  // list the real running processes in the close-tab confirm. Optional: not every
  // bridge/environment implements it, so callers must guard with `?.`.
  getActiveProcesses?: () => Promise<ActiveProcess[]>;

  // Terminal management
  createTerminal: (profile?: string, name?: string, cwd?: string, tabId?: string, cols?: number, rows?: number) => Promise<string>;
  // P0a active-window routing: which window receives API/MCP-created terminals.
  // Optional — only the Tauri bridge implements it (browser bridge is single-window).
  getActiveWindow?: () => Promise<string>;
  setActiveWindow?: (label: string) => Promise<void>;
  closeTerminal: (id: string) => Promise<void>;
  /** Delete persisted terminal scrollback for every renderer id NOT in keepIds (startup orphan sweep). */
  pruneTerminalHistory: (keepIds: string[]) => Promise<void>;
  writeToTerminal: (id: string, data: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  updateTerminalName: (id: string, name: string) => Promise<boolean>;

  // Best-effort live CWD of a terminal's foreground process (null if unavailable).
  getTerminalCwd?: (processId: string) => Promise<string | null>;
  /** Batched `getTerminalCwd`, keyed by process id. One process scan for all of
   *  them — see the `get_terminal_cwds` command for why that matters. */
  getTerminalCwds?: (processIds: string[]) => Promise<Record<string, string | null>>;

  // Backlog 003 follow-up: resolve a relative path the terminal printed to actual
  // file(s) on disk — direct join (shell cwd, then foreground-process cwd), else a
  // bounded descendant search. Returns 0 / 1 / many absolute paths (picker for many).
  resolveTerminalPath?: (processId: string, rel: string) => Promise<string[]>;

  // Backlog 003: open a detected URL / file / file-in-editor from terminal output.
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<void>;
  openInEditor?: (editor: string, path: string, line?: number, col?: number) => Promise<void>;

  // Settings: native "Browse…" picker for the Default editor executable.
  // Resolves to the chosen path, or null if the user cancelled the dialog.
  pickExecutablePath?: () => Promise<string | null>;

  // PTY communication
  sendToPty: (processId: string, data: string) => void;
  resizePty: (processId: string, cols: number, rows: number) => void;

  // Event listeners
  onTerminalData: (callback: (id: string, data: string) => void) => void;
  // `cwd`: the shell's last directory, captured backend-side before cleanup
  // (spec 045 §3.3). Absent when the backend could not determine one.
  onTerminalExit: (callback: (id: string, code: number, cwd?: string | null) => void) => void;

  // System info
  getShellProfiles: () => Promise<any[]>;
  getExecutableIcon?: (path: string) => Promise<string>;
  getSystemInfo: () => Promise<any>;

  // Config operations
  getConfig: () => Promise<any>;
  updateConfig: (updates: any) => Promise<any>;
  getConfigValue: (key: string) => Promise<any>;
  setConfigValue: (key: string, value: any) => Promise<boolean>;
  // Read a bundled legal document (EULA/privacy/licenses/notices) by filename.
  readLegalDocument?: (name: string) => Promise<string>;
  // Backlog 011: global command history for the suggestion popup.
  addCommandHistory: (command: string) => Promise<void>;
  loadCommandHistory: (limit?: number) => Promise<string[]>;
  deleteCommandHistory: (command: string) => Promise<void>;
  // Stream 4: per-directory command usage for cwd-relevant suggestion ranking.
  addCommandDirUsage: (command: string, dir: string) => Promise<void>;
  loadCommandDirUsage: (cwd: string) => Promise<DirUsageRow[]>;
  // Stream 5: "Open in TermFlow" folder context menu.
  takePendingOpenPath: () => Promise<string | null>;
  installFileManagerIntegration: () => Promise<void>;
  uninstallFileManagerIntegration: () => Promise<void>;
  isFileManagerIntegrationInstalled: () => Promise<boolean>;
  getDefaultProfile: () => Promise<string>;
  setDefaultProfile: (profileId: string) => Promise<boolean>;
  getTheme: () => Promise<any>;
  setTheme: (theme: any) => Promise<boolean>;

  // API operations
  generateAPIToken: (clientId: string, permissions?: string[]) => Promise<string>;
  getAPIConfig: () => Promise<{
    jwtSecret: string;
    apiPort: number;
    wsPort: number;
    corsOrigins: string[];
    autoStart: boolean;
  }>;

  // UI state operations for API
  getActiveTabAndPane: () => Promise<{ tabId: string | null; paneId: string | null; tabTitle: string | null }>;
  createTerminalInTab: (tabId: string, paneId: string, profile: string, name: string) => Promise<any>;
  getTabs: () => Promise<any[]>;

  // Send messages to main process
  sendToMain: (channel: string, data: any) => void;

  // Connection health check
  checkConnectionHealth: () => Promise<Array<{name: string; url: string; healthy: boolean; active_clients?: number; conflict?: boolean}>>;

  // Network settings (ports, expose-on-network, access token)
  getNetworkConfig?: () => Promise<NetworkConfig>;
  setNetworkConfig?: (apiPort: number, mcpPort: number, exposeOnNetwork: boolean) => Promise<NetworkConfig>;
  rotateAuthToken?: () => Promise<NetworkConfig>;
  listNetworkInterfaces?: () => Promise<NetworkInterfaceInfo[]>;
  /** Stop server(s). target: 'all' | 'api' | 'mcp' (default 'all'). */
  stopServers?: (target?: 'all' | 'api' | 'mcp') => Promise<void>;
  /** (Re)start server(s). target: 'all' | 'api' | 'mcp' (default 'all'). */
  startServers?: (target?: 'all' | 'api' | 'mcp') => Promise<void>;
  /** Arm the PTY host to keep terminals alive, then close the app so the exe can
   *  be rebuilt (hot-swap "offload"). Never resolves on success (the process
   *  exits); rejects with the refusal reason if hot-swap isn't possible. */
  restartForUpdate?: () => Promise<void>;
  /** Preflight: resolves if an offload would keep all terminals alive, rejects
   *  with the reason if it would currently be refused. */
  hotswapAvailable?: () => Promise<void>;

  // Quit the app after the user confirms the in-app close dialog (Tauri only)
  confirmCloseApp?: () => Promise<void>;

  // Detach / cross-window pane handoff (Tauri only)
  stashDetachPayload?: (token: string, payload: any) => Promise<void>;
  takeDetachPayload?: (token: string) => Promise<any | null>;
  createDetachedWindow?: (token: string, x?: number, y?: number) => Promise<string>;
  createNewWindow?: () => Promise<string>;
  getWindowLabel?: () => string;
  beginGlobalPaneDrag?: (token: string, payload: any) => Promise<void>;
  claimGlobalPaneDrag?: (token: string) => Promise<any | null>;
  resolveOrphanGlobalDrag?: (token: string) => Promise<boolean>;
  cancelGlobalPaneDrag?: (token: string) => Promise<void>;

  // Tab tear-off preview window (Tauri only)
  showDragPreview?: (title: string, x: number, y: number) => Promise<void>;
  moveDragPreview?: (x: number, y: number) => Promise<void>;
  hideDragPreview?: () => Promise<void>;
  // Cross-window tab drop (Tauri only)
  resolveTabDrop?: (token: string, x: number, y: number) => Promise<boolean>;
  // Rebuild the native Window menu (Tauri only)
  refreshWindowMenu?: () => Promise<void>;
  // Set this window's display title (active tab) and rebuild the Window menu (Tauri only)
  setWindowTitle?: (title: string) => Promise<void>;
  // Destroy the current window (Tauri only)
  closeCurrentWindow?: () => Promise<void>;
  // Quit the whole app (Tauri only) — used by the first-run EULA "Decline".
  quitApp?: () => Promise<void>;

  // Peering (termflow-fabric sidecar; Plan 010). All optional — only the Tauri
  // bridge proxies the fabric control API; the browser host returns "not
  // installed" shapes, so callers must guard with `?.`.
  peersList?: () => Promise<PeerInfo[]>;
  pendingApprovalsList?: () => Promise<PeerRequestInfo[]>;
  pairingCodeCreate?: () => Promise<PairingCode>;
  peerAdd?: (address: string, code: string) => Promise<void>;
  peerApprove?: (deviceId: string, accept: boolean) => Promise<void>;
  peerRevoke?: (deviceId: string) => Promise<void>;
  peerSetGrant?: (deviceId: string, terminalId: string, level: GrantLevel | 'None') => Promise<void>;
  peerSetFleetExec?: (deviceId: string, enabled: boolean) => Promise<void>;
  setAcceptPeers?: (enabled: boolean) => Promise<void>;
  fabricStatus?: () => Promise<FabricStatus>;

  // Background mode (Plan 010): persist "keep running in background" and mirror it
  // into the Rust AppState atomic that the window-close/exit guard reads. Tauri-only
  // (the browser host is a no-op).
  setKeepRunningInBackground?: (enabled: boolean) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
