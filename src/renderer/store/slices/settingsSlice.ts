import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { DEFAULT_COLOR_SCHEMA_ID } from '../colorSchemas';
import { EULA_ACCEPTED_KEY } from '../../legal';
// Type-only, and imported rather than restated: the modes are the gesture rule's vocabulary, and
// a second copy of the union here would let the two drift into a setting the canvas cannot read.
import type { CanvasWheelMode } from '../../components/Canvas/canvasGestures';
// Same arrangement, same reason: the cue names are the node renderer's vocabulary, and a
// second copy here would let the setting drift into a value the canvas cannot render.
import type { CanvasBusyCue } from '../../components/Canvas/canvasBusyCue';

export interface ShellProfile {
  id: string;
  name: string;
  path: string;
  args: string[];
  env: Record<string, string>;
  icon?: string;
  cwd?: string;
}

export interface Theme {
  name: string;
  backgroundColor: string;
  foregroundColor: string;
  cursorColor: string;
  selectionBackground: string;
  colors: string[]; // 16 ANSI colors
}

// Subset of xterm.js's FontWeight union exposed to the user. CSS defines
// 'normal' === 400 and 'bold' === 700 numerically, so the numeric ladder alone
// covers every value the engine used to hard-code — no separate 'normal'/'bold'
// aliases needed, which would otherwise show as confusing duplicate options.
export type TerminalFontWeight = '300' | '400' | '500' | '600' | '700' | '800' | '900';

export const TERMINAL_FONT_WEIGHTS: ReadonlyArray<{ value: TerminalFontWeight; label: string }> = [
  { value: '300', label: 'Light (300)' },
  { value: '400', label: 'Normal (400)' },
  { value: '500', label: 'Medium (500)' },
  { value: '600', label: 'Semibold (600)' },
  { value: '700', label: 'Bold (700)' },
  { value: '800', label: 'Extra Bold (800)' },
  { value: '900', label: 'Black (900)' },
];

