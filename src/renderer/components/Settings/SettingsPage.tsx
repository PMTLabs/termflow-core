import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../store';
import { useSurfaceZoom, useZoomGestures } from '../../hooks/useSurfaceZoom';
import { setFontSize, updateShellProfile, setDefaultProfile, setCloseTabOnProcessExit, setSmartCtrlC, setEnhancedKeyboard, setCommandSuggestions, setDefaultEditor, setTabSizingMode, setFixedTabWidth, setActivateTabOnApiCreate, setColorSchema, setAgentColorScheme, removeAgentColorScheme, setAgentColorSchemes, setCustomKeybindings, setCustomKeybinding, resetCustomKeybinding, setLaunchAtLogin, setNotifySoundEnabled, setNotifyToastEnabled, setNotifyOsEnabled, setFileManagerIntegration } from '../../store/slices/settingsSlice';
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart';
import { SHORTCUT_ACTIONS, findConflict } from '../../services/shortcutActions';
import { COLOR_SCHEMAS } from '../../store/colorSchemas';
import { addToast } from '../../store/slices/uiSlice';
import { ShellProfile } from '../../store/slices/settingsSlice';
import { NetworkConfig, NetworkInterfaceInfo } from '../../types/electron';
import { McpConnectModal } from './McpConnectModal';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import { UnsavedChangesDialog } from '../UI/UnsavedChangesDialog';
import { snapshotCategory, isCategoryDirty, TrackedCategory, CategorySnapshot } from '../../services/settingsDirty';
import { registerSettingsGuard, clearSettingsGuard } from '../../services/settingsNavGuard';
import { consumePendingSettingsCategory } from '../../services/openSettings';
import { SplitButton } from '../UI/SplitButton';
import { connectionStatus } from './connectionStatus';
import { PeersPanel } from './PeersPanel';
import { AboutLegalPanel } from './AboutLegalPanel';
import './SettingsPage.css';

const IS_DEV = process.env.NODE_ENV === 'development';

interface ConnectionInfo {
    name: string;
    url: string;
    healthUrl: string | null;
    description: string;
    healthy: boolean | null; // null = checking
    activeClients?: number;
    conflict?: boolean; // P0b: reachable but owned by another instance
}

// Default ports match this build's instance (dev = 42051/42052, prod = 42031/42032);
// the real ports are loaded from the backend on mount. These defaults only feed the
// browser-dev health fallback before that resolves.
const DEFAULT_API_PORT = IS_DEV ? 42051 : 42031;
const DEFAULT_MCP_PORT = IS_DEV ? 42052 : 42032;

const defaultConnections: ConnectionInfo[] = [
    {
        name: 'API Server',
        url: `http://localhost:${DEFAULT_API_PORT}`,
        healthUrl: `http://localhost:${DEFAULT_API_PORT}/health`,
        description: 'REST API for terminal management',
        healthy: null
    },
    {
        name: 'MCP Server',
        url: `http://localhost:${DEFAULT_MCP_PORT}/mcp`,
        healthUrl: `http://localhost:${DEFAULT_MCP_PORT}/health`,
        description: 'Model Context Protocol for AI agents',
        healthy: null
    },
    {
        name: 'WebSocket',
        url: `ws://localhost:${DEFAULT_API_PORT}/ws`,
        healthUrl: null, // WebSocket doesn't have health endpoint
        description: 'Real-time terminal output streaming',
        healthy: null
    }
];

