import React, { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useDispatch, useSelector } from 'react-redux';
import { TitleBar } from './components/TitleBar';
import { TerminalContainer } from './components/TerminalContainer';
import { PaneDragProvider } from './components/Panes/dnd/PaneDragController';
import { isDetachWindow, reconstructDetachedWindow, applyReattachByToken } from './components/Panes/dnd/detach';
import { LayoutManager } from './components/LayoutManager';
import { GlobalDialog } from './components/UI/GlobalDialog';
import { ConfirmDialog } from './components/UI/ConfirmDialog';
import { ToastContainer } from './components/UI/ToastContainer';
import { GlobalPeerRequests } from './components/GlobalPeerRequests';
import { EulaAcceptModal } from './components/EulaAcceptModal';
import {
  setShellProfiles,
  setDefaultProfile,
  updateTheme,
  setFontSize,
  setFontFamily,
  setCursorStyle,
  setCursorBlink,
  setScrollback,
  setCloseTabOnProcessExit,
  setTabSizingMode,
  setFixedTabWidth,
  setActivateTabOnApiCreate,
  setDefaultEditor,
  setSmartCtrlC,
  setEnhancedKeyboard,
  setCommandSuggestions,
  setColorSchema,
  setAgentColorSchemes,
  setCustomKeybindings,
  setKeepRunningInBackground,
  hydrateEulaAcceptedVersion
} from './store/slices/settingsSlice';
import { openSettingsTab } from './services/openSettings';
import { SHORTCUT_ACTIONS, findConflict } from './services/shortcutActions';
import { applyEffectiveThemes, applyActivePaneBackground } from './store/terminalTheme';
import { addTab, markTabExited, flagTabActivity } from './store/slices/tabsSlice';
import { RootState, store } from './store';
import { findTabIdByTerminalId, getAllTerminalIds, resolveExitedTabId } from './store/slices/paneTreeOps';
import { buildApiCreatedTab } from './services/apiCreatedTab';
import { runningActivityTracker } from './services/RunningActivityTracker';
import { agentSchemeTracker } from './services/AgentSchemeTracker';
import { inputHandler } from './services/InputHandler';
import { commandHistoryService } from './services/commandHistoryService';
import { StateManager } from './services/StateManager';
import { terminalService } from './services/TerminalService';
import { refreshLiveCwds, setCwdSnapshotByProcessId } from './services/cwdSnapshot';
import './styles/App.css';
import { generateId } from './utils/id';