interface SettingsState {
  shellProfiles: ShellProfile[];
  defaultProfile: string;
  theme: Theme;
  fontSize: number;
  fontFamily: string;
  // Weight of regular terminal text. Default '400' (CSS 'normal').
  fontWeight: TerminalFontWeight;
  // Weight of SGR-bold terminal text (prompts, `ls`/git highlighting, etc).
  // Default '700' (CSS 'bold') — the usual source of a terminal reading as "too bold".
  fontWeightBold: TerminalFontWeight;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  scrollback: number;
  // When a terminal's process exits (Ctrl-D, crash, or an agent/API close call),
  // automatically close its UI tab. When false (default), the tab stays open and
  // is marked as terminated so the user can review what happened later.
  closeTabOnProcessExit: boolean;
  // Backlog 005: when true (default), pressing Ctrl+C while text is selected copies
  // the selection (and clears it) instead of sending SIGINT. macOS is unaffected
  // (Cmd+C copies there); the smart branch is gated to non-mac at the call site.
  smartCtrlC: boolean;
  // When true (default), send Kitty keyboard protocol / modifyOtherKeys key
  // encodings so modern TUIs (Antigravity, codex, claude) receive keys correctly.
  // Off reverts to legacy encoding. Read live each keypress (no remount needed).
  enhancedKeyboard: boolean;
  // Backlog 003: optional editor command for opening clicked file paths (e.g. "code").
  // Empty → open files with the OS default association.
  defaultEditor: string;
  // How the tab strip behaves when tabs overflow the title bar width:
  //  - 'shrink': compress all tabs so they always stay visible.
  //  - 'scroll': keep tabs at full width and scroll the strip (mouse wheel +
  //    left/right arrow buttons) to reach off-screen tabs.
  //  - 'fixed' (default): give every tab the same width (fixedTabWidth) and
  //    scroll the strip once tabs overflow, same scroll affordance as 'scroll'.
  tabSizingMode: 'shrink' | 'scroll' | 'fixed';
  // Tab width in px used only when tabSizingMode is 'fixed'. Clamped 60-300.
  fixedTabWidth: number;
  // When true, a terminal opened by the MCP tool or HTTP API activates (focuses)
  // its new tab. When false (default), the new tab appears in the background so an
  // agent's terminal does not interrupt the tab the user is working in. Splits
  // opened via API/MCP never change focus regardless of this flag.
  activateTabOnApiCreate: boolean;
  // Selected terminal ANSI color schema id (see store/colorSchemas.ts). Applied
  // live to every open terminal and to new tabs.
  colorSchemaId: string;
  // Opacity (0-100%) applied to a tab's non-focused panes so the focused pane
  // stands out. 100 = no dimming. Only visible when a tab has more than one
  // pane (a solo pane is always the focused one, so it's never dimmed).
  nonFocusedPaneOpacity: number;
  // Per-coding-agent color schema overrides: agent label (codex/claude/…) →
  // colorSchemaId. Highest-priority override — while a mapped agent runs in a
  // pane, that pane adopts this scheme over its tab/global schema. Global and
  // persisted; see docs/plan/007-agent-color-schemes-plan.md.
  agentColorSchemes: Record<string, string>;
  // Backlog 011: command history suggestion popup (capture + popup). Default on.
  // Independent of scrollback history persistence (backlog 009).
  commandSuggestions: boolean;
  // What the mouse wheel does in Canvas Mode (see CanvasWheelMode for the full rule):
  //  - 'zoom' (default): the wheel zooms the canvas, and Ctrl/Cmd+wheel passes through to the
  //    terminal under the pointer, where it zooms that terminal's font.
  //  - 'scroll': the wheel scrolls the canvas and Ctrl/Cmd+wheel zooms it. Font zoom keeps the
  //    chord inside the terminal that holds the keyboard, so editing one is unaffected.
  // Canvas Mode only — a wheel in a normal pane is untouched by this setting either way.
  canvasWheelMode: CanvasWheelMode;
  // How a canvas NODE reports that a process inside it is producing output (plan/023):
  //  - 'sweep' (default): a gradient band crosses the node header once per period. Readable
  //    at a glance across a canvas, and the only cue that survives the chip tier.
  //  - 'dot': a small status light in the title area — muted when idle, accent-coloured and
  //    blinking when busy. Nothing moves, and nothing renders at the chip tier.
  // Canvas Mode only, and NODES only — the sidebar's row icon blinks either way.
  canvasBusyCue: CanvasBusyCue;
  // Sparse map of shortcutActions.ts actionId -> user-chosen combo string.
  // Absent key = use that action's registry default. See
  // docs/041-keyboard-shortcuts-customization-design.md.
  customKeybindings: Record<string, string>;
  // Plan 010 (peering): when true, closing the last window hides the app to the
  // system tray and keeps the process alive so peering keeps running in the
  // background; when false (default), closing the last window exits the app.
  // Persisted + mirrored into the Rust AppState via setKeepRunningInBackground.
  keepRunningInBackground: boolean;
  // Launch TermFlow automatically at OS login (Windows Run key, macOS LaunchAgent,
  // Linux autostart .desktop) via tauri-plugin-autostart. NOT persisted to config.json
  // — the OS registration is the source of truth; this field mirrors isEnabled() for
  // the toggle UI and is hydrated from the plugin on the Settings page.
  launchAtLogin: boolean;
  // Notifications (Stream 1) — all opt-in (default off), independently configurable.
  // In-app SOUND chime when a background tab rings the unseen-activity bell.
  notifySoundEnabled: boolean;
  // In-app TOAST when a background tab rings the bell.
  notifyToastEnabled: boolean;
  // OS/native notification when a background tab rings the bell AND no app window is
  // focused (the focus check is done app-wide in the backend).
  notifyOsEnabled: boolean;
  // "Open in TermFlow" file-manager (Explorer/Nautilus/KDE) folder context-menu entry.
  // OS-owned (registry / desktop files); this mirrors is_installed for the toggle UI,
  // NOT persisted to config.json. macOS is bundle-provided.
  fileManagerIntegration: boolean;
  // EULA acceptance: the EULA version the user last accepted (persisted to config.json).
  // `null` = never accepted → the first-run acceptance modal shows. When it differs from
  // CURRENT_EULA_VERSION (a material EULA change), the modal re-appears.
  eulaAcceptedVersion: string | null;
  // False until config.json has been read at boot, so the acceptance modal doesn't flash
  // before we know whether the user already accepted.
  eulaHydrated: boolean;
}

