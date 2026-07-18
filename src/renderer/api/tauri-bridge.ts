import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import type { TerminalSnapshot, ActiveProcess, PeerInfo, PeerRequestInfo, PairingCode, FabricStatus, GrantLevel } from '../types/electron';
import { shouldHandleForWindow } from './windowRouting';
import { emitPtyInput } from '../utils/ptyInputSignal';

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

// Define the interface to match existing usage
interface ElectronAPI {
  getTerminalOutput: (terminalId: string, lines?: number, offset?: number) => Promise<{
    totalLines: number;
    offset: number;
    raw: string;
  }>;
  getTerminalSnapshot: (terminalId: string, cols?: number, rows?: number) => Promise<TerminalSnapshot>;
  getActiveProcesses: () => Promise<ActiveProcess[]>;
  createTerminal: (profile?: string, name?: string, cwd?: string, tabId?: string, cols?: number, rows?: number) => Promise<string>;
  getActiveWindow: () => Promise<string>;
  setActiveWindow: (label: string) => Promise<void>;
  closeTerminal: (id: string) => Promise<void>;
  pruneTerminalHistory: (keepIds: string[]) => Promise<void>;
  writeToTerminal: (id: string, data: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  getTerminalSize: (id: string) => Promise<{ cols: number; rows: number }>;
  updateTerminalName: (id: string, name: string) => Promise<boolean>;
  getTerminalCwd: (processId: string) => Promise<string | null>;
  getTerminalCwds: (processIds: string[]) => Promise<Record<string, string | null>>;
  resolveTerminalPath: (processId: string, rel: string) => Promise<string[]>;
  openExternal: (url: string) => Promise<void>;
  openPath: (path: string) => Promise<void>;
  openInEditor: (editor: string, path: string, line?: number, col?: number) => Promise<void>;
  pickExecutablePath: () => Promise<string | null>;
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
  setNetworkConfig: (apiPort: number, mcpPort: number, exposeOnNetwork: boolean) => Promise<NetworkConfig>;
  rotateAuthToken: () => Promise<NetworkConfig>;
  listNetworkInterfaces: () => Promise<NetworkInterfaceInfo[]>;
  stopServers: (target?: 'all' | 'api' | 'mcp') => Promise<void>;
  startServers: (target?: 'all' | 'api' | 'mcp') => Promise<void>;
  getActiveTabAndPane: () => Promise<any>;
  createTerminalInTab: (tabId: string, paneId: string, profile: string, name: string) => Promise<any>;
  getTabs: () => Promise<any>;
  sendToMain: (channel: string, data: any) => void;
  checkConnectionHealth: () => Promise<Array<{name: string; url: string; healthy: boolean; active_clients?: number; conflict?: boolean}>>;
  confirmCloseApp: () => Promise<void>;
  // Detach / cross-window pane handoff
  stashDetachPayload: (token: string, payload: any) => Promise<void>;
  takeDetachPayload: (token: string) => Promise<any | null>;
  createDetachedWindow: (token: string, x?: number, y?: number) => Promise<string>;
  createNewWindow: () => Promise<string>;
  getWindowLabel: () => string;
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

// Default matches this build's instance (dev backend = 42051, prod = 42031);
// `let` so the resolver below can swap in a user-overridden port.
const DEFAULT_API_PORT = process.env.NODE_ENV === 'development' ? 42051 : 42031;
let API_PORT = DEFAULT_API_PORT;
let API_BASE_URL = `http://localhost:${API_PORT}/api`;

// Resolve the real (possibly user-overridden) API port from the backend once,
// so the bridge talks to the correct port after a settings change/restart.
// Call sites read API_BASE_URL at call time, so reassigning it here is enough.
invoke<{ apiPort: number; authToken: string }>('get_network_config')
  .then((cfg) => {
    if (cfg?.apiPort) {
      API_PORT = cfg.apiPort;
      API_BASE_URL = `http://localhost:${API_PORT}/api`;
    }
    // When exposed on the network the backend enforces the token on ALL requests
    // (including this renderer's loopback calls), so the renderer must send it.
    // Harmless in localhost mode (auth is not enforced there).
    if (cfg?.authToken) {
      localStorage.setItem('api_token', cfg.authToken);
    }
  })
  .catch(() => { /* keep default */ });

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
  const token = localStorage.getItem('api_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const tauriBridge: ElectronAPI = {
  getTerminalOutput: async (terminalId, lines = 1000, offset = 0) => {
    const response = await fetch(`${API_BASE_URL}/terminals/${terminalId}/output?lines=${lines}&offset=${offset}`, {
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
      `${API_BASE_URL}/terminals/${terminalId}/snapshot${query ? `?${query}` : ''}`,
      { headers: { ...buildAuthHeaders() } }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch terminal snapshot: ${response.status} ${response.statusText}`);
    }

    return response.json();
  },

  // Live foreground-process info for all terminals (across all windows). Callers
  // filter to the relevant tabs by mapping each terminal via TerminalService.
  getActiveProcesses: async () => {
    const response = await fetch(`${API_BASE_URL}/processes`, {
      headers: { ...buildAuthHeaders() },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch active processes: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return Array.isArray(data?.processes) ? (data.processes as ActiveProcess[]) : [];
  },

  // Terminal Operations
  createTerminal: async (profile?: string, _name?: string, cwd?: string, tabId?: string, cols?: number, rows?: number) => {
    // We pass profile (id) to Rust, it resolves to path/args
    // We also pass cwd if provided; use fitted size when known, else fall back to 80×24
    return invoke('create_terminal', {
      cols: cols && cols > 0 ? cols : 80,
      rows: rows && rows > 0 ? rows : 24,
      profileId: profile,
      cwd,
      tabId,
    });
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

  resolveTerminalPath: async (processId, rel) => {
    return invoke('resolve_terminal_path', { id: processId, rel });
  },

  openExternal: async (url) => {
    await invoke('open_external', { url });
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

  // Aliases for PTY (same as above)
  sendToPty: async (id, data) => {
    emitPtyInput(id, data); // keep echo-cancel working if a caller uses this alias
    return invoke('write_terminal', { id, data });
  },

  resizePty: async (id, cols, rows) => {
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

  updateConfig: async (updates) => {
    try {
      const current = await tauriBridge.getConfig();
      const newConfig = { ...current, ...updates };
      await invoke('save_config', { config: JSON.stringify(newConfig, null, 2) });
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
  setNetworkConfig: async (apiPort, mcpPort, exposeOnNetwork) => {
    const cfg = await invoke<NetworkConfig>('set_network_config', { apiPort, mcpPort, exposeOnNetwork });
    // Re-point the bridge at the (possibly new) port so REST calls — terminal
    // scrollback/snapshot — don't keep hitting the old one after the hot-restart.
    if (cfg?.apiPort) {
      API_PORT = cfg.apiPort;
      API_BASE_URL = `http://localhost:${API_PORT}/api`;
    }
    if (cfg?.authToken) localStorage.setItem('api_token', cfg.authToken);
    return cfg;
  },
  rotateAuthToken: async () => {
    const cfg = await invoke<NetworkConfig>('rotate_auth_token');
    if (cfg?.authToken) localStorage.setItem('api_token', cfg.authToken);
    return cfg;
  },
  listNetworkInterfaces: async () => invoke('list_network_interfaces'),
  stopServers: async (target = 'all') => { await invoke('stop_servers', { target }); },
  startServers: async (target = 'all') => { await invoke('start_servers', { target }); },

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
      detail: event.payload, // { terminalId, tabId }
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

export default tauriBridge;