const App: React.FC = () => {
  const dispatch = useDispatch();
  const tabs = useSelector((state: RootState) => state.tabs.tabs);
  const shellProfiles = useSelector((state: RootState) => state.settings.shellProfiles);
  const defaultProfile = useSelector((state: RootState) => state.settings.defaultProfile);
  // Single chokepoint: broadcast each tab's EFFECTIVE color schema (its own
  // override, or the global default) to that tab's open terminal panes —
  // Settings selection, a per-tab override, revert-on-discard, or boot
  // hydration all converge here. Select a derived STRING (not the tabs array)
  // so this effect — which mutates real xterm instances — fires only when a
  // schema actually changes, not on every unrelated tab-state mutation
  // (isRunning/activityTick/hasUnseenOutput churn during heavy output).
  const schemaSignature = useSelector((state: RootState) =>
    state.settings.colorSchemaId + '||' +
    state.tabs.activeTabId + '||' +
    state.tabs.tabs.map((t) => t.id + ':' + (t.colorSchemaId ?? '')).join('|') + '||' +
    // A per-agent mapping edit must re-apply; the live agent DETECTION churn is
    // driven separately by AgentSchemeTracker (not this signature).
    JSON.stringify(state.settings.agentColorSchemes)
  );
  useEffect(() => {
    const st = store.getState();
    const trees = st.panes.treesByTabId;
    // Route every terminal through the shared resolver so a per-pane agent
    // override (from AgentSchemeTracker) is honored and not clobbered by the
    // tab/global re-apply.
    const agentFor = (id: string) => agentSchemeTracker.getAgentForTerminal(id);
    for (const tab of st.tabs.tabs) {
      applyEffectiveThemes(getAllTerminalIds(trees[tab.id] ?? null), st, agentFor);
    }
    // Wrapper/scrollbar slack background (.terminal-display, painted outside
    // xterm's own canvas) follows the ACTIVE pane's effective schema.
    applyActivePaneBackground(st, agentFor);
  }, [schemaSignature]);

  // Whether the "quit the app?" confirmation dialog is showing.
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [isLastWindow, setIsLastWindow] = useState(true);
  // When the last cwd refresh STARTED, to throttle the visibilitychange trigger
  // (see handleVisibilityChange). A ref, not state: it must not re-render.
  const lastCwdRefreshAt = useRef(0);

  // The native window close is intercepted in Rust (prevent_close) and forwarded
  // as `app:close-requested`; show an in-app confirm before actually closing. The
  // confirm wording (and Rust's behavior) differ for the last window (quit app)
  // vs a secondary window (close just that window).
  useEffect(() => {
    const handleCloseRequested = async () => {
      try {
        const { getAllWindows } = await import('@tauri-apps/api/window');
        // Exclude the hidden tab tear-off preview window from the count, else it
        // looks like a second window and we'd say "Close Window" instead of "Quit".
        const real = (await getAllWindows()).filter((w) => w.label !== 'drag-preview');
        setIsLastWindow(real.length <= 1);
      } catch {
        setIsLastWindow(true);
      }
      setShowCloseConfirm(true);
    };
    window.addEventListener('app:close-requested', handleCloseRequested);
    return () => window.removeEventListener('app:close-requested', handleCloseRequested);
  }, []);

  // Tray "Peers…" menu item (Plan 010): open (or focus) the Settings tab on the
  // Peers section. Bridged from the Rust tray event by tauri-bridge.
  useEffect(() => {
    const handleTrayOpenPeers = () => openSettingsTab('peers');
    window.addEventListener('tray:open-peers', handleTrayOpenPeers);
    return () => window.removeEventListener('tray:open-peers', handleTrayOpenPeers);
  }, []);

  // A tab dragged from another window onto THIS one: the backend hit-tests the
  // drop and emits `tab-drag:reattach` here; take the payload and add it as a tab.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const myLabel = getCurrentWindow().label;
        // Broadcast event: act only if THIS window is the intended target.
        unlisten = await listen('tab-drag:reattach', (event: any) => {
          const p = event?.payload;
          if (!p || typeof p !== 'object') return;
          if (p.target !== myLabel || typeof p.token !== 'string') return;
          void applyReattachByToken(p.token);
        });
      } catch {
        // Not under Tauri — cross-window reattach unavailable.
      }
    })();
    return () => unlisten?.();
  }, []);

  // Keep the OS window title in sync with the active tab and refresh the native
  // Window menu. Select the derived STRING (not the tabs array) so this effect
  // — an IPC call — fires only when the title actually changes, not on every
  // tab-state mutation (e.g. per-command OSC title updates re-rendering tabs).
  const activeTitle = useSelector((state: RootState) => {
    const t = state.tabs.tabs.find((x) => x.isActive) || state.tabs.tabs[0];
    return t?.title || 'Auto Terminal';
  });
  useEffect(() => {
    (async () => {
      try {
        // One call sets the native title AND rebuilds the Window menu from the
        // recorded title, so the menu never reads a stale/uncommitted title.
        await window.electronAPI?.setWindowTitle?.(activeTitle);
      } catch {
        // Not under Tauri.
      }
    })();
  }, [activeTitle]);

  // Spec 045 §3.3b: warm every running terminal's cwd BEFORE saving. saveState()
  // is synchronous through to localStorage.setItem (it also runs from
  // `beforeunload`, which cannot await), so the map has to be populated ahead of
  // it. A terminal still running at quit never fires an exit event, so this is
  // the only path that can capture its directory.
  //
  // `timeoutMs` bounds the refresh: a stale directory is a far better outcome than
  // a save that appears to hang. The save runs either way.
  const saveStateWithCwds = async (timeoutMs?: number): Promise<void> => {
    try {
      const st = store.getState();
      const ids = new Set<string>();
      const walk = (node: any): void => {
        if (!node) return;
        if (node.terminalId) ids.add(node.terminalId);
        node.children?.forEach(walk);
      };
      Object.values(st.panes.treesByTabId || {}).forEach(walk);
      lastCwdRefreshAt.current = Date.now();
      const refresh = refreshLiveCwds([...ids]);
      await (timeoutMs === undefined
        ? refresh
        : Promise.race([refresh, new Promise(resolve => setTimeout(resolve, timeoutMs))]));
    } catch (err) {
      console.warn('App: cwd refresh failed; saving with the previous values', err);
    }
    StateManager.saveState();
  };

  useEffect(() => {
    // Initialize app
    initializeApp();

    // Save state when window is about to close
    const handleBeforeUnload = () => {
      StateManager.saveState();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    // Auto-save state every 30 seconds
    const autoSaveInterval = setInterval(() => {
      void saveStateWithCwds();
    }, 30000);

    // Save state when visibility changes (e.g., switching apps).
    //
    // Throttled: every refresh costs a full process-table scan for any terminal
    // without an OSC-reported cwd (cmd/WSL/bash/zsh — i.e. every terminal on
    // Linux), and alt-tabbing fires this event as fast as the user can switch.
    // Unthrottled that is a burst of scans per second, for a directory that
    // cannot meaningfully have changed between them. The window matches the
    // autosave tick's granularity: anything newer than this is already warm, and
    // the worst case is a save carrying directories a few seconds old — which is
    // exactly what the 30s autosave already persists.
    const CWD_REFRESH_THROTTLE_MS = 5000;
    const handleVisibilityChange = () => {
      if (!document.hidden) return;
      if (Date.now() - lastCwdRefreshAt.current < CWD_REFRESH_THROTTLE_MS) {
        // Still save — only the (expensive) cwd warm-up is skipped.
        StateManager.saveState();
        return;
      }
      void saveStateWithCwds();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // OS session switch (RDP↔console connect / unlock) repaints every TUI at once —
    // a synchronized ConPTY burst that would falsely ring the unseen bell on every
    // tab when you return to the machine. The DOM visibilitychange event does NOT
    // fire on a session connect/disconnect, so the backend (session_notify.rs)
    // detects it and emits `session:reconnect`; arm the same burst suppression the
    // visibility path uses.
    let sessionAlive = true;
    let unlistenSession: (() => void) | undefined;
    listen('session:reconnect', () => runningActivityTracker.notifyReconnectBurst())
      .then(fn => { if (sessionAlive) unlistenSession = fn; else fn(); })
      .catch(() => { /* not a tauri window / event API unavailable */ });

    // Stream 4: keep the per-terminal cwd snapshot fresh on every `cd` (backend emits
    // `terminal:cwd` from OSC 9;9/7) so command-history recording/ranking uses the
    // current directory, not the last 30s-autosave value. Keyed by backend processId.
    let cwdFeedAlive = true;
    let unlistenCwd: (() => void) | undefined;
    listen<{ id: string; cwd: string }>('terminal:cwd', (e) =>
      setCwdSnapshotByProcessId(e.payload.id, e.payload.cwd))
      .then(fn => { if (cwdFeedAlive) unlistenCwd = fn; else fn(); })
      .catch(() => { /* not a tauri window / event API unavailable */ });

    return () => {
      // Save state before cleanup
      StateManager.saveState();

      // Cleanup IPC listeners
      cleanupIPCListeners();
      inputHandler.destroy();

      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      sessionAlive = false;
      if (unlistenSession) unlistenSession();
      cwdFeedAlive = false;
      if (unlistenCwd) unlistenCwd();
      clearInterval(autoSaveInterval);
    };
  }, []);

  const initializeApp = async () => {
    console.log('Initializing app...');

    // Load config from file first
    await loadConfigSettings();

    // Backlog 011: warm the command-history index (non-blocking), and re-sync it
    // whenever this window regains focus — commands recorded in ANOTHER window
    // land in SQLite but not in this window's in-memory index.
    void commandHistoryService.hydrate();
    window.addEventListener('focus', () => {
      void commandHistoryService.hydrate();
    });

    // Always initialize shell profiles first (they need to be fresh from the system)
    console.log('Initializing shell profiles...');
    await initializeShellProfiles();

    // Wait a bit for shell profiles to be properly set in state
    await new Promise(resolve => setTimeout(resolve, 200));

    // Detached windows reconstruct a handed-off tab/pane (reattaching to the
    // existing live PTYs) instead of restoring the session or creating a default
    // tab. Fall through to normal init only if there was no payload to consume.
    if (isDetachWindow()) {
      const reconstructed = await reconstructDetachedWindow();
      if (reconstructed) {
        setupIPCListeners();
        inputHandler.enable();
        return;
      }
    }

    // A fresh "New Window" (File > New Window): don't restore the previous
    // session — just open a single default terminal tab.
    if (new URLSearchParams(window.location.search).has('newWindow')) {
      setupIPCListeners();
      inputHandler.enable();
      setTimeout(() => createDefaultTabIfNeeded(), 500);
      return;
    }

    // Check if we should restore last session
    let shouldRestore = true;
    try {
      if (window.electronAPI) {
        const config = await window.electronAPI.getConfig();
        shouldRestore = config.restoreLastSession !== false; // Default to true
        console.log('Restore last session:', shouldRestore);
      }
    } catch (error) {
      console.error('Failed to check restoreLastSession config:', error);
    }

    // Try to restore state if enabled
    let restored = false;
    if (shouldRestore) {
      restored = await StateManager.restoreState(dispatch);
    }
    console.log('State restored:', restored);

    // If no state was restored, create default tab if needed
    if (!restored) {
      console.log('No state restored, will create default tab in 500ms');
      // Increased delay to ensure shell profiles are properly loaded
      setTimeout(() => createDefaultTabIfNeeded(), 500);
    }

    // Set up IPC listeners
    setupIPCListeners();

    // Initialize input handler (it sets up its own listeners)
    inputHandler.enable();
  };

  const loadConfigSettings = async () => {
    try {
      if (window.electronAPI) {
        // Load config from file
        const config = await window.electronAPI.getConfig();

        // Apply theme settings
        if (config.theme) {
          dispatch(updateTheme(config.theme));
        }

        // Apply other settings
        if (config.fontSize) {
          dispatch(setFontSize(config.fontSize));
        }
        if (config.fontFamily) {
          dispatch(setFontFamily(config.fontFamily));
        }
        if (config.cursorStyle) {
          dispatch(setCursorStyle(config.cursorStyle));
        }
        if (config.cursorBlink !== undefined) {
          dispatch(setCursorBlink(config.cursorBlink));
        }
        if (config.scrollback) {
          dispatch(setScrollback(config.scrollback));
        }
        if (config.closeTabOnProcessExit !== undefined) {
          dispatch(setCloseTabOnProcessExit(config.closeTabOnProcessExit));
        }
        if (config.tabSizingMode === 'shrink' || config.tabSizingMode === 'scroll' || config.tabSizingMode === 'fixed') {
          dispatch(setTabSizingMode(config.tabSizingMode));
        }
        if (config.fixedTabWidth) {
          dispatch(setFixedTabWidth(config.fixedTabWidth));
        }
        if (typeof config.colorSchemaId === 'string') {
          dispatch(setColorSchema(config.colorSchemaId));
        }
        if (config.agentColorSchemes && typeof config.agentColorSchemes === 'object') {
          dispatch(setAgentColorSchemes(config.agentColorSchemes));
        }
        if (config.customKeybindings && typeof config.customKeybindings === 'object') {
          // Drop any actionId not in the current registry (stale config from a
          // removed feature, or a hand-edited file) so it doesn't persist
          // forever in config and in the Shortcuts category's dirty-tracking
          // snapshot even though the UI can never surface or clear it.
          //
          // Also require a string value: config.json is untrusted external
          // input (hand-editable) — a corrupted/malformed entry (null, a
          // number, a nested object) reaching canonicalizeCombo's
          // .toLowerCase() would crash the renderer on startup.
          //
          // Also re-run full conflict validation (reserved combos AND
          // duplicates among the customizable actions themselves — found in
          // final PR review, first partially by codex [reserved-only], then
          // completed by the internal review workflow [duplicates]): the
          // normal recording UI always runs findConflict before saving, so
          // this can only happen via a hand-edited config file, but if it
          // did, applyKeybindingOverrides would silently let the later
          // action (in SHORTCUT_ACTIONS order) win the shared shortcuts Map
          // entry, leaving the other permanently unbound with the Settings
          // UI still showing BOTH rows as if actively bound — no error
          // surfaced anywhere. Accept entries in registry order, dropping
          // any that collide with an already-accepted one.
          const knownIds = new Set(SHORTCUT_ACTIONS.map(a => a.id));
          const candidate = Object.fromEntries(
            Object.entries(config.customKeybindings as Record<string, unknown>)
              .filter(([id, val]) => knownIds.has(id) && typeof val === 'string')
          ) as Record<string, string>;
          const accepted: Record<string, string> = {};
          for (const action of SHORTCUT_ACTIONS) {
            const combo = candidate[action.id];
            if (combo === undefined) continue;
            if (findConflict(action.id, combo, accepted)) continue; // reserved or duplicate — drop
            accepted[action.id] = combo;
          }
          dispatch(setCustomKeybindings(accepted));
        }
        if (config.activateTabOnApiCreate !== undefined) {
          dispatch(setActivateTabOnApiCreate(config.activateTabOnApiCreate));
        }
        if (config.defaultEditor !== undefined) {
          dispatch(setDefaultEditor(config.defaultEditor));
        }
        if (config.smartCtrlC !== undefined) {
          dispatch(setSmartCtrlC(config.smartCtrlC));
        }
        if (config.enhancedKeyboard !== undefined) {
          dispatch(setEnhancedKeyboard(config.enhancedKeyboard));
        }
        if (config.commandSuggestions !== undefined) {
          dispatch(setCommandSuggestions(config.commandSuggestions));
        }
        if (config.keepRunningInBackground !== undefined) {
          dispatch(setKeepRunningInBackground(config.keepRunningInBackground));
        }
        // Hydrate EULA acceptance (null when never accepted → the first-run modal shows).
        dispatch(hydrateEulaAcceptedVersion(
          typeof config.eulaAcceptedVersion === 'string' ? config.eulaAcceptedVersion : null,
        ));

        // Note: defaultProfile will be set after shell profiles are loaded
      }
    } catch (error) {
      console.error('Failed to load config settings:', error);
    }
  };

  const initializeShellProfiles = async () => {
    try {
      // Get actual shell profiles from the system
      if (window.electronAPI) {
        let profiles = await window.electronAPI.getShellProfiles();

        // Load settings to check for saved profile overrides (like CWD)
        try {
          const config = await window.electronAPI.getConfig();
          const savedProfiles = config.shellProfiles as any[];

          if (savedProfiles && Array.isArray(savedProfiles)) {
            // Merge saved overrides into system profiles
            profiles = profiles.map(p => {
              const saved = savedProfiles.find(sp => sp.id === p.id);
              if (saved) {
                // Keep system path/args, but use saved CWD/name if changed
                return { ...p, cwd: saved.cwd };
              }
              return p;
            });

            // Also append any custom profiles that might be in config but not system detected?
            // For now, let's stick to overrides of detected shells to avoid duplicates
          }
        } catch (err) {
          console.warn('Failed to load saved profile settings:', err);
        }

        dispatch(setShellProfiles(profiles));

        // Load saved default profile from config
        const savedDefaultProfile = await window.electronAPI.getDefaultProfile();
        if (savedDefaultProfile && profiles.some(p => p.id === savedDefaultProfile)) {
          dispatch(setDefaultProfile(savedDefaultProfile));
        }
      } else {
        // Fallback mock profiles if electronAPI not available
        dispatch(setShellProfiles([
          { id: 'cmd', name: 'Command Prompt', path: 'cmd.exe', args: [], env: {} },
          { id: 'powershell', name: 'PowerShell', path: 'powershell.exe', args: [], env: {} },
          { id: 'bash', name: 'Git Bash', path: 'bash.exe', args: [], env: {} },
        ]));
      }
    } catch (error) {
      console.error('Failed to get shell profiles:', error);
    }
  };

  const createDefaultTabIfNeeded = () => {
    console.log('Checking if default tab needed...');
    const currentTabs = (window as any).__REDUX_STORE__?.getState()?.tabs?.tabs || [];
    console.log('Current tabs:', currentTabs.length, 'Shell profiles:', shellProfiles.length);

    if (currentTabs.length === 0 && shellProfiles.length > 0) {
      const defaultShell = shellProfiles.find(p => p.id === defaultProfile) || shellProfiles[0];
      console.log('Creating default tab with shell:', defaultShell);

      const generateUniqueTabName = (baseName: string): string => {
        const existingNames = currentTabs.map((tab: any) => tab.title);
        let counter = 1;
        let uniqueName = baseName;

        while (existingNames.includes(uniqueName)) {
          uniqueName = `${baseName} ${counter}`;
          counter++;
        }

        return uniqueName;
      };

      const uniqueTitle = generateUniqueTabName(defaultShell.name);

      const newTab = {
        id: generateId('tb'),
        title: uniqueTitle,
        shellType: defaultShell.id,
        icon: '🖥️',
      };

      console.log('Dispatching addTab with:', newTab);
      dispatch(addTab(newTab));
    }
  };

  const handleExternalActivity = (event: CustomEvent) => {
    const detail = (event.detail || {}) as { terminalId?: string; tabId?: string | null };
    let tabId: string | null = detail.tabId ?? null;
    if (!tabId && detail.terminalId) {
      tabId = findTabIdByTerminalId(store.getState().panes.treesByTabId, detail.terminalId);
    }
    if (tabId) {
      dispatch(flagTabActivity({ tabId }));
    }
  };

  const setupIPCListeners = () => {
    // Listen for menu commands
    window.addEventListener('menu:newTab', handleNewTab);
    window.addEventListener('menu:closeTab', handleCloseTab);
    window.addEventListener('menu:splitHorizontal', handleSplitHorizontal);
    window.addEventListener('menu:splitVertical', handleSplitVertical);
    window.addEventListener('menu:clearTerminal', handleClearTerminal);
    window.addEventListener('menu:clearScrollback', handleClearScrollback);
    window.addEventListener('menu:runCommand', handleRunCommand);
    window.addEventListener('menu:find', handleFind);
    window.addEventListener('menu:preferences', handlePreferences);

    // Listen for API terminal creation
    window.addEventListener('api:createTerminalTab', handleAPICreateTerminalTab as any);
    // Flash a tab when an external MCP/API call interacts with one of its terminals
    window.addEventListener('terminal:external-activity', handleExternalActivity as any);
    // Drive the per-tab "running" sweep from the live output stream.
    runningActivityTracker.start();
    // Poll each pane's foreground agent and apply per-agent color schemes.
    agentSchemeTracker.start();

    // Listen for UI state requests
    window.addEventListener('ui:requestTabsData', handleRequestTabsData);
    // React to terminal process exits (close or mark the tab per user setting)
    window.addEventListener('pty:exit', handleTerminalProcessExit);
    // Stop the WebView's native page zoom for the zoom shortcuts/gestures. The
    // actual zoom is done per-surface (terminal panes + the Settings screen). We
    // run in capture without stopPropagation, so the surface handlers still fire.
    window.addEventListener('keydown', handleBlockNativeZoom, true);
    window.addEventListener('wheel', handleBlockNativeZoomWheel, { passive: false, capture: true });
    // Block webview reload (Ctrl+R / Ctrl+Shift+R / F5) — capture phase so it runs
    // before the page would reload.
    window.addEventListener('keydown', handleSuppressReload, true);
  };

  const cleanupIPCListeners = () => {
    window.removeEventListener('menu:newTab', handleNewTab);
    window.removeEventListener('menu:closeTab', handleCloseTab);
    window.removeEventListener('menu:splitHorizontal', handleSplitHorizontal);
    window.removeEventListener('menu:splitVertical', handleSplitVertical);
    window.removeEventListener('menu:clearTerminal', handleClearTerminal);
    window.removeEventListener('menu:clearScrollback', handleClearScrollback);
    window.removeEventListener('menu:runCommand', handleRunCommand);
    window.removeEventListener('menu:find', handleFind);
    window.removeEventListener('menu:preferences', handlePreferences);

    // Remove API listener
    window.removeEventListener('api:createTerminalTab', handleAPICreateTerminalTab as any);
    window.removeEventListener('terminal:external-activity', handleExternalActivity as any);
    runningActivityTracker.stop();
    agentSchemeTracker.stop();
    window.removeEventListener('ui:requestTabsData', handleRequestTabsData);
    window.removeEventListener('pty:exit', handleTerminalProcessExit);

    window.removeEventListener('keydown', handleBlockNativeZoom, true);
    window.removeEventListener('wheel', handleBlockNativeZoomWheel, true);
    window.removeEventListener('keydown', handleSuppressReload, true);
  };

  // Reloading the webview re-spawns every terminal and orphans the live PTYs (the
  // Rust backend keeps them running), so the backend accumulates duplicate
  // terminals on each reload. Block the browser reload shortcuts. We only
  // preventDefault (never stopPropagation), so the session-closed banner's own
  // Ctrl+R restart — and the shell's Ctrl+R reverse-search — still receive the key.
  const handleSuppressReload = (e: KeyboardEvent) => {
    const isReload =
      e.key === 'F5' ||
      ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'));
    if (isReload) {
      e.preventDefault();
    }
  };

  // Zoom is per-surface now (each terminal pane and the Settings screen own their
  // own zoom level — see useSurfaceZoom / TerminalEngine.onZoom). These two
  // handlers ONLY suppress the WebView's native page zoom so the per-surface
  // handlers are the single source of truth. OS-aware: Cmd on macOS, Ctrl else.
  const isMacPlatform = typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac');

  const handleBlockNativeZoom = (e: KeyboardEvent) => {
    const mod = isMacPlatform ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    if (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '_' || e.key === '0') {
      e.preventDefault();
    }
  };

  const handleBlockNativeZoomWheel = (e: WheelEvent) => {
    const mod = isMacPlatform ? e.metaKey : e.ctrlKey;
    if (mod) e.preventDefault();
  };

  const handleNewTab = () => {
    const shells = shellProfiles;
    if (shells.length === 0) return;

    // For now, use the first shell. Later we'll add a selector
    const defaultShell = shells[0];
    const newTab = {
      id: generateId('tb'),
      title: `Terminal ${tabs.length + 1}`,
      shellType: defaultShell.id,
      icon: '🖥️',
    };

    dispatch(addTab(newTab));
  };

  const handleCloseTab = () => {
    const activeTab = tabs.find(tab => tab.isActive);
    if (activeTab) {
      console.log('Close tab requested via menu for:', activeTab.id);
      window.dispatchEvent(new CustomEvent('ui:requestTabClose', { detail: { tabId: activeTab.id } }));
    }
  };

  // When a terminal process exits (Ctrl-D, crash, or an agent/API close call),
  // decide what happens to its UI tab based on the user's setting:
  //   - closeTabOnProcessExit = true  -> close the tab automatically
  //   - closeTabOnProcessExit = false -> keep the tab, marked terminated, so the
  //     user can review what an agent did while they were away.
  const handleTerminalProcessExit = (event: Event) => {
    const detail = (event as CustomEvent).detail || {};
    const terminalId: string | undefined = detail.terminalId;
    const exitCode: number | null = typeof detail.exitCode === 'number' ? detail.exitCode : null;
    if (!terminalId) return;

    const state = (window as any).__REDUX_STORE__?.getState();
    // A split-pane terminal's exit is surfaced inline by the "[Process exited]"
    // banner the TerminalDisplay listener writes; here we decide the tab-level
    // affordance. A tab's root pane carries terminalId === tabId, so a root-pane
    // exit resolves directly; a non-root pane's exit is resolved via its tree.
    // Either way, the tab only counts as exited once EVERY terminal in its tree
    // has no live process — a lone sibling exiting leaves a multi-pane tab
    // running, but the LAST pane to exit (root or not) must still trigger the
    // tab-level close/mark, which a "root-pane-only" check would miss.
    const tabIds: string[] = state?.tabs?.tabs?.map((t: any) => t.id) ?? [];
    const treesByTabId = state?.panes?.treesByTabId ?? {};
    const tabId = resolveExitedTabId(treesByTabId, tabIds, terminalId, (id) =>
      !!terminalService.getProcessIdForTerminal(id)
    );
    if (!tabId) return;

    const tab = state?.tabs?.tabs?.find((t: any) => t.id === tabId);
    if (!tab) return;

    if (state?.settings?.closeTabOnProcessExit) {
      // Force-close (no confirm dialog) — the process is already gone, so the
      // "running processes will be terminated" prompt would be wrong.
      console.log(`Process for tab ${tabId} exited; auto-closing tab.`);
      window.dispatchEvent(new CustomEvent('ui:forceTabClose', { detail: { tabId } }));
    } else if (!tab.exited) {
      console.log(`Process for tab ${tabId} exited; keeping tab open for review.`);
      dispatch(markTabExited({ tabId, exitCode }));
    }
  };

  const handleSplitHorizontal = async () => {
    const { splitPane } = await import('./store/slices/panesSlice');
    const state = (window as any).__REDUX_STORE__?.getState();
    const activePaneId = state?.panes?.activePaneId;
    if (activePaneId) {
      dispatch(splitPane({ paneId: activePaneId, direction: 'horizontal' }));
    }
  };

  const handleSplitVertical = async () => {
    const { splitPane } = await import('./store/slices/panesSlice');
    const state = (window as any).__REDUX_STORE__?.getState();
    const activePaneId = state?.panes?.activePaneId;
    if (activePaneId) {
      dispatch(splitPane({ paneId: activePaneId, direction: 'vertical' }));
    }
  };

  const handleClearTerminal = () => {
    // Clear current terminal - this will be implemented with terminal instance access
    console.log('Clear terminal requested - implementation pending');
  };

  const handleClearScrollback = () => {
    // Clear terminal scrollback buffer - this will be implemented with terminal instance access
    console.log('Clear scrollback requested - implementation pending');
  };

  const handleRunCommand = () => {
    // Open command palette - Ctrl+Shift+R
    console.log('Run command requested - command palette not yet implemented');
    // TODO: Open command palette component when implemented
  };

  const handleFind = () => {
    // Open find in terminal - Ctrl+F
    console.log('Find requested - implementation pending');
    // TODO: Focus terminal search when implemented
  };

  const handlePreferences = () => {
    // Open preferences/settings
    console.log('Preferences requested - implementation pending');
    // TODO: Open settings modal when implemented
  };

  const handleAPICreateTerminalTab = async (event: CustomEvent) => {
    try {
      const options = event.detail as { name: string; profile: string; tabId?: string; paneId?: string; direction?: 'horizontal' | 'vertical'; terminalId?: string };
      console.log('API: Creating terminal tab', options);

      const { name, profile, tabId, paneId, direction, terminalId } = options;

      // `store` is the file-scoped Redux store import (the same instance as
      // window.__REDUX_STORE__) — always defined, so no local alias/shadow.
      const activateOnApiCreate = !!store.getState()?.settings?.activateTabOnApiCreate;
      const tabCount = store.getState()?.tabs?.tabs?.length ?? 0;

      const tabExists = (id?: string) =>
        !!(window as any).__REDUX_STORE__?.getState()?.tabs?.tabs?.find((t: any) => t.id === id);

      if (terminalId && !paneId && (!tabId || !tabExists(tabId))) {
        // Mode 0: Create a NEW tab for a backend-spawned terminal that has no
        // open UI tab yet (e.g. an agent created it via the API). The backend now
        // ALWAYS sends a generated tb- id, so we must also create the tab when
        // that id matches no open tab — not only when tabId is absent. (Splits,
        // which carry a paneId, are handled by Mode 1.)
        console.log(`API: Creating new tab for backend terminal ${terminalId} (tabId ${tabId || 'none'})`);

        // Resolve a tab ID that starts with 'tb-' (or generate one if not provided)
        const targetTabId = tabId || generateId('tb');

        // Map the UI terminalId (the tab id) to the backend processId so the pane
        // reuses the existing PTY instead of spawning a new one.
        const terminalService = (window as any).terminalService;
        if (terminalService && terminalId) {
          terminalService.registerExistingTerminal(targetTabId, terminalId);
        }

        const newTab = buildApiCreatedTab({ targetTabId, name, profile, defaultProfile });

        const paneTree = {
          id: generateId('pn'),
          type: 'terminal' as const,
          terminalId: targetTabId,
          name: name || 'Terminal',
          shellType: profile || defaultProfile || 'default',
        };

        // Seed the window map (API/persistence) AND the authoritative Redux store
        // (which TerminalContainer renders from) so the tab shows immediately.
        if (!(window as any).tabPanes) (window as any).tabPanes = {};
        (window as any).tabPanes[targetTabId] = paneTree;

        const { setActiveTab } = await import('./store/slices/tabsSlice');
        const { addTabTree, setActiveTabId } = await import('./store/slices/panesSlice');
        // Default: do NOT steal focus for an API/MCP-created tab. Activate only
        // when the user opted in, or when there is no tab at all (otherwise the
        // UI would have no active tab and render blank).
        const shouldActivate = activateOnApiCreate || tabCount === 0;
        dispatch(addTab({ ...newTab, isActive: shouldActivate }));
        dispatch(addTabTree({ tabId: targetTabId, tree: paneTree }));
        if (shouldActivate) {
          dispatch(setActiveTab(targetTabId));
          dispatch(setActiveTabId(targetTabId));
        }

        // Notify backend that UI tab is ready
        if (window.electronAPI) {
          window.electronAPI.sendToMain('api:terminalTabCreated', {
            terminalId: terminalId,
            tabId: targetTabId,
            name: name,
            success: true
          });
        }
        return;
      }

      if (tabId && paneId) {
        // Mode 1: Split an existing pane in a specific tab
        console.log(`API: Splitting pane ${paneId} in tab ${tabId} with existing terminalId: ${terminalId}`);

        // Register terminalId with terminalService first if we have one
        if (terminalId) {
          const terminalService = (window as any).terminalService;
          if (terminalService) {
            terminalService.registerExistingTerminal(terminalId, terminalId);
          }
        }

        // Get the pane tree before the split to find existing terminal IDs.
        // Read from the authoritative per-tab Redux store (not the legacy
        // window.tabPanes mirror, which can be stale) — otherwise the post-split
        // findNewestTerminal() could mis-identify a pre-existing terminal as the
        // new one and report the wrong id/processId in api:terminalTabCreated.
        const paneTreeBefore = store?.getState()?.panes?.treesByTabId?.[tabId] ?? null;
        const existingTerminalIds = new Set<string>();
        const collectTerminalIds = (node: any) => {
          if (!node) return;
          if (node.type === 'terminal' && node.terminalId) {
            existingTerminalIds.add(node.terminalId);
          }
          if (node.children) {
            node.children.forEach(collectTerminalIds);
          }
        };
        collectTerminalIds(paneTreeBefore);

        // Add the pane to the target tab directly — never activate it.
        const { splitPaneInTab } = await import('./store/slices/panesSlice');
        dispatch(splitPaneInTab({
          tabId: tabId,
          paneId: paneId,
          direction: direction || 'vertical', // Default to vertical if not specified
          shellType: profile || defaultProfile || 'cmd',
          name: name,
          terminalId: terminalId // Reuse the existing backend process
        }));

        // The new terminal will be created automatically by TerminalPane
        // Wait for it to be created
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Find the newly created terminal. Read the updated tree for THIS tab
        // from the authoritative per-tab store, and keep window.tabPanes in sync.
        const paneTree = store?.getState()?.panes?.treesByTabId?.[tabId] ?? null;
        if (paneTree) {
          if (!(window as any).tabPanes) (window as any).tabPanes = {};
          (window as any).tabPanes[tabId] = paneTree;
        }

        // Find the newest terminal pane (the one that wasn't in the tree before)
        let newestTerminalId: string | null = null;
        let newestPaneId: string | null = null;

        const findNewestTerminal = (node: any) => {
          if (node.type === 'terminal' && node.terminalId) {
            if (!existingTerminalIds.has(node.terminalId)) {
              newestTerminalId = node.terminalId;
              newestPaneId = node.id;
              return;
            }
            if (!newestTerminalId) {
              newestTerminalId = node.terminalId;
              newestPaneId = node.id;
            }
          }
          if (node.children) {
            node.children.forEach(findNewestTerminal);
          }
        };

        if (paneTree) {
          findNewestTerminal(paneTree);
        }

        const terminalService = (window as any).terminalService;
        let processId = newestTerminalId ? terminalService?.getProcessId(newestTerminalId) : null;

        // For pane terminals, wait longer as they need to be created
        let isPaneTerminal = false;
        let maxRetries = 5;
        if (newestTerminalId) {
          isPaneTerminal = (newestTerminalId as string).startsWith('tm-') || (newestTerminalId as string).startsWith('pane-terminal-');
          maxRetries = isPaneTerminal ? 20 : 5; // 2 seconds for pane terminals, 500ms for others
        }
        const retryDelay = 100;

        if (!processId && newestTerminalId) {
          console.log(`API Mode 1: Process not ready for ${newestTerminalId}, waiting up to ${maxRetries * retryDelay}ms...`);
          for (let i = 0; i < maxRetries; i++) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            processId = terminalService?.getProcessId(newestTerminalId);
            if (processId) {
              console.log(`API Mode 1: Found process ID ${processId} on retry ${i + 1} after ${(i + 1) * retryDelay}ms`);
              break;
            }
          }
        }

        // Send confirmation back - only include process ID if we actually have one
        if (window.electronAPI) {
          const response: any = {
            terminalId: newestTerminalId || 'unknown',
            tabId: tabId,
            paneId: newestPaneId || paneId,
            name: name,
            success: true
          };

          // Only include processId if we actually found one
          if (processId) {
            response.processId = processId;
            console.log(`API Mode 1: Sending response with process ID: ${processId}`);
          } else {
            console.log(`API Mode 1: WARNING - No process ID found for terminal ${newestTerminalId}`);
          }

          window.electronAPI.sendToMain('api:terminalTabCreated', response);
        }

      } else if (tabId && !paneId) {
        // Mode 2: Find a pane in the tab to split
        console.log(`API: Creating terminal in tab ${tabId} (finding suitable pane)`);

        // Get the tab info first (store = file-scoped Redux import, always defined)
        const state = store.getState();
        const tab = state.tabs.tabs.find((t: any) => t.id === tabId);

        if (!tab) {
          throw new Error(`Tab ${tabId} not found`);
        }

        // The backend already spawned the process; register it so the new pane
        // reuses it (identity map: pane terminalId === backend processId) instead
        // of spawning a second, orphaned terminal.
        if (terminalId) {
          (window as any).terminalService?.registerExistingTerminal(terminalId, terminalId);
        }

        // Inspect THIS tab's tree from the authoritative per-tab store (not the
        // active-tab mirror) so we never need to activate it.
        const currentState = store.getState();
        const currentPaneTree = currentState.panes.treesByTabId?.[tabId] ?? null;

        console.log('API: Current tab pane tree:', JSON.stringify(currentPaneTree, null, 2));

        // Check if we have a pane tree with actual terminals
        let hasValidPaneTree = false;
        const checkForTerminals = (node: any): boolean => {
          if (!node) return false;
          if (node.type === 'terminal' && node.terminalId) return true;
          if (node.children) {
            return node.children.some((child: any) => checkForTerminals(child));
          }
          return false;
        };

        if (currentPaneTree) {
          hasValidPaneTree = checkForTerminals(currentPaneTree);
        }

        if (!currentPaneTree || !hasValidPaneTree) {
          // No pane tree or no terminals - create a new terminal instead of splitting
          console.log('API: No valid pane tree found, creating new terminal in tab');

          // Seed a single terminal in THIS tab without activating it.
          const { splitPaneInTab } = await import('./store/slices/panesSlice');
          const newTerminalId = terminalId || generateId('tm');
          dispatch(splitPaneInTab({
            tabId: tabId,
            direction: direction || 'vertical',
            shellType: profile || tab.shellType || defaultProfile || 'cmd',
            name: name || tab.title,
            terminalId: newTerminalId,
          }));

          // Mirror to the legacy window map for persistence/readers.
          const seededTree = store?.getState()?.panes?.treesByTabId?.[tabId] ?? null;
          if (seededTree) {
            if (!(window as any).tabPanes) (window as any).tabPanes = {};
            (window as any).tabPanes[tabId] = seededTree;
          }
          const newPaneId = store?.getState()?.panes?.activePaneByTabId?.[tabId] ?? generateId('pn');

          console.log('API: Created new terminal in empty tab:', (window as any).tabPanes?.[tabId]);

          // Wait for terminal to be created
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Get the terminal service and wait for process
          const terminalService = (window as any).terminalService;
          let processId = terminalService?.getProcessId(newTerminalId);

          // Wait for process with extended timeout
          const maxRetries = 20; // 2 seconds
          const retryDelay = 100;

          if (!processId) {
            console.log(`API: Waiting for process for new terminal ${newTerminalId}...`);
            for (let i = 0; i < maxRetries; i++) {
              await new Promise(resolve => setTimeout(resolve, retryDelay));
              processId = terminalService?.getProcessId(newTerminalId);
              if (processId) {
                console.log(`API: Found process ID ${processId} after ${(i + 1) * retryDelay}ms`);
                break;
              }
            }
          }

          // Send response
          if (window.electronAPI) {
            const response: any = {
              terminalId: newTerminalId,
              tabId: tabId,
              paneId: newPaneId,
              name: name,
              success: true
            };

            if (processId) {
              response.processId = processId;
              console.log(`API: Sending response with process ID: ${processId}`);
            } else {
              console.log(`API: WARNING - No process ID found for terminal ${newTerminalId}`);
            }

            window.electronAPI.sendToMain('api:terminalTabCreated', response);
          }

          return; // Exit early, we're done
        }

        // Use the current pane tree from Redux
        let paneTree = currentPaneTree;

        // Auto-distribution logic when no direction specified
        let autoDirection: 'horizontal' | 'vertical' = direction || 'vertical';
        if (!direction) {
          // Count terminals and analyze tree structure
          const analyzeTree = (node: any): { terminalCount: number; maxDepth: number; structure: any } => {
            if (node.type === 'terminal') {
              return { terminalCount: 1, maxDepth: 0, structure: { type: 'terminal' } };
            }

            if (node.type === 'split' && node.children) {
              let totalTerminals = 0;
              let maxChildDepth = 0;
              const childStructures: any[] = [];

              for (const child of node.children) {
                const childAnalysis = analyzeTree(child);
                totalTerminals += childAnalysis.terminalCount;
                maxChildDepth = Math.max(maxChildDepth, childAnalysis.maxDepth);
                childStructures.push(childAnalysis);
              }

              return {
                terminalCount: totalTerminals,
                maxDepth: maxChildDepth + 1,
                structure: {
                  type: 'split',
                  direction: node.direction,
                  children: childStructures
                }
              };
            }

            return { terminalCount: 0, maxDepth: 0, structure: {} };
          };

          const treeAnalysis = analyzeTree(paneTree);
          console.log(`API: Tree analysis - Terminals: ${treeAnalysis.terminalCount}, Max depth: ${treeAnalysis.maxDepth}`);

          // Smart auto-distribution algorithm
          if (treeAnalysis.terminalCount === 1) {
            // First split is always vertical (side by side)
            autoDirection = 'vertical';
          } else if (treeAnalysis.terminalCount === 2) {
            // Third terminal: check current structure
            if (paneTree.type === 'split' && paneTree.direction === 'vertical') {
              // We have 2 terminals side by side, split one horizontally
              autoDirection = 'horizontal';
            } else {
              autoDirection = 'vertical';
            }
          } else {
            // For 4+ terminals, alternate to create balanced layout
            // Count splits at each level to determine best direction
            let verticalSplits = 0;
            let horizontalSplits = 0;

            const countSplits = (node: any) => {
              if (node.type === 'split') {
                if (node.direction === 'vertical') verticalSplits++;
                else horizontalSplits++;

                if (node.children) {
                  node.children.forEach((child: any) => countSplits(child));
                }
              }
            };

            countSplits(paneTree);

            // Balance the splits - prefer the direction with fewer splits
            autoDirection = verticalSplits > horizontalSplits ? 'horizontal' : 'vertical';

            console.log(`API: Split counts - Vertical: ${verticalSplits}, Horizontal: ${horizontalSplits}`);
          }

          console.log(`API: Auto-distribution selected: ${autoDirection} split`);
        }

        // Find the best pane to split for even distribution
        const findBestPaneToSplit = (node: any, path: string[] = []): { paneId: string; score: number; path: string[] } | null => {
          if (node.type === 'terminal') {
            // Score based on path depth - prefer shallower terminals for more even distribution
            return { paneId: node.id, score: path.length, path };
          }

          if (node.type === 'split' && node.children) {
            let bestCandidate: { paneId: string; score: number; path: string[] } | null = null;

            for (let i = 0; i < node.children.length; i++) {
              const childPath = [...path, `${node.direction}-${i}`];
              const candidate = findBestPaneToSplit(node.children[i], childPath);

              if (candidate) {
                if (!bestCandidate || candidate.score < bestCandidate.score) {
                  bestCandidate = candidate;
                }
              }
            }

            return bestCandidate;
          }

          return null;
        };

        const bestPane = findBestPaneToSplit(paneTree);
        if (!bestPane) {
          throw new Error('No terminal pane found in tab');
        }

        const targetPaneId = bestPane.paneId;
        console.log(`API: Selected pane ${targetPaneId} for ${autoDirection} split (depth: ${bestPane.score})`);

        // Collect existing terminal ids from THIS tab's tree before the split.
        const existingTerminalIds = new Set<string>();
        const collectTerminalIds = (node: any) => {
          if (!node) return;
          if (node.type === 'terminal' && node.terminalId) {
            existingTerminalIds.add(node.terminalId);
          }
          if (node.children) {
            node.children.forEach(collectTerminalIds);
          }
        };
        collectTerminalIds(store.getState().panes.treesByTabId?.[tabId] ?? null);

        // Split that pane in the target tab — never activate it.
        const { splitPaneInTab } = await import('./store/slices/panesSlice');
        dispatch(splitPaneInTab({
          tabId: tabId,
          paneId: targetPaneId,
          direction: autoDirection,
          shellType: profile || defaultProfile || 'cmd',
          name: name,
          terminalId: terminalId // Reuse the backend-created process (avoids orphaning it)
        }));

        console.log('API: Dispatched splitPaneInTab action');

        // Wait for the pane tree to update in Redux
        await new Promise(resolve => setTimeout(resolve, 100));

        // Read the updated tree for THIS tab (source of truth) and mirror it.
        const updatedTree = store.getState().panes.treesByTabId?.[tabId] ?? null;
        if (updatedTree) {
          if (!(window as any).tabPanes) (window as any).tabPanes = {};
          (window as any).tabPanes[tabId] = updatedTree;
          console.log('API: Updated tabPanes with per-tab Redux state');
        }

        // Force a re-read of the updated pane tree
        const updatedTabPanes = (window as any).tabPanes || {};
        console.log('API: Updated pane tree from tabPanes:', JSON.stringify(updatedTabPanes[tabId], null, 2));

        // Wait for terminal creation with smart polling
        console.log('API: Waiting for terminal to be created...');

        // First, find the new terminal ID from the updated pane tree
        let expectedTerminalId: string | null = null;
        const findNewTerminalId = (node: any) => {
          if (node.type === 'terminal' && node.terminalId && !existingTerminalIds.has(node.terminalId)) {
            expectedTerminalId = node.terminalId;
          }
          if (node.children) {
            node.children.forEach((child: any) => findNewTerminalId(child));
          }
        };

        if (updatedTree) {
          findNewTerminalId(updatedTree);
        }

        // Poll for the terminal to be created (max 2 seconds)
        const terminalSvc = (window as any).terminalService;
        let terminalReady = false;
        for (let i = 0; i < 20; i++) {  // 20 * 100ms = 2 seconds max
          if (expectedTerminalId && terminalSvc?.getProcessId(expectedTerminalId)) {
            console.log(`API: Terminal ${expectedTerminalId} is ready after ${(i + 1) * 100}ms`);
            terminalReady = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (!terminalReady) {
          console.log('API: Terminal not ready after 2 seconds, continuing anyway');
        }

        // Re-read THIS tab's pane tree from Redux after waiting.
        const finalPaneTree = store.getState().panes.treesByTabId?.[tabId] ?? null;
        console.log('API: Final tab pane tree after wait:', JSON.stringify(finalPaneTree, null, 2));

        // Also check tabPanes
        const finalTabPanes = (window as any).tabPanes || {};
        console.log('API: Final tabPanes tree after wait:', JSON.stringify(finalTabPanes[tabId], null, 2));

        // Check terminal service for all terminals
        const terminalServiceState = (window as any).terminalService;
        if (terminalServiceState) {
          console.log('API: Terminal service terminals:', Object.keys(terminalServiceState.terminals || {}));
        }

        // Find the newly created terminal
        let newestTerminalId: string | null = null;
        let newestPaneId: string | null = null;

        const findNewestTerminal = (node: any) => {
          console.log('API: Checking node:', node);
          if (node.type === 'terminal' && node.terminalId) {
            console.log(`API: Found terminal node with ID: ${node.terminalId}`);
            if (!existingTerminalIds.has(node.terminalId)) {
              console.log(`API: Identified new terminal ID: ${node.terminalId}`);
              newestTerminalId = node.terminalId;
              newestPaneId = node.id;
              return;
            }
            if (!newestTerminalId) {
              newestTerminalId = node.terminalId;
              newestPaneId = node.id;
            }
          }
          if (node.children) {
            node.children.forEach((child: any) => findNewestTerminal(child));
          }
        };

        // Use the Redux pane tree to find the newest terminal
        if (finalPaneTree) {
          findNewestTerminal(finalPaneTree);
        } else {
          console.log('API: WARNING - No pane tree found after split!');
        }

        console.log('API: Found newest terminal:', newestTerminalId, 'in pane:', newestPaneId);

        const terminalService = (window as any).terminalService;
        console.log('API: Terminal service available:', !!terminalService);
        if (terminalService) {
          console.log('API: Terminal service terminals:', Object.keys(terminalService.terminals || {}));
        }

        // Try to get process ID (wait longer for pane terminals)
        let processId = newestTerminalId ? terminalService?.getProcessId(newestTerminalId) : null;

        // For pane terminals, wait longer as they need to be created
        let isPaneTerminal = false;
        let maxRetries = 5;
        if (newestTerminalId) {
          isPaneTerminal = (newestTerminalId as string).startsWith('tm-') || (newestTerminalId as string).startsWith('pane-terminal-');
          maxRetries = isPaneTerminal ? 20 : 5; // 2 seconds for pane terminals, 500ms for others
        }
        const retryDelay = 100;

        if (!processId && newestTerminalId) {
          console.log(`API: Process not ready for ${newestTerminalId}, waiting up to ${maxRetries * retryDelay}ms...`);
          for (let i = 0; i < maxRetries; i++) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            processId = terminalService?.getProcessId(newestTerminalId);
            if (processId) {
              console.log(`API: Found process ID ${processId} on retry ${i + 1} after ${(i + 1) * retryDelay}ms`);
              break;
            }
            // Also check if the terminal exists in the terminal service
            if (i % 5 === 4) {
              console.log(`API: Still waiting for terminal ${newestTerminalId} to be created... (${(i + 1) * retryDelay}ms elapsed)`);
              if (terminalService && terminalService.terminals) {
                console.log('API: Current terminals in service:', Object.keys(terminalService.terminals));
              }
            }
          }
        }

        console.log('API: Looking for process ID for terminal:', newestTerminalId);
        console.log('API: Terminal process ID:', processId);

        // Send response - only include process ID if we actually have one
        if (window.electronAPI) {
          const response: any = {
            terminalId: newestTerminalId || 'unknown',
            tabId: tabId,
            paneId: newestPaneId || targetPaneId,
            name: name,
            success: true
          };

          // Only include processId if we actually found one
          if (processId) {
            response.processId = processId;
            console.log(`API: Sending response with process ID: ${processId}`);
          } else {
            console.log(`API: WARNING - No process ID found for terminal ${newestTerminalId}, response will trigger fallback logic`);
          }

          window.electronAPI.sendToMain('api:terminalTabCreated', response);
        }

      } else {
        // Mode 3: Create a new tab (original behavior — no backend-spawned terminal).
        console.log('API: Creating new tab with terminal');

        // Generate unique tab ID
        const newTabId = generateId('tb');

        // Create new tab
        const newTab = buildApiCreatedTab({
          targetTabId: newTabId,
          name,
          profile,
          defaultProfile,
          fallbackTitle: 'API Terminal',
          shellTypeFallback: 'cmd',
        });

        // Store the pane tree for this tab
        if (!(window as any).tabPanes) {
          (window as any).tabPanes = {};
        }

        const newPaneId = generateId('pn');
        const paneTree = {
          id: newPaneId,
          type: 'terminal' as const,
          terminalId: newTabId,
          name: name || 'API Terminal', // Add name to the pane
          shellType: profile || defaultProfile || 'cmd' // Include shell type
        };

        (window as any).tabPanes[newTabId] = paneTree;

        // Seed the authoritative per-tab tree and add the tab. Default: do NOT
        // steal focus (same rule as Mode 0). Activate only when the user opted in
        // or there is no tab at all.
        const { setActiveTab } = await import('./store/slices/tabsSlice');
        const { addTabTree, setActiveTabId } = await import('./store/slices/panesSlice');
        const shouldActivate = activateOnApiCreate || tabCount === 0;
        dispatch(addTab({ ...newTab, isActive: shouldActivate }));
        dispatch(addTabTree({ tabId: newTabId, tree: paneTree }));
        if (shouldActivate) {
          dispatch(setActiveTab(newTabId));
          dispatch(setActiveTabId(newTabId));
        }

        // Wait for terminal to be created
        await new Promise(resolve => setTimeout(resolve, 500));

        // Get the process ID
        const terminalService = (window as any).terminalService;
        const processId = terminalService?.getProcessId(newTabId);

        // Send confirmation back to main process
        if (window.electronAPI) {
          window.electronAPI.sendToMain('api:terminalTabCreated', {
            terminalId: newTabId,
            processId: processId || null,
            tabId: newTabId,
            paneId: newPaneId,
            name: name,
            success: true
          });
        }
      }
    } catch (error: any) {
      console.error('Failed to create API terminal tab:', error);
      if (window.electronAPI) {
        window.electronAPI.sendToMain('api:terminalTabCreated', {
          error: error.message,
          success: false
        });
      }
    }
  };

  const handleRequestTabsData = () => {
    try {
      console.log('UI: Gathering tabs data for API');

      // Get tabs from Redux store
      const store = (window as any).__REDUX_STORE__;
      if (!store) {
        throw new Error('Redux store not found');
      }

      const state = store.getState();
      const currentTabs = state.tabs.tabs || [];
      const tabPanes = (window as any).tabPanes || {};

      console.log('Found tabs:', currentTabs.length, 'Tab panes:', Object.keys(tabPanes).length);

      // Function to extract pane info
      const extractPaneInfo = (node: any): any => {
        if (!node) return null;

        if (node.type === 'terminal') {
          return {
            id: node.id,
            type: 'terminal',
            terminalId: node.terminalId,
            name: node.name || 'Terminal'
          };
        } else if (node.type === 'split') {
          return {
            id: node.id,
            type: 'split',
            direction: node.direction,
            children: node.children ? node.children.map(extractPaneInfo) : []
          };
        }
        return null;
      };

      // Build tab information with pane structure
      const tabsData = currentTabs.map((tab: any) => {
        const paneTree = tabPanes[tab.id];

        return {
          id: tab.id,
          title: tab.title,
          shellType: tab.shellType,
          isActive: tab.isActive,
          panes: paneTree ? extractPaneInfo(paneTree) : null
        };
      });

      console.log('Sending tabs data:', tabsData);

      // Send the data back to main process
      if (window.electronAPI) {
        window.electronAPI.sendToMain('ui:tabsData', tabsData);
      }
    } catch (error: any) {
      console.error('Failed to gather tabs data:', error);
      if (window.electronAPI) {
        window.electronAPI.sendToMain('ui:tabsData', { error: error.message });
      }
    }
  };

  return (
    <div className="app">
      <PaneDragProvider>
        <TitleBar />
        <div className="app-body">
          <TerminalContainer />
        </div>
      </PaneDragProvider>
      <LayoutManager />
      <GlobalDialog />
      <ToastContainer />
      {/* App-level incoming-pairing consent dialog — reachable even when Settings
          is closed (the tray/background scenario peering targets). */}
      <GlobalPeerRequests />

      {/* First-run EULA acceptance gate (renders only until accepted). */}
      <EulaAcceptModal />

      <ConfirmDialog
        isOpen={showCloseConfirm}
        title={isLastWindow ? 'Quit Auto Terminal' : 'Close Window'}
        message={isLastWindow
          ? 'Are you sure you want to quit? All open terminals and running processes will be terminated.'
          : 'Close this window? Its terminals and running processes will be terminated. Other windows stay open.'}
        onConfirm={async () => {
          setShowCloseConfirm(false);
          // Persist state before this window closes (or the app exits).
          // Unlike `beforeunload` (which cannot await), this is a plain onClick
          // handler, so it can safely await the cwd refresh before saving —
          // capturing fresh directories instead of relying on the last 30s
          // autosave tick.
          //
          // BOUNDED, though: the dialog is already gone by this point, so the
          // user is staring at an app that has visibly accepted "Quit" while we
          // wait on a process scan. Past this budget we save what we have — a
          // stale directory is a far better outcome than a quit that looks hung.
          await saveStateWithCwds(500);
          // Rust decides: destroy just this window, or exit if it's the last one.
          window.electronAPI?.confirmCloseApp?.();
        }}
        onCancel={() => setShowCloseConfirm(false)}
        destructive
        confirmText={isLastWindow ? 'Quit' : 'Close Window'}
        confirmMnemonic={isLastWindow ? 'Q' : 'C'}
        cancelText="Cancel"
        cancelMnemonic="A"
      />
    </div>
  );
};

export default App;