const defaultTheme: Theme = {
  name: 'Dark',
  backgroundColor: '#141414',
  foregroundColor: '#cccccc',
  cursorColor: '#ffffff',
  selectionBackground: '#3a3d41',
  colors: [
    '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
    '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'
  ],
};

const initialState: SettingsState = {
  shellProfiles: [],
  defaultProfile: '',
  theme: defaultTheme,
  fontSize: 14,
  fontFamily: 'Consolas, "Courier New", monospace',
  fontWeight: '400',
  fontWeightBold: '700',
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 1000,
  closeTabOnProcessExit: false,
  smartCtrlC: true,
  enhancedKeyboard: true,
  defaultEditor: '',
  tabSizingMode: 'fixed',
  fixedTabWidth: 150,
  activateTabOnApiCreate: false,
  colorSchemaId: DEFAULT_COLOR_SCHEMA_ID,
  nonFocusedPaneOpacity: 50,
  agentColorSchemes: {},
  commandSuggestions: true,
  canvasWheelMode: 'zoom',
  canvasBusyCue: 'sweep',
  customKeybindings: {},
  keepRunningInBackground: false,
  launchAtLogin: false,
  notifySoundEnabled: false,
  notifyToastEnabled: false,
  notifyOsEnabled: false,
  fileManagerIntegration: false,
  eulaAcceptedVersion: null,
  eulaHydrated: false,
};

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setShellProfiles: (state, action: PayloadAction<ShellProfile[]>) => {
      state.shellProfiles = action.payload;

      // Set default profile if not set
      if (!state.defaultProfile && action.payload.length > 0) {
        state.defaultProfile = action.payload[0].id;
      }
    },

    updateShellProfile: (state, action: PayloadAction<{ id: string; changes: Partial<ShellProfile> }>) => {
      const { id, changes } = action.payload;
      const profileIndex = state.shellProfiles.findIndex(p => p.id === id);
      if (profileIndex !== -1) {
        state.shellProfiles[profileIndex] = { ...state.shellProfiles[profileIndex], ...changes };
        // TODO: Save to backend if needed, though shell profiles are usually system-detected. 
        // We might want to save *overrides* in a local config file.
      }
    },

    setDefaultProfile: (state, action: PayloadAction<string>) => {
      state.defaultProfile = action.payload;
      // Also save to config file
      if (window.electronAPI) {
        window.electronAPI.setDefaultProfile(action.payload);
      }
    },

    updateTheme: (state, action: PayloadAction<Partial<Theme>>) => {
      state.theme = { ...state.theme, ...action.payload };
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setTheme(state.theme);
      }
    },

    setFontSize: (state, action: PayloadAction<number>) => {
      state.fontSize = Math.max(8, Math.min(32, action.payload));
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('fontSize', state.fontSize);
      }
    },

    setFontFamily: (state, action: PayloadAction<string>) => {
      state.fontFamily = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('fontFamily', state.fontFamily);
      }
    },

    setFontWeight: (state, action: PayloadAction<TerminalFontWeight>) => {
      state.fontWeight = action.payload;
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('fontWeight', state.fontWeight);
      }
    },

    setFontWeightBold: (state, action: PayloadAction<TerminalFontWeight>) => {
      state.fontWeightBold = action.payload;
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('fontWeightBold', state.fontWeightBold);
      }
    },

    setCursorStyle: (state, action: PayloadAction<'block' | 'underline' | 'bar'>) => {
      state.cursorStyle = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('cursorStyle', state.cursorStyle);
      }
    },

    setCursorBlink: (state, action: PayloadAction<boolean>) => {
      state.cursorBlink = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('cursorBlink', state.cursorBlink);
      }
    },

    setScrollback: (state, action: PayloadAction<number>) => {
      state.scrollback = Math.max(100, Math.min(10000, action.payload));
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('scrollback', state.scrollback);
      }
    },

    setCloseTabOnProcessExit: (state, action: PayloadAction<boolean>) => {
      state.closeTabOnProcessExit = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('closeTabOnProcessExit', state.closeTabOnProcessExit);
      }
    },

    setSmartCtrlC: (state, action: PayloadAction<boolean>) => {
      state.smartCtrlC = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('smartCtrlC', state.smartCtrlC);
      }
    },

    setEnhancedKeyboard: (state, action: PayloadAction<boolean>) => {
      state.enhancedKeyboard = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('enhancedKeyboard', state.enhancedKeyboard);
      }
    },

    setDefaultEditor: (state, action: PayloadAction<string>) => {
      state.defaultEditor = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('defaultEditor', state.defaultEditor);
      }
    },

    setTabSizingMode: (state, action: PayloadAction<'shrink' | 'scroll' | 'fixed'>) => {
      state.tabSizingMode = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('tabSizingMode', state.tabSizingMode);
      }
    },

    setFixedTabWidth: (state, action: PayloadAction<number>) => {
      state.fixedTabWidth = Math.max(60, Math.min(300, action.payload));
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('fixedTabWidth', state.fixedTabWidth);
      }
    },

    setActivateTabOnApiCreate: (state, action: PayloadAction<boolean>) => {
      state.activateTabOnApiCreate = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('activateTabOnApiCreate', state.activateTabOnApiCreate);
      }
    },

    setColorSchema: (state, action: PayloadAction<string>) => {
      state.colorSchemaId = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('colorSchemaId', state.colorSchemaId);
      }
    },

    setNonFocusedPaneOpacity: (state, action: PayloadAction<number>) => {
      state.nonFocusedPaneOpacity = Math.max(0, Math.min(100, action.payload));
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('nonFocusedPaneOpacity', state.nonFocusedPaneOpacity);
      }
    },

    setCommandSuggestions: (state, action: PayloadAction<boolean>) => {
      state.commandSuggestions = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('commandSuggestions', state.commandSuggestions);
      }
    },

    setCanvasWheelMode: (state, action: PayloadAction<CanvasWheelMode>) => {
      state.canvasWheelMode = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('canvasWheelMode', state.canvasWheelMode);
      }
    },

    setCanvasBusyCue: (state, action: PayloadAction<CanvasBusyCue>) => {
      state.canvasBusyCue = action.payload;
      // Save to config file
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('canvasBusyCue', state.canvasBusyCue);
      }
    },

    // Bulk-replace the whole agent→schema map. Persists like the other setters
    // (used on config load — re-persisting the loaded value is idempotent, same
    // as setColorSchema/setFontSize — and on Settings "Discard Changes" revert).
    setAgentColorSchemes: (state, action: PayloadAction<Record<string, string>>) => {
      state.agentColorSchemes = action.payload;
      if (window.electronAPI) {
        // Snapshot to a plain object — `state.agentColorSchemes` is a live Immer
        // draft that is revoked once this reducer returns, and setConfigValue's
        // async JSON.stringify would then throw "proxy has been revoked" (silently
        // swallowed by updateConfig → the map never persisted, lost on restart).
        window.electronAPI.setConfigValue('agentColorSchemes', { ...state.agentColorSchemes });
      }
    },

    setAgentColorScheme: (state, action: PayloadAction<{ agent: string; colorSchemaId: string }>) => {
      state.agentColorSchemes[action.payload.agent] = action.payload.colorSchemaId;
      if (window.electronAPI) {
        // Snapshot to a plain object — `state.agentColorSchemes` is a live Immer
        // draft that is revoked once this reducer returns, and setConfigValue's
        // async JSON.stringify would then throw "proxy has been revoked" (silently
        // swallowed by updateConfig → the map never persisted, lost on restart).
        window.electronAPI.setConfigValue('agentColorSchemes', { ...state.agentColorSchemes });
      }
    },

    removeAgentColorScheme: (state, action: PayloadAction<{ agent: string }>) => {
      delete state.agentColorSchemes[action.payload.agent];
      if (window.electronAPI) {
        // Snapshot to a plain object — `state.agentColorSchemes` is a live Immer
        // draft that is revoked once this reducer returns, and setConfigValue's
        // async JSON.stringify would then throw "proxy has been revoked" (silently
        // swallowed by updateConfig → the map never persisted, lost on restart).
        window.electronAPI.setConfigValue('agentColorSchemes', { ...state.agentColorSchemes });
      }
    },

    // Bulk-replace the whole keybindings map. Used on config-load hydration
    // (App.tsx) and as the discard-revert target from the Shortcuts settings
    // category's dirty-tracking baseline.
    setCustomKeybindings: (state, action: PayloadAction<Record<string, string>>) => {
      state.customKeybindings = action.payload;
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('customKeybindings', { ...state.customKeybindings });
      }
    },

    setCustomKeybinding: (state, action: PayloadAction<{ actionId: string; combo: string }>) => {
      state.customKeybindings[action.payload.actionId] = action.payload.combo;
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('customKeybindings', { ...state.customKeybindings });
      }
    },

    resetCustomKeybinding: (state, action: PayloadAction<string>) => {
      delete state.customKeybindings[action.payload];
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('customKeybindings', { ...state.customKeybindings });
      }
    },

    // Plan 010: toggle "keep running in background". The Rust command persists the
    // value to the shared config file AND mirrors it into the AppState atomic the
    // window-close/exit guard reads, so we do NOT also call setConfigValue here
    // (single persistence path). Optional bridge method — a no-op in the browser host.
    setKeepRunningInBackground: (state, action: PayloadAction<boolean>) => {
      state.keepRunningInBackground = action.payload;
      window.electronAPI?.setKeepRunningInBackground?.(action.payload);
    },

    // Launch-at-login: mirror the OS registration state into the store for the toggle
    // UI. NOT persisted via setConfigValue — tauri-plugin-autostart's enable()/disable()
    // owns the actual OS registration; this is only the reflected value.
    setLaunchAtLogin: (state, action: PayloadAction<boolean>) => {
      state.launchAtLogin = action.payload;
    },

    // Notification preferences (Stream 1) — persisted to config.json like other toggles.
    setNotifySoundEnabled: (state, action: PayloadAction<boolean>) => {
      state.notifySoundEnabled = action.payload;
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('notifySoundEnabled', state.notifySoundEnabled);
      }
    },
    setNotifyToastEnabled: (state, action: PayloadAction<boolean>) => {
      state.notifyToastEnabled = action.payload;
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('notifyToastEnabled', state.notifyToastEnabled);
      }
    },
    setNotifyOsEnabled: (state, action: PayloadAction<boolean>) => {
      state.notifyOsEnabled = action.payload;
      if (window.electronAPI) {
        window.electronAPI.setConfigValue('notifyOsEnabled', state.notifyOsEnabled);
      }
    },

    // "Open in TermFlow" integration: mirror the OS registration state (registry /
    // desktop files) into the store for the toggle. NOT persisted — install/uninstall
    // commands own the actual state; this is the reflected value.
    setFileManagerIntegration: (state, action: PayloadAction<boolean>) => {
      state.fileManagerIntegration = action.payload;
    },

    // Record EULA acceptance and persist it to config.json (survives restarts).
    setEulaAcceptedVersion: (state, action: PayloadAction<string>) => {
      state.eulaAcceptedVersion = action.payload;
      window.electronAPI?.setConfigValue?.(EULA_ACCEPTED_KEY, action.payload);
    },

    // Load-time hydration from config.json — set state WITHOUT re-persisting.
    hydrateEulaAcceptedVersion: (state, action: PayloadAction<string | null>) => {
      state.eulaAcceptedVersion = action.payload;
      state.eulaHydrated = true;
    },
  },
});

export const {
  setShellProfiles,
  updateShellProfile,
  setDefaultProfile,
  updateTheme,
  setFontSize,
  setFontFamily,
  setFontWeight,
  setFontWeightBold,
  setCursorStyle,
  setCursorBlink,
  setScrollback,
  setCloseTabOnProcessExit,
  setSmartCtrlC,
  setEnhancedKeyboard,
  setDefaultEditor,
  setTabSizingMode,
  setFixedTabWidth,
  setActivateTabOnApiCreate,
  setColorSchema,
  setNonFocusedPaneOpacity,
  setCommandSuggestions,
  setCanvasWheelMode,
  setCanvasBusyCue,
  setAgentColorSchemes,
  setAgentColorScheme,
  removeAgentColorScheme,
  setCustomKeybindings,
  setCustomKeybinding,
  resetCustomKeybinding,
  setKeepRunningInBackground,
  setLaunchAtLogin,
  setNotifySoundEnabled,
  setNotifyToastEnabled,
  setNotifyOsEnabled,
  setFileManagerIntegration,
  setEulaAcceptedVersion,
  hydrateEulaAcceptedVersion,
} = settingsSlice.actions;

export default settingsSlice.reducer;