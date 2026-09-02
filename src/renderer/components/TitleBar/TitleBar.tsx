import React, { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { TabManager } from '../Tabs/TabManager';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import { GearIcon } from './GearIcon';
import { openSettingsTab } from '../../services/openSettings';
import { useHiddenAgentTerminals } from '../../hooks/useHiddenAgentTerminals';
import { restoreHiddenAgentTerminals } from '../../services/restoreHiddenAgentTerminals';
import { addToast } from '../../store/slices/uiSlice';
import { useDispatch } from 'react-redux';
import './TitleBar.css';

type ServerStatus = 'checking' | 'online' | 'partial' | 'offline';

export const TitleBar: React.FC = () => {
    const [isMaximized, setIsMaximized] = useState(false);
    const [isMac, setIsMac] = useState(false);
    const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
    const [statusTitle, setStatusTitle] = useState('Checking server status…');
    // P0a: this window's label, and the label of the window currently receiving
    // API/MCP-created terminals. They match ⇒ this is the active target.
    const [myLabel, setMyLabel] = useState('');
    const [activeLabel, setActiveLabel] = useState('');
    // Gate the active-window toggle behind a confirmation popup.
    const [showActivateConfirm, setShowActivateConfirm] = useState(false);
    // Agent CLIs still running with no pane in this workspace showing them —
    // usually stranded by a layout switch, which replaces what is on screen
    // without stopping anything (plan/025 §0.1).
    const hiddenAgents = useHiddenAgentTerminals();
    const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
    const dispatch = useDispatch();

    // Reflect the API + MCP server health as a small dot in the title area.
    // green=both online, amber=one down, red=both down. Polls periodically and
    // re-checks immediately when the Connections tab stops/starts a server.
    useEffect(() => {
        let active = true;
        const check = async () => {
            try {
                const res = await window.electronAPI?.checkConnectionHealth?.();
                if (!active) return;
                if (!res) { setServerStatus('offline'); setStatusTitle('Server status unavailable'); return; }
                const api = res.find(r => r.name === 'API Server')?.healthy ?? false;
                const mcp = res.find(r => r.name === 'MCP Server')?.healthy ?? false;
                const status: ServerStatus = api && mcp ? 'online' : (!api && !mcp ? 'offline' : 'partial');
                setServerStatus(status);
                setStatusTitle(
                    status === 'online' ? 'Servers online (API + MCP)'
                    : status === 'offline' ? 'Servers offline (API + MCP stopped)'
                    : `Partly offline — ${api ? 'MCP' : 'API'} server is stopped`,
                );
            } catch {
                if (active) { setServerStatus('offline'); setStatusTitle('Servers offline'); }
            }
        };
        check();
        const interval = setInterval(check, 15000);
        const onRefresh = () => { check(); };
        window.addEventListener('ui:serverStatusRefresh', onRefresh);
        return () => {
            active = false;
            clearInterval(interval);
            window.removeEventListener('ui:serverStatusRefresh', onRefresh);
        };
    }, []);

    // Track which window is the API/MCP target and keep this indicator in sync as
    // the user toggles it in any window (or as the active window is reassigned when
    // a window closes).
    useEffect(() => {
        let alive = true;
        let unlisten: (() => void) | undefined;
        try { setMyLabel(getCurrentWindow().label); } catch { /* not a tauri window */ }
        window.electronAPI?.getActiveWindow?.()
            .then(l => { if (alive) setActiveLabel(l); })
            .catch(() => {});
        listen('active-window:changed', (e: any) => {
            if (alive) setActiveLabel(String(e.payload ?? ''));
        }).then(fn => {
            // If we already unmounted before listen() resolved, drop the listener now
            // (the cleanup below already ran with unlisten still undefined).
            if (alive) { unlisten = fn; } else { fn(); }
        }).catch(() => {});
        return () => { alive = false; if (unlisten) unlisten(); };
    }, []);

    useEffect(() => {
        setIsMac(navigator.userAgent.toLowerCase().includes('mac'));
        const checkMaximized = async () => {
            try {
                const appWindow = getCurrentWindow();
                const maximized = await appWindow.isMaximized();
                setIsMaximized(maximized);
            } catch (error) {
                console.error('Failed to check maximized state:', error);
            }
        };

        checkMaximized();

        // Listen for window resize events
        const handleResize = async () => {
            await checkMaximized();
        };

        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const handleMinimize = async () => {
        try {
            const appWindow = getCurrentWindow();
            await appWindow.minimize();
        } catch (error) {
            console.error('Failed to minimize window:', error);
        }
    };

    const handleMaximize = async () => {
        try {
            const appWindow = getCurrentWindow();
            await appWindow.toggleMaximize();
            setIsMaximized(!isMaximized);
        } catch (error) {
            console.error('Failed to toggle maximize:', error);
        }
    };

    const handleDoubleClick = async () => {
        try {
            const appWindow = getCurrentWindow();
            const maximized = await appWindow.isMaximized();
            if (maximized) {
                await appWindow.unmaximize();
                setIsMaximized(false);
            } else {
                await appWindow.maximize();
                setIsMaximized(true);
            }
        } catch (error) {
            console.error('Failed to toggle maximize:', error);
        }
    };

    const handleClose = async () => {
        try {
            const appWindow = getCurrentWindow();
            await appWindow.close();
        } catch (error) {
            console.error('Failed to close window:', error);
        }
    };

    const isActiveTarget = !!myLabel && myLabel === activeLabel;

    // P0a: clicking the indicator asks for confirmation before making THIS window the
    // API/MCP terminal target. A no-op when this window is already the target.
    const handleActivateClick = () => {
        if (!myLabel || isActiveTarget) return;
        setShowActivateConfirm(true);
    };

    const confirmActivate = () => {
        setShowActivateConfirm(false);
        window.electronAPI?.setActiveWindow?.(myLabel);
    };

    return (
      <>
        <div
            className={`title-bar ${isMac ? 'is-mac' : ''} ${isMaximized ? 'is-maximized' : ''}`} 
            data-tauri-drag-region 
            onDoubleClick={handleDoubleClick}
        >
            {/* On Mac with titleBarStyle: Overlay, the OS provides native traffic lights.
                We hide our custom ones to avoid double buttons, but keep the space. */}
            {isMac && <div className="mac-native-spacer" />}

            {/* Server health (API + MCP) — a broadcast/signal glyph, deliberately
                NOT a round dot, so it never reads as a twin of the API-target dot
                in the pill beside it. Colour still carries the state. */}
            <svg
                className={`server-status-icon ${serverStatus}`}
                viewBox="0 0 20 20"
                width="15"
                height="15"
                aria-label={statusTitle}
                role="img"
            >
                <title>{statusTitle}</title>
                {/* center mast */}
                <rect x="9.25" y="6.5" width="1.5" height="7" rx="0.75" />
                {/* inner waves */}
                <path d="M7.7 7.4 Q6.3 10 7.7 12.6" />
                <path d="M12.3 7.4 Q13.7 10 12.3 12.6" />
                {/* outer waves */}
                <path d="M5.4 5.4 Q3.1 10 5.4 14.6" />
                <path d="M14.6 5.4 Q16.9 10 14.6 14.6" />
            </svg>

            <button
                type="button"
                className={`active-window-indicator ${isActiveTarget ? 'active' : ''}`}
                title={isActiveTarget
                    ? 'This window receives API/MCP-created terminals. Click another window to move it.'
                    : 'Click to make this window receive API/MCP-created terminals.'}
                aria-pressed={myLabel ? isActiveTarget : undefined}
                onClick={handleActivateClick}
            >
                <span className="awi-dot" aria-hidden="true" />
                <span className="awi-text">API</span>
            </button>

            {/* Hidden running agents. Rendered only when there ARE any: an
                always-present "0" would be noise in a strip the user looks at
                constantly, and the whole point of this control is that its
                appearance is the signal.

                It sits in the title bar rather than the OS window title because
                on Windows and Linux `decorations: false` means there IS no OS
                title bar — `setTitle()` would write a string nothing displays.
                This strip is what "the window title" means in this app. */}
            {hiddenAgents.length > 0 && (
                <button
                    type="button"
                    className="hidden-agents-indicator"
                    title={`${hiddenAgents.length} running ${hiddenAgents.length === 1 ? 'agent is' : 'agents are'} not shown in this layout: ${
                        hiddenAgents.map(h => h.name).join(', ')
                    }. Click to bring ${hiddenAgents.length === 1 ? 'it' : 'them'} back.`}
                    onClick={() => setShowRestoreConfirm(true)}
                >
                    <span className="hai-dot" aria-hidden="true" />
                    <span className="hai-text">{hiddenAgents.length}</span>
                </button>
            )}

            <div className="title-bar-tabs">
                <TabManager />
            </div>
            {/* Draggable gap between the tab/action menu and the window controls,
                so a full tab strip never butts right up against the minimize button —
                the user can always grab here to move the window. */}
            <div className="title-bar-drag-region" data-tauri-drag-region />
            {/* macOS paints its own traffic lights behind `.mac-native-spacer` and renders no
                minimize button at all, so `.window-controls` is skipped entirely there and
                "next to minimize" has no meaning. The gear still belongs in the same screen
                corner, so it is rendered here instead — after the drag region, at the trailing
                edge.

                No drag-region opt-out is needed on either copy. `data-tauri-drag-region` is an
                attribute on the `.title-bar` root and the spacer above; descendants do not
                inherit it, which is exactly how `.server-status-icon` and
                `.active-window-indicator` stay clickable. There is no `no-drag` class in this
                file to copy. */}
            {isMac && (
                <button
                    type="button"
                    className="window-control-btn settings is-mac"
                    onClick={() => openSettingsTab()}
                    aria-label="Settings"
                    title="Settings"
                >
                    <GearIcon />
                </button>
            )}
            {!isMac && (
                <div className="window-controls">
                    <button
                        type="button"
                        className="window-control-btn settings"
                        onClick={() => openSettingsTab()}
                        aria-label="Settings"
                        title="Settings"
                    >
                        <GearIcon />
                    </button>
                    <button
                        className="window-control-btn minimize"
                        onClick={handleMinimize}
                        aria-label="Minimize"
                    >
                        <svg width="12" height="12" viewBox="0 0 12 12">
                            <rect fill="currentColor" width="10" height="1" x="1" y="6" />
                        </svg>
                    </button>
                    <button
                        className="window-control-btn maximize"
                        onClick={handleMaximize}
                        aria-label={isMaximized ? 'Restore' : 'Maximize'}
                    >
                        {isMaximized ? (
                            <svg width="12" height="12" viewBox="0 0 12 12">
                                <rect fill="none" stroke="currentColor" strokeWidth="1" x="2.5" y="3.5" width="7" height="6" />
                                <path fill="currentColor" d="M3.5 3V2h7v7h-1v1h2V1H2.5v2z" />
                            </svg>
                        ) : (
                            <svg width="12" height="12" viewBox="0 0 12 12">
                                <rect fill="none" stroke="currentColor" strokeWidth="1" x="1.5" y="1.5" width="9" height="9" />
                            </svg>
                        )}
                    </button>
                    <button
                        className="window-control-btn close"
                        onClick={handleClose}
                        aria-label="Close"
                    >
                        <svg width="12" height="12" viewBox="0 0 12 12">
                            <path
                                fill="currentColor"
                                d="M6.707 6l3.146-3.146a.5.5 0 00-.707-.708L6 5.293 2.854 2.146a.5.5 0 10-.708.708L5.293 6l-3.147 3.146a.5.5 0 00.708.708L6 6.707l3.146 3.147a.5.5 0 00.708-.708L6.707 6z"
                            />
                        </svg>
                    </button>
                </div>
            )}
        </div>
        <ConfirmDialog
            isOpen={showRestoreConfirm && hiddenAgents.length > 0}
            title={hiddenAgents.length === 1 ? 'Bring back 1 running agent?' : `Bring back ${hiddenAgents.length} running agents?`}
            message={
                `These are still running with nothing on screen showing them: ${hiddenAgents.map(h => h.name).join(', ')}. ` +
                'Each gets a new tab attached to the terminal that is already running — nothing is restarted, and no output is lost.'
            }
            confirmText="Bring back"
            cancelText="Cancel"
            confirmMnemonic="B"
            cancelMnemonic="C"
            onConfirm={() => {
                setShowRestoreConfirm(false);
                // Reported here as well as in the Layout Manager: both surfaces
                // consume ONE hidden set, so they must not disagree about what
                // happened either. A terminal that exited between the badge
                // appearing and the click is silent otherwise — its tab simply
                // never arrives.
                void restoreHiddenAgentTerminals(hiddenAgents, dispatch).then(({ restored, stale }) => {
                    if (stale.length === 0) return;
                    dispatch(addToast({
                        message: restored.length === 0
                            ? (stale.length === 1
                                ? 'That terminal is no longer running — nothing to bring back.'
                                : `Those ${stale.length} terminals are no longer running — nothing to bring back.`)
                            : `Brought back ${restored.length}; ${stale.length} no longer running.`,
                        type: restored.length === 0 ? 'warning' : 'info',
                    }));
                });
            }}
            onCancel={() => setShowRestoreConfirm(false)}
        />
        <ConfirmDialog
            isOpen={showActivateConfirm}
            title="Receive API/MCP terminals here?"
            message="Make this window the target for API/MCP-created terminals? New terminals created via the API or MCP will open in this window instead of the current target."
            confirmText="Activate"
            cancelText="Cancel"
            confirmMnemonic="A"
            cancelMnemonic="C"
            onConfirm={confirmActivate}
            onCancel={() => setShowActivateConfirm(false)}
        />
      </>
    );
};