interface SettingsPageProps {
    /** Whether the settings tab is the visible one. Inactive tabs stay mounted but
        hidden, so the nav guard's prompt can only be answered while active. */
    isActive?: boolean;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ isActive = true }) => {
    const dispatch = useDispatch<AppDispatch>();
    const settings = useSelector((state: RootState) => state.settings);

    // Local state for font size input to allow typing
    const [localFontSize, setLocalFontSize] = useState<string>(settings.fontSize.toString());
    const [localFixedTabWidth, setLocalFixedTabWidth] = useState<string>(settings.fixedTabWidth.toString());

    // Shortcuts section: which action (if any) is currently capturing a
    // keypress, and any error from the last capture attempt. `error` covers
    // three distinct cases (see handleRecordKeyDown): a conflict with another
    // action, a conflict with a fixed/reserved combo, or an invalid combo
    // (no modifier and not a function key, or the Space key).
    const [recordingActionId, setRecordingActionId] = useState<string | null>(null);
    const [recordError, setRecordError] = useState<{ actionId: string; message: string } | null>(null);

    // Connection info state
    const [connections, setConnections] = useState<ConnectionInfo[]>(defaultConnections);
    const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

    // Network settings state (ports, expose-on-network, access token)
    const [netCfg, setNetCfg] = useState<NetworkConfig | null>(null);
    const [apiPort, setApiPort] = useState<number>(IS_DEV ? 42051 : 42031);
    const [mcpPort, setMcpPort] = useState<number>(IS_DEV ? 42052 : 42032);
    const [expose, setExpose] = useState<boolean>(false);
    const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>([]);
    const [revealToken, setRevealToken] = useState(false);
    const [showMcpModal, setShowMcpModal] = useState(false);
    const [showRotateConfirm, setShowRotateConfirm] = useState(false);
    const [isApplying, setIsApplying] = useState(false);

    // Active sidebar category (Windows Terminal-style two-pane layout)
    type SettingsCategory = 'appearance' | 'terminal' | 'notifications' | 'startup' | 'profiles' | 'shortcuts' | 'connections' | 'peers' | 'about';
    const [activeCategory, setActiveCategory] = useState<SettingsCategory>('appearance');

    // Launch-at-login is OS-owned and externally mutable (Startup Apps / Login Items /
    // another instance). A monotonic generation guards against stale async readbacks:
    // any newer enable/disable/refresh bumps the gen, so an older isEnabled() response
    // (e.g. a slow mount read racing a user toggle) is discarded instead of clobbering
    // the newer state. `autostartBusy` disables the toggle while an op is in flight.
    const autostartGenRef = useRef(0);
    const [autostartBusy, setAutostartBusy] = useState(false);
    const refreshLaunchAtLogin = useCallback(async () => {
        const gen = ++autostartGenRef.current;
        try {
            const v = await isAutostartEnabled();
            if (gen === autostartGenRef.current) dispatch(setLaunchAtLogin(v));
        } catch {
            /* plugin unavailable (browser host) → leave the current state */
        }
    }, [dispatch]);

    // Same stale-readback guard for the "Open in TermFlow" file-manager integration.
    const fmiGenRef = useRef(0);
    const [fmiBusy, setFmiBusy] = useState(false);
    const refreshFileManagerIntegration = useCallback(async () => {
        const gen = ++fmiGenRef.current;
        try {
            const v = (await window.electronAPI?.isFileManagerIntegrationInstalled?.()) ?? false;
            if (gen === fmiGenRef.current) dispatch(setFileManagerIntegration(v));
        } catch {
            /* command unavailable (browser host) → leave the current state */
        }
    }, [dispatch]);
    const onToggleFileManagerIntegration = async (checked: boolean) => {
        const gen = ++fmiGenRef.current;
        setFmiBusy(true);
        try {
            try {
                if (checked) await window.electronAPI?.installFileManagerIntegration?.();
                else await window.electronAPI?.uninstallFileManagerIntegration?.();
            } catch (err) {
                console.error('file-manager integration toggle failed', err);
                dispatch(addToast({ message: "Could not update the 'Open in TermFlow' menu entry.", type: 'error' }));
            }
            try {
                const v = (await window.electronAPI?.isFileManagerIntegrationInstalled?.()) ?? checked;
                if (gen === fmiGenRef.current) dispatch(setFileManagerIntegration(v));
            } catch { /* keep prior */ }
        } finally {
            setFmiBusy(false);
        }
    };

    // ---- Dirty-check (Approach 1: apply-live + revert-on-discard) ----
    // Connections is excluded — it owns its own "Save & apply (restart)" flow.
    const CATEGORY_LABELS: Record<SettingsCategory, string> = {
        appearance: 'Appearance', terminal: 'Terminal Behavior',
        notifications: 'Notifications', startup: 'Startup & Integration',
        profiles: 'Shell Profiles', shortcuts: 'Shortcuts', connections: 'Connections',
        peers: 'Peers', about: 'About & Legal',
    };
    // Peers/Connections own their own live flow; About & Legal is read-only; Startup
    // and Notifications apply live (persisted on change) — none are dirty-tracked.
    const isTracked = (c: SettingsCategory): c is TrackedCategory =>
        c !== 'connections' && c !== 'peers' && c !== 'about' && c !== 'startup' && c !== 'notifications';

    // Baseline snapshot of the ACTIVE category's tracked fields. Only one category
    // can be dirty at a time (every leave is resolved before switching).
    const [baseline, setBaseline] = useState<CategorySnapshot | null>(() =>
        isTracked(activeCategory) ? snapshotCategory(activeCategory, settings) : null,
    );
    const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
    const [showUnsaved, setShowUnsaved] = useState(false);

    const isDirty = useCallback((): boolean => {
        if (!isTracked(activeCategory) || !baseline) return false;
        return isCategoryDirty(activeCategory, settings, baseline);
    }, [activeCategory, settings, baseline]);

    // Re-dispatch baseline values to undo live-applied edits (the reducers persist).
    const revertToBaseline = useCallback(() => {
        if (!baseline) return;
        if (baseline.kind === 'appearance') {
            dispatch(setFontSize(baseline.fontSize));
            dispatch(setTabSizingMode(baseline.tabSizingMode as 'shrink' | 'scroll' | 'fixed'));
            dispatch(setFixedTabWidth(baseline.fixedTabWidth));
            dispatch(setColorSchema(baseline.colorSchemaId));
            dispatch(setAgentColorSchemes(Object.fromEntries(baseline.agentColorSchemes)));
        } else if (baseline.kind === 'terminal') {
            dispatch(setCloseTabOnProcessExit(baseline.closeTabOnProcessExit));
            dispatch(setSmartCtrlC(baseline.smartCtrlC));
            dispatch(setEnhancedKeyboard(baseline.enhancedKeyboard));
            dispatch(setCommandSuggestions(baseline.commandSuggestions));
            dispatch(setActivateTabOnApiCreate(baseline.activateTabOnApiCreate));
            dispatch(setDefaultEditor(baseline.defaultEditor));
        } else if (baseline.kind === 'shortcuts') {
            dispatch(setCustomKeybindings(Object.fromEntries(baseline.customKeybindings)));
        } else if (baseline.kind === 'profiles') {
            dispatch(setDefaultProfile(baseline.defaultProfile));
            baseline.cwds.forEach(({ id, cwd }) =>
                dispatch(updateShellProfile({ id, changes: { cwd } })));
        }
    }, [baseline, dispatch]);

    const resnapshot = useCallback((cat: SettingsCategory) => {
        setBaseline(isTracked(cat) ? snapshotCategory(cat, settings) : null);
    }, [settings]);

    // Guard the internal category switch.
    const requestCategoryChange = useCallback((target: SettingsCategory) => {
        if (target === activeCategory) return;
        const go = () => { setActiveCategory(target); resnapshot(target); };
        if (isDirty()) {
            setPendingAction(() => go);
            setShowUnsaved(true);
        } else {
            go();
        }
    }, [activeCategory, isDirty, resnapshot]);

    // Deep-link navigation (Plan 010): the tray "Peers…" item opens Settings and
    // asks us to jump to a section. A freshly-opened tab reads the pending category
    // on mount; an already-open tab receives a DOM event. Ignore unknown ids.
    useEffect(() => {
        const isCategory = (c: string): c is SettingsCategory =>
            c === 'appearance' || c === 'terminal' || c === 'notifications' || c === 'startup' ||
            c === 'profiles' || c === 'shortcuts' || c === 'connections' || c === 'peers' || c === 'about';
        const pending = consumePendingSettingsCategory();
        if (pending && isCategory(pending)) {
            requestCategoryChange(pending);
        }
        const handler = (e: Event) => {
            const cat = (e as CustomEvent).detail;
            if (typeof cat === 'string' && isCategory(cat)) {
                requestCategoryChange(cat);
            }
        };
        window.addEventListener('settings:goto-category', handler);
        return () => window.removeEventListener('settings:goto-category', handler);
    }, [requestCategoryChange]);

    // Hydrate the launch-at-login toggle from the actual OS registration (the plugin is
    // the source of truth). Runs on mount AND every time the user enters the Startup
    // category — the Settings tab is never unmounted (only hidden via CSS), so a single
    // mount-only read would miss external changes made while the tab stayed open.
    useEffect(() => {
        if (activeCategory === 'startup') {
            refreshLaunchAtLogin();
            refreshFileManagerIntegration();
        }
    }, [activeCategory, refreshLaunchAtLogin, refreshFileManagerIntegration]);

    const handleUnsavedSave = useCallback(() => {
        setShowUnsaved(false);
        // Changes already persisted live; just clear dirty for the current category.
        setBaseline(isTracked(activeCategory) ? snapshotCategory(activeCategory, settings) : null);
        const act = pendingAction; setPendingAction(null); act?.();
    }, [activeCategory, settings, pendingAction]);

    const handleUnsavedDiscard = useCallback(() => {
        setShowUnsaved(false);
        revertToBaseline();
        const act = pendingAction; setPendingAction(null); act?.();
    }, [revertToBaseline, pendingAction]);

    const handleUnsavedCancel = useCallback(() => {
        setShowUnsaved(false);
        setPendingAction(null);
    }, []);

    // Register a navigation guard so the tab layer can defer leaving the settings
    // tab while it's dirty. A ref holds the latest logic so the stable registered
    // callback always sees current state.
    const guardImplRef = useRef<(proceed: () => void) => boolean>(() => false);
    guardImplRef.current = (proceed: () => void) => {
        if (!isDirty()) return false;
        setPendingAction(() => proceed);
        setShowUnsaved(true);
        return true;
    };
    // Only armed while this tab is visible: the guard answers by rendering its
    // Save/Discard prompt *in this tab*, so a guard armed from a hidden tab blocks
    // navigation on a prompt the user can neither see nor click. Entry points that
    // don't consult the guard (the "+" new-tab button) can leave a dirty settings
    // tab hidden, which used to deadlock tab switching entirely.
    useEffect(() => {
        if (!isActive) {
            // Drop any prompt raised for a navigation we've since left behind.
            setShowUnsaved(false);
            setPendingAction(null);
            return;
        }
        registerSettingsGuard((proceed) => guardImplRef.current(proceed));
        return () => clearSettingsGuard();
    }, [isActive]);

    // The baseline means "state as of entering the page", but this tab is never
    // unmounted (only hidden), so a mount-time snapshot goes stale while you're
    // away. This screen is not the only writer of the fields it tracks — the
    // terminal's right-click "color scheme for agent" menu dispatches
    // setAgentColorScheme from outside it — and such an external write drifted
    // settings away from the stale baseline, leaving an untouched page dirty and
    // prompting to save changes the user never made here. So re-snapshot on entry,
    // the same thing an internal category switch already does.
    //
    // Exception: edits left unsaved on the way out (the "+" new-tab button skips
    // the guard) must stay revertable, so their baseline is preserved.
    const dirtyOnLeaveRef = useRef(false);
    useEffect(() => {
        if (!isActive) {
            dirtyOnLeaveRef.current = isDirty();
            return;
        }
        if (!dirtyOnLeaveRef.current) resnapshot(activeCategory);
        // Deliberately keyed on isActive alone: this is an entry/exit edge, not a
        // reaction to settings changing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActive]);

    // This screen has its own zoom (Ctrl/Cmd +/-/0 + modifier+wheel), independent
    // of the terminals and persisted across restarts under the 'settingsZoom' key.
    const layoutRef = useRef<HTMLDivElement>(null);
    const zoomControls = useSurfaceZoom('settings', { persist: true, configKey: 'settingsZoom' });
    useZoomGestures(layoutRef, zoomControls);
    const { zoom, reset: resetZoom } = zoomControls;

    // Focus the screen on mount so keyboard zoom works without first clicking a field.
    useEffect(() => {
        layoutRef.current?.focus();
    }, []);

    // Sync local state when redux state changes (e.g. from keyboard shortcuts)
    useEffect(() => {
        setLocalFontSize(settings.fontSize.toString());
    }, [settings.fontSize]);

    // Check health of connection endpoints using Tauri IPC
    const checkConnectionHealth = useCallback(async () => {
        try {
            if (window.electronAPI?.checkConnectionHealth) {
                // Use Tauri IPC - fetch is blocked in Tauri webview
                const results = await window.electronAPI.checkConnectionHealth();

                // Map results to ConnectionInfo format
                const updatedConnections = defaultConnections.map(conn => {
                    const result = results.find(r => r.name === conn.name);
                    return {
                        ...conn,
                        healthy: result?.healthy ?? false,
                        activeClients: result?.active_clients,
                        conflict: result?.conflict ?? false
                    };
                });
                setConnections(updatedConnections);
            } else {
                // Fallback for browser dev mode - try fetch
                const updatedConnections = await Promise.all(
                    defaultConnections.map(async (conn) => {
                        if (!conn.healthUrl) {
                            return { ...conn, healthy: null };
                        }

                        try {
                            const controller = new AbortController();
                            const timeoutId = setTimeout(() => controller.abort(), 2000);

                            const response = await fetch(conn.healthUrl, {
                                signal: controller.signal
                            });

                            clearTimeout(timeoutId);
                            return { ...conn, healthy: response.ok };
                        } catch {
                            return { ...conn, healthy: false };
                        }
                    })
                );

                // For WebSocket, inherit API Server status
                const apiStatus = updatedConnections.find(c => c.name === 'API Server')?.healthy;
                const finalConnections = updatedConnections.map(conn => {
                    if (conn.name === 'WebSocket') {
                        return { ...conn, healthy: apiStatus ?? null };
                    }
                    return conn;
                });

                setConnections(finalConnections);
            }
        } catch (err) {
            console.error('Health check failed:', err);
            setConnections(defaultConnections.map(c => ({ ...c, healthy: false })));
        }
    }, []);

    // Check health on mount and periodically
    useEffect(() => {
        checkConnectionHealth();
        const interval = setInterval(checkConnectionHealth, 30000); // Check every 30 seconds
        return () => clearInterval(interval);
    }, [checkConnectionHealth]);

    // Copy URL to clipboard
    const copyToClipboard = async (url: string) => {
        try {
            await navigator.clipboard.writeText(url);
            setCopiedUrl(url);
            setTimeout(() => setCopiedUrl(null), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    // Load network config + interfaces on mount.
    useEffect(() => {
        (async () => {
            try {
                const cfg = await window.electronAPI?.getNetworkConfig?.();
                if (cfg) {
                    setNetCfg(cfg);
                    setApiPort(cfg.apiPort);
                    setMcpPort(cfg.mcpPort);
                    setExpose(cfg.exposeOnNetwork);
                }
                const ifaces = await window.electronAPI?.listNetworkInterfaces?.();
                if (ifaces) setInterfaces(ifaces);
            } catch (err) {
                console.error('Failed to load network config:', err);
            }
        })();
    }, []);

    // Persist + hot-restart servers with the edited ports / expose flag.
    const handleApplyNetwork = async () => {
        if (!window.electronAPI?.setNetworkConfig) return;
        setIsApplying(true);
        try {
            const cfg = await window.electronAPI.setNetworkConfig(apiPort, mcpPort, expose);
            setNetCfg(cfg);
            // Keep the renderer's bearer token current so its own (loopback) calls
            // stay authorized once the network token is being enforced.
            if (cfg.authToken) localStorage.setItem('api_token', cfg.authToken);
            dispatch(addToast({ message: 'Network settings applied — servers restarted.', type: 'success' }));
            setTimeout(() => { checkConnectionHealth(); }, 700);
        } catch (err) {
            dispatch(addToast({ message: `Failed to apply: ${err}`, type: 'error' }));
        } finally {
            setIsApplying(false);
        }
    };

    const TARGET_LABEL: Record<string, string> = { all: 'Servers', api: 'API server', mcp: 'MCP server' };

    // Stop selected server(s). The window status dot updates via the health poll;
    // we also nudge it immediately with a custom event.
    const handleStopServers = async (target: string) => {
        if (!window.electronAPI?.stopServers) return;
        setIsApplying(true);
        try {
            await window.electronAPI.stopServers(target as 'all' | 'api' | 'mcp');
            dispatch(addToast({ message: `${TARGET_LABEL[target] ?? 'Servers'} stopped.`, type: 'success' }));
            window.dispatchEvent(new CustomEvent('ui:serverStatusRefresh'));
            setTimeout(() => { checkConnectionHealth(); }, 300);
        } catch (err) {
            dispatch(addToast({ message: `Failed to stop: ${err}`, type: 'error' }));
        } finally {
            setIsApplying(false);
        }
    };

    // (Re)start selected server(s) from the current config.
    const handleStartServers = async (target: string) => {
        if (!window.electronAPI?.startServers) return;
        setIsApplying(true);
        try {
            await window.electronAPI.startServers(target as 'all' | 'api' | 'mcp');
            dispatch(addToast({ message: `${TARGET_LABEL[target] ?? 'Servers'} started.`, type: 'success' }));
            window.dispatchEvent(new CustomEvent('ui:serverStatusRefresh'));
            setTimeout(() => { checkConnectionHealth(); }, 800);
        } catch (err) {
            dispatch(addToast({ message: `Failed to start: ${err}`, type: 'error' }));
        } finally {
            setIsApplying(false);
        }
    };

    // Regenerate the access token (invalidates the old one) and restart servers.
    const handleRotateToken = async () => {
        if (!window.electronAPI?.rotateAuthToken) return;
        try {
            const cfg = await window.electronAPI.rotateAuthToken();
            setNetCfg(cfg);
            setRevealToken(true);
            // Update the renderer's bearer token to the freshly rotated one.
            if (cfg.authToken) localStorage.setItem('api_token', cfg.authToken);
            dispatch(addToast({ message: 'Access token rotated.', type: 'success' }));
        } catch (err) {
            dispatch(addToast({ message: `Failed to rotate token: ${err}`, type: 'error' }));
        }
    };

    const token = netCfg?.authToken ?? '';
    const maskedToken = token ? `${token.slice(0, 8)}${'•'.repeat(Math.max(0, token.length - 8))}` : '';
    const healthOf = (name: string) => connections.find((c) => c.name === name);

    const renderCopy = (value: string, label?: string) => (
        <button
            className={`copy-btn ${copiedUrl === value ? 'copied' : ''}`}
            onClick={() => copyToClipboard(value)}
            title={label ? `Copy ${label} URL` : 'Copy to clipboard'}
        >
            {copiedUrl === value ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
            )}
            {label && <span className="copy-btn-label">{label}</span>}
        </button>
    );

    const statusDot = (name: string) => {
        const status = connectionStatus(healthOf(name));
        const title =
            status === 'checking' ? 'Checking…'
            : status === 'healthy' ? 'Connected'
            : status === 'conflict' ? 'Port in use by another instance'
            : 'Offline';
        return <span className={`status-indicator ${status}`} title={title} />;
    };

    // P0b: when a port is owned by another instance, prompt the user to pick a new one
    // instead of showing a misleading status. Shown under the affected connection card.
    const conflictNote = (name: string) =>
        connectionStatus(healthOf(name)) === 'conflict' ? (
            <div className="connection-conflict" role="alert">
                ⚠ Port {name === 'MCP Server' ? mcpPort : apiPort} is already in use by another
                instance. Choose a different port and click Save &amp; apply.
            </div>
        ) : null;

    const handleFontSizeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setLocalFontSize(val); // Allow any input locally

        const size = parseInt(val);
        if (!isNaN(size) && size >= 8 && size <= 72) {
            dispatch(setFontSize(size));
        }
    };

    const handleFixedTabWidthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setLocalFixedTabWidth(val); // Allow any input locally

        const width = parseInt(val);
        if (!isNaN(width) && width >= 60 && width <= 300) {
            dispatch(setFixedTabWidth(width));
        }
    };

    const handleProfileCwdChange = (profileId: string, cwd: string) => {
        dispatch(updateShellProfile({
            id: profileId,
            changes: { cwd }
        }));
    };

    const handleSetDefault = (profileId: string) => {
        dispatch(setDefaultProfile(profileId));
    };

    const handleBrowseEditor = async () => {
        const picked = await window.electronAPI?.pickExecutablePath?.();
        if (picked) {
            dispatch(setDefaultEditor(picked));
        }
    };

    const cancelRecording = useCallback(() => {
        setRecordingActionId(null);
        setRecordError(null);
    }, []);

    const handleRecordKeyDown = useCallback((actionId: string, e: React.KeyboardEvent) => {
        // Bare Tab/Shift+Tab must bubble natively (no preventDefault/stopPropagation)
        // so keyboard-only users can always leave the recording input via normal
        // focus navigation — WCAG 2.1.2. Moving focus away triggers the input's
        // onBlur, which already cancels recording. Ctrl+Tab/Cmd+Tab are a
        // different, unambiguous combo and remain capturable below.
        if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        if (e.key === 'Escape') {
            cancelRecording();
            return;
        }

        const isModifierOnly = ['Control', 'Meta', 'Alt', 'Shift'].includes(e.key);
        if (isModifierOnly) return; // keep waiting for a real key

        if (e.key === ' ') {
            // The Space key cannot round-trip through a '+'-delimited combo
            // string (whitespace-stripping during normalization loses it
            // entirely) — reject outright rather than special-casing
            // space-as-key into the shared canonicalizeCombo parser for one
            // rarely-wanted binding.
            setRecordError({ actionId, message: "Space can't be used in a shortcut." });
            return; // stay in recording state so the user can retry
        }

        const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(e.key);
        const hasModifier = e.ctrlKey || e.metaKey || e.altKey || e.shiftKey;

        if (!hasModifier && !isFunctionKey) {
            setRecordError({ actionId, message: 'Must include Ctrl/Cmd, Alt, or Shift, or be a function key (F1-F24).' });
            return; // stay in recording state so the user can retry
        }

        const parts: string[] = [];
        if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        // '+' is also the combo-string delimiter, so the literal Plus key must be
        // captured as the word "Plus" rather than the raw character — otherwise
        // "Ctrl++" is ambiguous to canonicalizeCombo (the trailing '+' is
        // consumed as an empty split segment and the key identity is lost).
        // "Plus" round-trips correctly with no changes needed to the parser,
        // the same way "Tab" or "Enter" already do.
        const mainKey = e.key === '+' ? 'Plus' : isFunctionKey ? e.key : e.key.length === 1 ? e.key.toUpperCase() : e.key;
        parts.push(mainKey);
        const combo = parts.join('+');

        const conflict = findConflict(actionId, combo, settings.customKeybindings);
        if (conflict) {
            const message = conflict.type === 'reserved'
                ? "This combination is reserved and can't be reassigned."
                : `Already assigned to "${conflict.label}" — choose another combo.`;
            setRecordError({ actionId, message });
            return; // stay in recording state so the user can retry
        }

        dispatch(setCustomKeybinding({ actionId, combo }));
        setRecordingActionId(null);
        setRecordError(null);
    }, [dispatch, settings.customKeybindings, cancelRecording]);

    const handleSaveSettings = async () => {
        if (window.electronAPI) {
            // Save shell profiles overrides to config
            // We strip out system-specific fields if needed, but saving full object is easier for now
            // Or better, save only overrides. The backend get_shell_profiles returns system ones.
            // But here we rely on the Redux state being the "source of truth" for user edits.
            // Let's save the full shellProfiles list to 'shellProfiles' key in config.
            await window.electronAPI.setConfigValue('shellProfiles', settings.shellProfiles);
            // The Terminal Behavior settings persist on change via their reducers, but
            // also write them here so the Save button is authoritative for the current
            // Redux state (e.g. the "Default editor" text field the user just edited).
            await window.electronAPI.setConfigValue('defaultEditor', settings.defaultEditor);
            await window.electronAPI.setConfigValue('activateTabOnApiCreate', settings.activateTabOnApiCreate);
            dispatch(addToast({
                message: 'Settings saved successfully!',
                type: 'success'
            }));
            // Explicit Save also clears the dirty state for the active category.
            setBaseline(isTracked(activeCategory) ? snapshotCategory(activeCategory, settings) : null);
        }
    };

    const categories: { id: SettingsCategory; label: string; icon: React.ReactNode }[] = [
        {
            id: 'appearance',
            label: 'Appearance',
            icon: (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="13.5" cy="6.5" r=".5" /><circle cx="17.5" cy="10.5" r=".5" /><circle cx="8.5" cy="7.5" r=".5" /><circle cx="6.5" cy="12.5" r=".5" />
                    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z" />
                </svg>
            ),
        },
        {
            id: 'terminal',
            label: 'Terminal Behavior',
            icon: (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="18" rx="2" /><path d="m6 8 4 4-4 4" /><path d="M14 16h4" />
                </svg>
            ),
        },
        {
            id: 'notifications',
            label: 'Notifications',
            icon: (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                </svg>
            ),
        },
        {
            id: 'startup',
            label: 'Startup & Integration',
            icon: (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
                </svg>
            ),
        },
        {
            id: 'profiles',
            label: 'Shell Profiles',
            icon: (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 13h6" /><path d="M9 17h3" />
                </svg>
            ),
        },
        {
            id: 'shortcuts',
            label: 'Shortcuts',
            icon: (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12" />
                </svg>
            ),
        },
        {
            id: 'connections',
            label: 'Connections',
            icon: (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 0 10h-2" /><line x1="8" y1="12" x2="16" y2="12" />
                </svg>
            ),
        },
        {
            id: 'peers',
            label: 'Peers',
            icon: (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
            ),
        },
        {
            id: 'about',
            label: 'About & Legal',
            icon: (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
            ),
        },
    ];

    const renderAppearance = () => (
        <div className="settings-section">
            <h2>Appearance</h2>
            <div className="setting-item">
                <label className="setting-label">Font Size (px)</label>
                <input
                    type="number"
                    className="setting-input"
                    value={localFontSize}
                    onChange={handleFontSizeChange}
                    min="8"
                    max="72"
                />
            </div>
            <div className="setting-item">
                <div className="setting-fields-row">
                    <div className="setting-field">
                        <label className="setting-label" htmlFor="tab-sizing-mode">
                            When tabs overflow the title bar
                        </label>
                        <select
                            id="tab-sizing-mode"
                            className="setting-input"
                            value={settings.tabSizingMode}
                            onChange={(e) => dispatch(setTabSizingMode(e.target.value as 'shrink' | 'scroll' | 'fixed'))}
                        >
                            <option value="shrink">Shrink tabs to fit (show all)</option>
                            <option value="scroll">Keep tab width, scroll (wheel + arrows)</option>
                            <option value="fixed">Fixed width, scroll (wheel + arrows)</option>
                        </select>
                    </div>
                    {settings.tabSizingMode === 'fixed' && (
                        <div className="setting-field setting-field-narrow">
                            <label className="setting-label" htmlFor="fixed-tab-width">Tab width (px)</label>
                            <input
                                id="fixed-tab-width"
                                type="number"
                                className="setting-input"
                                value={localFixedTabWidth}
                                onChange={handleFixedTabWidthChange}
                                min="60"
                                max="300"
                                step="10"
                            />
                        </div>
                    )}
                </div>
                <span className="help-text">
                    “Shrink tabs to fit” compresses every tab so they all stay visible in the
                    title bar. “Keep tab width, scroll” keeps tabs at a readable width and lets
                    you reach off-screen tabs with the mouse wheel or the ‹ › arrow buttons.
                    “Fixed width, scroll” gives every tab the same configurable width and
                    scrolls the same way once they overflow.
                </span>
            </div>
            <div className="setting-item">
                <label className="setting-label">Color Schema</label>
                <div className="color-schema-grid">
                    {COLOR_SCHEMAS.map((schema) => (
                        <button
                            key={schema.id}
                            type="button"
                            className={`color-schema-card${settings.colorSchemaId === schema.id ? ' active' : ''}`}
                            onClick={() => dispatch(setColorSchema(schema.id))}
                        >
                            <div className="color-schema-swatches">
                                {[
                                    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
                                    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
                                    'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
                                ].map((key) => (
                                    <span
                                        key={key}
                                        className="color-schema-dot"
                                        style={{ background: schema.theme[key] }}
                                    />
                                ))}
                            </div>
                            <span className="color-schema-name">{schema.name}</span>
                        </button>
                    ))}
                </div>
                <span className="help-text">
                    Applies live to every open terminal and to new tabs.
                </span>
            </div>
            <div className="setting-item">
                <label className="setting-label">Agent Color Schemes</label>
                {Object.keys(settings.agentColorSchemes).length === 0 ? (
                    <span className="help-text">
                        Right-click a pane running any agent (codex, agy, claude, …) and choose
                        “Color scheme for …” to give it its own color scheme. Saved agents appear
                        here to edit or remove.
                    </span>
                ) : (
                    <div className="agent-schema-list">
                        {Object.entries(settings.agentColorSchemes).map(([agent, schemaId]) => (
                            <div className="agent-schema-row" key={agent}>
                                <span className="agent-schema-name">{agent}</span>
                                <select
                                    className="agent-schema-select"
                                    value={schemaId}
                                    onChange={(e) => dispatch(setAgentColorScheme({ agent, colorSchemaId: e.target.value }))}
                                >
                                    {COLOR_SCHEMAS.map((s) => (
                                        <option key={s.id} value={s.id}>{s.name}</option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    className="agent-schema-remove"
                                    title={`Remove the ${agent} override`}
                                    aria-label={`Remove the ${agent} override`}
                                    onClick={() => dispatch(removeAgentColorScheme({ agent }))}
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <span className="help-text">
                    Overrides the tab and default schemes while that agent is running in a pane.
                </span>
            </div>
        </div>
    );

    // Toggle launch-at-login through the autostart plugin, then reflect the ACTUAL OS
    // state (never the requested value) so a failed enable/disable can't leave the
    // toggle showing a lie. Guarded by the generation counter so a stale readback can't
    // clobber a newer operation; the checkbox is disabled while an op is in flight.
    const onToggleLaunchAtLogin = async (checked: boolean) => {
        const gen = ++autostartGenRef.current;
        setAutostartBusy(true);
        try {
            try {
                if (checked) await enableAutostart();
                else await disableAutostart();
            } catch (err) {
                console.error('launch-at-login toggle failed', err);
                dispatch(addToast({ message: 'Could not update launch at login.', type: 'error' }));
            }
            try {
                const v = await isAutostartEnabled();
                if (gen === autostartGenRef.current) dispatch(setLaunchAtLogin(v));
            } catch {
                /* keep the prior reflected state if the query fails */
            }
        } finally {
            setAutostartBusy(false);
        }
    };

    const renderNotifications = () => (
        <div className="settings-section">
            <h2>Notifications</h2>
            <p className="help-text" style={{ marginTop: 0 }}>
                Alerts fire only when a background tab shows the activity bell (unseen output),
                never for the tab you're looking at, and only after TermFlow has settled on startup.
            </p>
            <div className="setting-item setting-item-row">
                <label className="setting-label" htmlFor="notify-sound">
                    Play a sound
                </label>
                <input
                    id="notify-sound"
                    type="checkbox"
                    className="setting-checkbox"
                    checked={settings.notifySoundEnabled}
                    onChange={(e) => dispatch(setNotifySoundEnabled(e.target.checked))}
                />
            </div>
            <span className="help-text">A short chime when a background tab has new activity.</span>
            <div className="setting-item setting-item-row">
                <label className="setting-label" htmlFor="notify-toast">
                    Show an in-app notification
                </label>
                <input
                    id="notify-toast"
                    type="checkbox"
                    className="setting-checkbox"
                    checked={settings.notifyToastEnabled}
                    onChange={(e) => dispatch(setNotifyToastEnabled(e.target.checked))}
                />
            </div>
            <span className="help-text">A toast inside TermFlow naming the tab with new activity.</span>
            <div className="setting-item setting-item-row">
                <label className="setting-label" htmlFor="notify-os">
                    Show OS notifications when TermFlow isn't focused
                </label>
                <input
                    id="notify-os"
                    type="checkbox"
                    className="setting-checkbox"
                    checked={settings.notifyOsEnabled}
                    onChange={(e) => dispatch(setNotifyOsEnabled(e.target.checked))}
                />
            </div>
            <span className="help-text">
                A native desktop notification when no TermFlow window is focused. When you
                return to TermFlow (by clicking the notification, the taskbar, or Alt-Tab),
                it switches to the tab that had activity.
            </span>
        </div>
    );

    const renderStartup = () => (
        <div className="settings-section">
            <h2>Startup &amp; Integration</h2>
            <div className="setting-item setting-item-row">
                <label className="setting-label" htmlFor="launch-at-login">
                    Launch TermFlow at login
                </label>
                <input
                    id="launch-at-login"
                    type="checkbox"
                    className="setting-checkbox"
                    checked={settings.launchAtLogin}
                    disabled={autostartBusy}
                    onChange={(e) => onToggleLaunchAtLogin(e.target.checked)}
                />
            </div>
            <span className="help-text">
                When on, TermFlow starts automatically when you sign in to your computer
                (Windows startup, macOS login items, or Linux autostart). This reflects the
                setting currently registered with your operating system.
            </span>
            {IS_DEV && (
                <span className="help-text" style={{ color: 'var(--warning-color, #d98a00)' }}>
                    Dev build: enabling this registers the <em>development</em> executable
                    (target/debug), which later rebuilds will replace — leaving a stale login
                    entry. Test launch-at-login from an installed build.
                </span>
            )}

            <div className="setting-item setting-item-row">
                <label className="setting-label" htmlFor="file-manager-integration">
                    Add "Open in TermFlow" to the file-manager right-click menu
                </label>
                <input
                    id="file-manager-integration"
                    type="checkbox"
                    className="setting-checkbox"
                    checked={settings.fileManagerIntegration}
                    disabled={fmiBusy}
                    onChange={(e) => onToggleFileManagerIntegration(e.target.checked)}
                />
            </div>
            <span className="help-text">
                Right-click a folder in Explorer (Windows), Nautilus/Files or Dolphin (Linux)
                and choose "Open in TermFlow" to open a new window rooted at that folder. On
                macOS this is provided by the app bundle.
            </span>
        </div>
    );

    const renderTerminalBehavior = () => (
        <div className="settings-section">
            <h2>Terminal Behavior</h2>
            <div className="setting-item setting-item-row">
                <label className="setting-label" htmlFor="close-tab-on-exit">
                    Close tab when its process exits
                </label>
                <input
                    id="close-tab-on-exit"
                    type="checkbox"
                    className="setting-checkbox"
                    checked={settings.closeTabOnProcessExit}
                    onChange={(e) => dispatch(setCloseTabOnProcessExit(e.target.checked))}
                />
            </div>
            <span className="help-text">
                When off (default), a tab is kept open and marked “exited” after its
                process ends (Ctrl-D, crash, or an agent/API close), so you can review
                what happened while you were away. When on, the tab closes automatically.
            </span>
            <div className="setting-item setting-item-row">
                <label className="setting-label" htmlFor="smart-ctrl-c">
                    Smart Ctrl+C (copy selection instead of interrupt)
                </label>
                <input
                    id="smart-ctrl-c"
                    type="checkbox"
                    className="setting-checkbox"
                    checked={settings.smartCtrlC}
                    onChange={(e) => dispatch(setSmartCtrlC(e.target.checked))}
                />
            </div>
            <span className="help-text">
                When on (default), pressing Ctrl+C while text is selected copies it (and
                clears the selection) instead of sending SIGINT; with nothing selected,
                Ctrl+C still interrupts. Pressing Ctrl+C three times within two seconds
                always interrupts (so mashing it still kills a runaway process). Windows/Linux
                only — macOS uses Cmd+C. Ctrl+Shift+C always copies regardless.
            </span>
            <div className="setting-item setting-item-row">
                <label className="setting-label" htmlFor="enhanced-keyboard">
                    Enhanced keyboard protocols
                </label>
                <input
                    id="enhanced-keyboard"
                    type="checkbox"
                    className="setting-checkbox"
                    checked={settings.enhancedKeyboard}
                    onChange={(e) => dispatch(setEnhancedKeyboard(e.target.checked))}
                />
            </div>
            <span className="help-text">
                When on (default), send Kitty keyboard protocol / modifyOtherKeys key
                encodings so modern terminal apps (Antigravity, codex, claude) receive
                keys correctly — without it they ignore input that uses these protocols.
                Turn off to use legacy encoding if a specific app misbehaves.
            </span>
            <div className="setting-item setting-item-row">
                <label className="setting-label" htmlFor="command-suggestions">
                    Command history suggestions
                </label>
                <input
                    id="command-suggestions"
                    type="checkbox"
                    className="setting-checkbox"
                    checked={settings.commandSuggestions}
                    onChange={(e) => dispatch(setCommandSuggestions(e.target.checked))}
                />
            </div>
            <span className="help-text">
                When on (default), typing at the shell prompt shows a popup of matching
                previously-run commands (Shift+Enter inserts the highlighted one; ↓ focuses
                the list, then Enter inserts; Esc dismisses). Commands are stored locally
                with obvious secrets redacted. Turn off to disable both the popup and the
                command capture.
            </span>
            <div className="setting-item setting-item-row">
                <label className="setting-label" htmlFor="activate-api-tab">
                    Focus new tabs opened by API / MCP tools
                </label>
                <input
                    id="activate-api-tab"
                    type="checkbox"
                    className="setting-checkbox"
                    checked={settings.activateTabOnApiCreate}
                    onChange={(e) => dispatch(setActivateTabOnApiCreate(e.target.checked))}
                />
            </div>
            <span className="help-text">
                When off (default), a terminal opened by an agent (MCP) or the HTTP API
                appears in the background without pulling you away from the tab you are
                working in. Turn on to have new API/MCP tabs jump to the front. Splits
                opened this way are always added in place and never change focus.
            </span>
            <div className="setting-item setting-item-row">
                <label className="setting-label" htmlFor="default-editor">
                    Default editor for opening file links
                </label>
                <div className="setting-input-group">
                    <input
                        id="default-editor"
                        type="text"
                        className="setting-input"
                        placeholder="e.g. code"
                        value={settings.defaultEditor}
                        onChange={(e) => dispatch(setDefaultEditor(e.target.value))}
                    />
                    <button
                        type="button"
                        className="browse-btn"
                        onClick={handleBrowseEditor}
                    >
                        Browse…
                    </button>
                </div>
            </div>
            <span className="help-text">
                When you modifier+click a file path in the terminal, open it with this editor
                command (it receives the path, plus <code>:line:col</code> when present — e.g.
                VS Code’s <code>code -g</code>). Leave empty to open files with the operating
                system’s default association.
            </span>
        </div>
    );

    const renderProfiles = () => (
        <div className="settings-section">
            <h2>Shell Profiles</h2>
            {settings.shellProfiles.map((profile: ShellProfile) => (
                        <div key={profile.id} className={`profile-card ${settings.defaultProfile === profile.id ? 'active-profile' : ''}`}>
                            <div className="profile-header">
                                <div>
                                    <span className="profile-name">{profile.name}</span>
                                    {settings.defaultProfile === profile.id && (
                                        <span className="default-badge">Default</span>
                                    )}
                                </div>

                                {settings.defaultProfile !== profile.id && (
                                    <button
                                        className="set-default-btn"
                                        onClick={() => handleSetDefault(profile.id)}
                                    >
                                        Set as Default
                                    </button>
                                )}
                            </div>

                            <div className="profile-path">{profile.path}</div>

                            <div className="cwd-input-group" style={{ marginTop: '1rem' }}>
                                <label className="setting-label">Start In Directory</label>
                                <input
                                    type="text"
                                    className="setting-input"
                                    value={profile.cwd || ''}
                                    onChange={(e) => handleProfileCwdChange(profile.id, e.target.value)}
                                    placeholder="Leave empty to use default"
                                />
                                <span className="help-text">Enter absolute path (e.g. C:\Users\Dev)</span>
                            </div>
                        </div>
                    ))}
        </div>
    );

    const renderShortcuts = () => (
        <div className="settings-section">
            <h2>Shortcuts</h2>
            <div className="setting-item">
                <span className="help-text">
                    Click the record button, then press your desired key combination. Press
                    Escape to cancel. Combos already used by another shortcut are rejected.
                </span>
                <div className="shortcut-list">
                    {SHORTCUT_ACTIONS.map((action) => {
                        const combo = settings.customKeybindings[action.id] ?? action.defaultCombo;
                        const isOverridden = action.id in settings.customKeybindings;
                        const isRecording = recordingActionId === action.id;
                        const rowError = recordError?.actionId === action.id ? recordError : null;

                        return (
                            <div className="shortcut-row" key={action.id}>
                                <span className="shortcut-label">{action.label}</span>
                                {isRecording ? (
                                    <input
                                        className="shortcut-recording-input"
                                        value="Press keys…"
                                        readOnly
                                        autoFocus
                                        aria-label={`Press keys to record a new shortcut for ${action.label}`}
                                        onKeyDown={(e) => handleRecordKeyDown(action.id, e)}
                                        onBlur={cancelRecording}
                                    />
                                ) : (
                                    <kbd className="shortcut-combo">{combo}</kbd>
                                )}
                                <button
                                    type="button"
                                    className="shortcut-record-btn"
                                    title={`Record a new shortcut for ${action.label}`}
                                    aria-label={`Record a new shortcut for ${action.label}`}
                                    onClick={() => { setRecordError(null); setRecordingActionId(action.id); }}
                                >
                                    ●
                                </button>
                                <button
                                    type="button"
                                    className="shortcut-reset-btn"
                                    title={`Reset ${action.label} to default (${action.defaultCombo})`}
                                    aria-label={`Reset ${action.label} to default`}
                                    disabled={!isOverridden}
                                    onClick={() => dispatch(resetCustomKeybinding(action.id))}
                                >
                                    ↺
                                </button>
                                {rowError && (
                                    <span className="shortcut-conflict-error">{rowError.message}</span>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );

    const renderConnections = () => {
        // Network fields apply only after "Save & apply (restart)"; flag each field
        // that diverges from the currently-applied config (netCfg) so the user knows
        // a restart is needed. netCfg is null until the config loads.
        const apiPortDirty = netCfg != null && apiPort !== netCfg.apiPort;
        const mcpPortDirty = netCfg != null && mcpPort !== netCfg.mcpPort;
        const exposeDirty = netCfg != null && expose !== netCfg.exposeOnNetwork;
        const applyHint = (
            <span className="apply-hint" role="status">
                ⚠ Unsaved — click “Save &amp; apply (restart)” below to apply.
            </span>
        );
        return (
        <>
                <div className="settings-section">
                    <div className="connections-heading">
                        <h2>Connections</h2>
                        <span className={`instance-badge ${IS_DEV ? 'dev' : 'prod'}`}>
                            ● {IS_DEV ? 'Dev' : 'Production'}
                        </span>
                        <button
                            className="refresh-btn"
                            onClick={checkConnectionHealth}
                            title="Refresh connection status"
                        >
                            Refresh status
                        </button>
                    </div>
                    <p className="section-description">
                        External applications connect to Auto Terminal using these endpoints.
                    </p>

                    {/* API Server (REST + WebSocket share one port) */}
                    <div className="connection-card">
                        <div className="connection-header">
                            <span className="connection-name">API Server <small>(REST + WebSocket)</small></span>
                            <div className="connection-status">{statusDot('API Server')}</div>
                        </div>
                        <div className="connection-url">
                            <code>http://localhost:{apiPort}</code>
                            {renderCopy(`http://localhost:${apiPort}`)}
                        </div>
                        <div className="connection-url subline">
                            <code>ws://localhost:{apiPort}/ws</code>
                            {renderCopy(`ws://localhost:${apiPort}/ws`)}
                        </div>
                        <div className="port-row">
                            <label className="setting-label">Port</label>
                            <input
                                type="number"
                                className="setting-input port-input"
                                value={apiPort}
                                min={1024}
                                max={65535}
                                onChange={(e) => setApiPort(parseInt(e.target.value) || 0)}
                            />
                            {apiPortDirty && applyHint}
                        </div>
                        {conflictNote('API Server')}
                    </div>

                    {/* MCP Server */}
                    <div className="connection-card">
                        <div className="connection-header">
                            <span className="connection-name">MCP Server</span>
                            <div className="connection-status">
                                {(() => {
                                    const c = healthOf('MCP Server');
                                    return c?.activeClients !== undefined && c.activeClients > 0 ? (
                                        <span className="client-count" title="Active clients">
                                            {c.activeClients} client{c.activeClients !== 1 ? 's' : ''}
                                        </span>
                                    ) : null;
                                })()}
                                {statusDot('MCP Server')}
                            </div>
                        </div>
                        <div className="connection-url">
                            <code>http://localhost:{mcpPort}/mcp</code>
                            {renderCopy(`http://localhost:${mcpPort}/mcp`)}
                        </div>
                        <div className="port-row">
                            <label className="setting-label">Port</label>
                            <input
                                type="number"
                                className="setting-input port-input"
                                value={mcpPort}
                                min={1024}
                                max={65535}
                                onChange={(e) => setMcpPort(parseInt(e.target.value) || 0)}
                            />
                            {mcpPortDirty && applyHint}
                        </div>
                        {conflictNote('MCP Server')}
                    </div>

                    {/* Network access */}
                    <div className={`network-section ${expose ? 'exposed' : ''}`}>
                        <div className="network-header">
                            <span className="connection-name">Network access</span>
                            {expose && <span className="exposed-badge">⚠ exposed</span>}
                        </div>
                        <label className="toggle-row">
                            <input
                                type="checkbox"
                                checked={expose}
                                onChange={(e) => setExpose(e.target.checked)}
                            />
                            <span>Expose on local network</span>
                        </label>
                        {exposeDirty && applyHint}

                        {expose ? (
                            <>
                                <p className="help-text">Reachable on these interfaces (bound 0.0.0.0):</p>
                                <div className="nic-list">
                                    {interfaces.map((iface) => (
                                        <div className="nic-row" key={`${iface.name}-${iface.ip}`}>
                                            <span className="nic-name">{iface.name}</span>
                                            <span className="nic-label">{iface.label}</span>
                                            <code className="nic-ip">{iface.ip}</code>
                                            <div className="nic-copy-actions">
                                                {renderCopy(`http://${iface.ip}:${apiPort}`, 'API')}
                                                {renderCopy(`http://${iface.ip}:${mcpPort}/mcp`, 'MCP')}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <label className="setting-label">Access token (app-generated)</label>
                                <div className="token-row">
                                    <code className="token-value">{revealToken ? token : maskedToken}</code>
                                    <button className="icon-btn" title="Reveal" onClick={() => setRevealToken((v) => !v)}>
                                        {revealToken ? '🙈' : '👁'}
                                    </button>
                                    {renderCopy(token)}
                                    <button className="rotate-btn" onClick={() => setShowRotateConfirm(true)}>Rotate</button>
                                </div>
                                <button className="link-btn" onClick={() => setShowMcpModal(true)}>
                                    Connect an AI agent ⓘ
                                </button>
                            </>
                        ) : (
                            <p className="help-text">
                                Bound to 127.0.0.1 (this machine only).{' '}
                                <button className="link-btn inline" onClick={() => setShowMcpModal(true)}>
                                    Connect an AI agent ⓘ
                                </button>
                            </p>
                        )}
                    </div>

                    <div className="connections-actions">
                        <button className="save-btn apply-btn" onClick={handleApplyNetwork} disabled={isApplying}>
                            {isApplying ? 'Applying…' : 'Save & apply (restart)'}
                        </button>
                        <SplitButton
                            label="Stop"
                            variant="stop"
                            disabled={isApplying}
                            defaultKey="all"
                            onSelect={handleStopServers}
                            options={[
                                { key: 'all', label: 'Stop all' },
                                { key: 'api', label: 'Stop API' },
                                { key: 'mcp', label: 'Stop MCP' },
                            ]}
                        />
                        <SplitButton
                            label="Start"
                            variant="start"
                            disabled={isApplying}
                            defaultKey="all"
                            onSelect={handleStartServers}
                            options={[
                                { key: 'all', label: 'Start all' },
                                { key: 'api', label: 'Start API' },
                                { key: 'mcp', label: 'Start MCP' },
                            ]}
                        />
                    </div>
                </div>

                {showMcpModal && (
                    <McpConnectModal
                        interfaces={interfaces}
                        mcpPort={mcpPort}
                        token={token}
                        onClose={() => setShowMcpModal(false)}
                    />
                )}

                <ConfirmDialog
                    isOpen={showRotateConfirm}
                    title="Rotate access token?"
                    message="This generates a new token and immediately invalidates the current one. Any external tools, agents, or MCP clients still using the old token will lose access until you update them with the new token, and the MCP server will briefly restart."
                    onConfirm={() => {
                        setShowRotateConfirm(false);
                        handleRotateToken();
                    }}
                    onCancel={() => setShowRotateConfirm(false)}
                    destructive
                    confirmText="Rotate token"
                    confirmMnemonic="R"
                    cancelText="Cancel"
                    cancelMnemonic="A"
                />
        </>
        );
    };

    const renderActiveCategory = () => {
        switch (activeCategory) {
            case 'appearance': return renderAppearance();
            case 'terminal': return renderTerminalBehavior();
            case 'notifications': return renderNotifications();
            case 'startup': return renderStartup();
            case 'profiles': return renderProfiles();
            case 'shortcuts': return renderShortcuts();
            case 'connections': return renderConnections();
            case 'peers': return <PeersPanel />;
            case 'about': return <AboutLegalPanel />;
            default: return null;
        }
    };

    return (
        // Zoom the WHOLE screen (sidebar + content + footer) so it reads well on
        // high-DPI displays. CSS `zoom` scales the content while the layout still
        // fills its parent (width/height:100% in CSS), so the fixed sidebar and
        // pinned footer keep working and the content reflows — like browser zoom.
        <div
            className="settings-layout"
            ref={layoutRef}
            tabIndex={-1}
            style={{ zoom }}
        >
            <aside className="settings-sidebar">
                <div className="settings-sidebar-title">Settings</div>
                <nav className="settings-nav">
                    {categories.map((cat) => (
                        <button
                            key={cat.id}
                            className={`settings-nav-item ${activeCategory === cat.id ? 'active' : ''}`}
                            onClick={() => requestCategoryChange(cat.id)}
                        >
                            <span className="settings-nav-icon">{cat.icon}</span>
                            <span className="settings-nav-label">{cat.label}</span>
                        </button>
                    ))}
                </nav>
            </aside>

            <div className="settings-content-pane">
                <div className="settings-content-scroll">
                    <div className="settings-content-inner">
                        {renderActiveCategory()}
                    </div>
                </div>
                <div className="settings-footer-bar">
                    {zoom !== 1 && (
                        <button
                            className="zoom-indicator"
                            onClick={resetZoom}
                            title="Reset zoom to 100% (Ctrl/Cmd+0)"
                        >
                            {Math.round(zoom * 100)}%
                        </button>
                    )}
                    <button className="save-btn" onClick={handleSaveSettings}>Save Settings</button>
                </div>
            </div>

            <UnsavedChangesDialog
                isOpen={showUnsaved}
                categoryLabel={CATEGORY_LABELS[activeCategory]}
                onSave={handleUnsavedSave}
                onDiscard={handleUnsavedDiscard}
                onCancel={handleUnsavedCancel}
            />
        </div>
    );
};
