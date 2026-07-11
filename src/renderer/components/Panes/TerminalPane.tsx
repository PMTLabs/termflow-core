import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { TerminalDisplay } from '../Terminal/TerminalDisplay';
import { AgentChip } from '../Terminal/AgentChip';
import { terminalService } from '../../services/TerminalService';
import { RootState, store } from '../../store';
import { renamePanes } from '../../store/slices/panesSlice';
import { findTabIdByTerminalId, getSelectedPaneId } from '../../store/slices/paneTreeOps';
import { clearTabExited, setAutoTabTitle } from '../../store/slices/tabsSlice';
import { resetZoom, ZOOM_DEFAULT } from '../../store/slices/zoomSlice';
import { PaneContextMenu } from './PaneContextMenu';
import { SessionClosedBanner } from './SessionClosedBanner';
import { StateManager } from '../../services/StateManager';
import { takeInitialCwd } from '../../services/initialCwd';
import { usePaneDrag } from './dnd/usePaneDrag';
import './TerminalPane.css';

// Global map to track terminal initialization state
// This prevents duplicate terminal creation across component re-renders
const terminalInitMap = new Map<string, boolean>();

// Global map to track pending initialization promises
const terminalInitPromises = new Map<string, Promise<string>>();

// Synchronous initialization lock - set immediately when starting init
const terminalInitLock = new Map<string, boolean>();

// Expose to window for cleanup in TerminalService
if (typeof window !== 'undefined') {
  (window as any).terminalInitMap = terminalInitMap;
  (window as any).terminalInitPromises = terminalInitPromises;
  (window as any).terminalInitLock = terminalInitLock;
}

interface TerminalPaneProps {
  paneId: string;
  terminalId?: string;
  isActive: boolean;
  isTabActive?: boolean;
  // True when this is the tab's only pane. The header is then auto-hidden and
  // floats over the terminal on hover near the top (see TerminalPane.css), giving
  // the single terminal the full pane height.
  solo?: boolean;
  // True when this pane is the tab's maximized/zoomed pane. Drives the header
  // toggle button's glyph + title (the fill/hide is handled up in SplitPane).
  maximized?: boolean;
  onSplit: (direction: 'horizontal' | 'vertical') => void;
  onClose: () => void;
  onFocus: () => void;
  onToggleMaximize?: () => void;
  name?: string;
  shellType?: string;
}

export const TerminalPane: React.FC<TerminalPaneProps> = ({
  paneId,
  terminalId,
  isActive,
  isTabActive = true,
  solo = false,
  maximized = false,
  onSplit,
  onClose,
  onFocus,
  onToggleMaximize,
  name,
  shellType,
}) => {
  const dispatch = useDispatch();
  const paneRef = useRef<HTMLDivElement>(null);
  const [processId, setProcessId] = useState<string | undefined>();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(name || 'Terminal');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // Set when THIS pane's process exits but the pane is kept open (tab terminals
  // with closeTabOnProcessExit off, and all split panes). Drives the bottom banner.
  const [closedInfo, setClosedInfo] = useState<{ exitCode: number | null } | null>(null);

  // Sync editName when name prop changes (e.g., after successful rename)
  useEffect(() => {
    if (!isEditing) {
      setEditName(name || 'Terminal');
    }
  }, [name, isEditing]);

  // Get the tab to find its shell type
  const tab = useSelector((state: RootState) =>
    state.tabs.tabs.find(t => t.id === terminalId)
  );

  // Get the default profile from settings
  const defaultProfile = useSelector((state: RootState) => state.settings.defaultProfile);
  const shellProfiles = useSelector((state: RootState) => state.settings.shellProfiles);
  const fontSize = useSelector((state: RootState) => state.settings.fontSize);
  // Per-pane zoom multiplier (keyed by terminalId; defaults to 100%). Multiplied
  // into the font size we hand the engine, so zoom reflows this pane (more zoom =
  // larger text, fewer cols/rows) WITHOUT changing the shared font-size setting.
  const zoom = useSelector((state: RootState) =>
    terminalId ? state.zoom.levels[terminalId] ?? ZOOM_DEFAULT : ZOOM_DEFAULT
  );
  const effectiveFontSize = Math.max(8, Math.min(128, Math.round(fontSize * zoom)));

  // Initialize terminal when component mounts or terminalId changes
  useEffect(() => {
    console.log(`TerminalPane: Terminal init effect - terminalId: ${terminalId}, name: ${name}, tab: ${tab?.id}`);
    if (terminalId) {
      console.log(`TerminalPane: Lock state for ${terminalId}:`, terminalInitLock.get(terminalId), 'Promise exists:', !!terminalInitPromises.get(terminalId));
    }

    if (!terminalId) {
      console.log('TerminalPane: No terminalId, skipping terminal creation');
      return;
    }

    // If a process is already registered for this exact terminalId, reuse it.
    // This MUST come before the "tab no longer exists" guard below: a pane moved
    // to another window keeps its terminalId but its host tab gets a new id there,
    // so a reattached tab-root (tb-) pane would otherwise hit that guard and hang
    // on "Initializing". Covers tab roots AND split (tm-) panes reattached after a
    // detach / cross-window move. A brand-new split has a fresh unregistered tm-
    // id, so it still falls through and creates its own process below.
    const existingProcessId = terminalService.getProcessId(terminalId);
    if (existingProcessId) {
      console.log(`TerminalPane: Terminal ${terminalId} already has process ${existingProcessId}, reusing`);
      setProcessId(existingProcessId);
      return;
    }

    // Check if this is a tab terminal and the tab no longer exists (only relevant
    // when we'd otherwise CREATE a new terminal — handled after the reuse check).
    const isTabTerminal = terminalId.startsWith('tb-') || terminalId.startsWith('tab-');
    if (isTabTerminal && !tab) {
      console.log(`TerminalPane: Tab ${terminalId} no longer exists, skipping terminal creation`);
      return;
    }

    // Synchronous lock check - prevents race conditions
    if (terminalInitLock.get(terminalId)) {
      console.log(`TerminalPane: Terminal ${terminalId} is locked for initialization, checking for promise...`);

      // Wait a tiny bit for the promise to be set
      setTimeout(() => {
        const existingPromise = terminalInitPromises.get(terminalId);
        if (existingPromise) {
          console.log(`TerminalPane: Found initialization promise for ${terminalId}, waiting...`);
          existingPromise.then(pid => {
            console.log(`TerminalPane: Reusing process ${pid} from existing promise`);
            setProcessId(pid);
          }).catch(error => {
            console.error('Failed to get process from existing promise:', error);
          });
        } else {
          console.log(`TerminalPane: WARNING - Lock exists but no promise found for ${terminalId}`);
        }
      }, 10);
      return;
    }

    // Set the lock immediately - this is synchronous and prevents race conditions
    terminalInitLock.set(terminalId, true);
    console.log(`TerminalPane: Acquired initialization lock for ${terminalId}`);

    // For split panes (no tab), use the shellType prop if provided, otherwise default
    // For tab-based terminals, use the tab's shell type
    const isSplitPane = terminalId.startsWith('tm-') || terminalId.startsWith('pane-terminal-');
    const finalShellType = shellType || (isSplitPane ? (defaultProfile || 'default') : (tab?.shellType || defaultProfile || 'default'));

    // Resolve CWD: an inherited cwd from a pane split (backlog 004) wins over the
    // profile's default. takeInitialCwd consumes it once — we've already passed the
    // reuse/lock guards above, so this runs only when we genuinely spawn.
    const profile = shellProfiles.find(p => p.id === finalShellType);
    const cwd = takeInitialCwd(terminalId) ?? profile?.cwd;

    console.log(`TerminalPane: Terminal ${terminalId} - isSplitPane: ${isSplitPane}, tab exists: ${!!tab}, tab shellType: ${tab?.shellType}, defaultProfile: ${defaultProfile}, shellType prop: ${shellType}, final shellType: ${finalShellType}, cwd: ${cwd}`);

    // Determine the terminal name - prioritize the pane name, then tab title
    const terminalName = name || tab?.title || 'Terminal';
    console.log(`TerminalPane: Determining name - pane name: "${name}", tab title: "${tab?.title}", final: "${terminalName}"`);

    // Create the promise and store it immediately
    const initPromise = terminalService.createTerminal(terminalId, finalShellType, terminalName, cwd);
    terminalInitPromises.set(terminalId, initPromise);
    terminalInitMap.set(terminalId, true);

    initPromise
      .then(async pid => {
        console.log(`TerminalPane: Created terminal ${terminalId} with process ${pid}`);
        setProcessId(pid);

        // Creation is done: release the in-flight lock/promise. The reuse path
        // resolves via terminalService.getProcessId() from here on, and a stale
        // lock would block re-creating this terminalId if the exit event is
        // ever missed. (terminalInitMap stays — it marks "was created".)
        terminalInitLock.delete(terminalId);
        terminalInitPromises.delete(terminalId);

        // If we have a name from restored state, ensure it's synced to backend
        if (name && name !== 'Terminal') {
          try {
            console.log(`TerminalPane: Syncing restored name "${name}" to backend for process ${pid}`);
            await window.electronAPI.updateTerminalName(pid, name);
          } catch (error) {
            console.error('Failed to sync terminal name to backend:', error);
          }
        }
      })
      .catch(error => {
        console.error('Failed to create terminal:', error);
        console.error('Error details:', error.message, error.stack);
        // Remove from all maps on error so it can be retried
        terminalInitMap.delete(terminalId);
        terminalInitPromises.delete(terminalId);
        terminalInitLock.delete(terminalId);
      });

    return () => {
      // Clean up terminal on unmount
      if (terminalId && processId) {
        console.log(`TerminalPane: Cleanup called for terminal ${terminalId}, process ${processId}`);
        // Don't close terminal on unmount - it might be needed when switching tabs
        // terminalService.closeTerminal(terminalId).catch(console.error);
      }
      // Don't reset the global map on unmount - terminal persists across component lifecycle
    };
  }, [terminalId, tab?.shellType, defaultProfile]); // Only depend on terminalId, shellType, and defaultProfile

  useEffect(() => {
    const handleClick = () => {
      if (!isActive) {
        onFocus();
      }
    };

    const element = paneRef.current;
    if (element) {
      element.addEventListener('click', handleClick);
      return () => element.removeEventListener('click', handleClick);
    }
    return undefined;
  }, [isActive, onFocus]);

  // Solo panes: reveal the floating header only while the pointer is near the top
  // of the pane. Using a JS "peek" (toggling a class on pointer position) instead
  // of a pointer-capturing hover strip keeps the terminal's top row fully
  // clickable/selectable — the hidden header is pointer-events:none, so nothing
  // intercepts mouse actions until the user deliberately reaches for the top.
  useEffect(() => {
    if (!solo) return undefined;
    const el = paneRef.current;
    if (!el) return undefined;
    const PEEK_PX = 28;
    // Require the pointer to dwell near the top for this long before revealing the
    // header, so a quick pass-through doesn't flash it.
    const PEEK_DELAY_MS = 350;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // True while a mouse button is held (e.g. dragging to select text near the
    // top). We never reveal the header mid-press, so selection isn't interrupted.
    let pressed = false;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const hide = () => {
      clearTimer();
      el.classList.remove('header-peek');
    };
    const onMove = (e: PointerEvent) => {
      if (pressed) return;
      const nearTop = e.clientY - el.getBoundingClientRect().top <= PEEK_PX;
      if (!nearTop) {
        hide();
        return;
      }
      // Already shown, or a reveal is already pending — let it ride.
      if (timer || el.classList.contains('header-peek')) return;
      timer = setTimeout(() => {
        timer = null;
        el.classList.add('header-peek');
      }, PEEK_DELAY_MS);
    };
    const onDown = () => {
      pressed = true;
      hide();
    };
    const onUp = () => {
      pressed = false;
    };
    const onLeave = () => hide();
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointerup', onUp);
    return () => {
      clearTimer();
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointerup', onUp);
      el.classList.remove('header-peek');
    };
  }, [solo]);

  // Surface the "session closed" banner when THIS pane's process exits. We match
  // on terminalId (resolved by TerminalService) with processId as a fallback. The
  // tab-close-vs-keep decision lives in App.tsx; here we only drive the banner,
  // which is why it works for split panes too (App ignores those).
  useEffect(() => {
    if (!terminalId) return undefined;
    const onExit = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const matches =
        (d.terminalId && d.terminalId === terminalId) ||
        (processId && d.processId === processId);
      if (matches) {
        setClosedInfo({ exitCode: typeof d.exitCode === 'number' ? d.exitCode : null });
      }
    };
    window.addEventListener('pty:exit', onExit as EventListener);
    return () => window.removeEventListener('pty:exit', onExit as EventListener);
  }, [terminalId, processId]);

  // Restart the session IN PLACE: spawn a fresh shell for the same pane id,
  // reusing the original profile + working directory. The process map and init
  // guards were already cleared when the old process exited, so createTerminal
  // makes a new process. Prior scrollback is left untouched — same as an
  // app-start restore — so the new shell's output just continues below the old
  // session's; the engine's hydrate() already skips reset() for a brand-new
  // process with an empty snapshot (see TerminalEngine.hydrate).
  const handleRestart = useCallback(async () => {
    if (!terminalId) return;
    const isSplitPane =
      terminalId.startsWith('tm-') || terminalId.startsWith('pane-terminal-');
    const finalShellType =
      shellType ||
      (isSplitPane
        ? defaultProfile || 'default'
        : tab?.shellType || defaultProfile || 'default');
    const profile = shellProfiles.find(p => p.id === finalShellType);
    const cwd = profile?.cwd;
    const terminalName = name || tab?.title || 'Terminal';

    try {
      const newPid = await terminalService.createTerminal(
        terminalId,
        finalShellType,
        terminalName,
        cwd
      );
      // The engine re-attaches to the new process when processId changes below.
      setProcessId(newPid);
      setClosedInfo(null);
      // A restarted session is a fresh shell — return its zoom to 100%.
      dispatch(resetZoom(terminalId));
      // A tab can be marked "exited" once every pane in its tree has exited
      // (see App.tsx handleTerminalProcessExit / resolveExitedTabId), even for
      // a non-root pane's terminalId — so resolve the owning tab rather than
      // assuming terminalId === tab.id.
      const ownerTabId =
        findTabIdByTerminalId(store.getState().panes.treesByTabId, terminalId) || terminalId;
      dispatch(clearTabExited(ownerTabId));
    } catch (error) {
      console.error('TerminalPane: Failed to restart session:', error);
    }
  }, [terminalId, shellType, defaultProfile, tab?.shellType, tab?.title, shellProfiles, name, dispatch]);

  const handleDismissBanner = useCallback(() => setClosedInfo(null), []);

  // While the banner is up, Ctrl+R restarts in place. Capture-phase on the pane so
  // we intercept before xterm — and preventDefault stops the WebView from
  // reloading. When no banner is showing this is not bound, so Ctrl+R passes
  // through to the shell's reverse-search as usual.
  useEffect(() => {
    if (!closedInfo) return undefined;
    const el = paneRef.current;
    if (!el) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        e.stopPropagation();
        void handleRestart();
      }
    };
    el.addEventListener('keydown', onKeyDown, true);
    return () => el.removeEventListener('keydown', onKeyDown, true);
  }, [closedInfo, handleRestart]);

  const handleSplitHorizontal = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSplit('horizontal');
  };

  const handleSplitVertical = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSplit('vertical');
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  const handleToggleMaximize = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleMaximize?.();
  };

  const handleNameEdit = () => {
    setIsEditing(true);
    setEditName(name || 'Terminal');
  };

  const handleNameSave = async () => {
    if (editName.trim()) {
      dispatch(renamePanes({ paneId, name: editName.trim() }));

      // Also update the terminal name in the backend
      if (processId) {
        try {
          console.log(`TerminalPane: Updating terminal name for processId ${processId} to "${editName.trim()}"`);
          await window.electronAPI.updateTerminalName(processId, editName.trim());
        } catch (error) {
          console.error('Failed to update terminal name:', error);
        }
      } else {
        console.warn('TerminalPane: No processId available to update terminal name');
      }

      // Save state immediately after name change
      setTimeout(() => {
        StateManager.saveState();
        console.log('TerminalPane: Saved state after name update');
      }, 100);
    }
    setIsEditing(false);
  };

  const handleNameCancel = () => {
    setEditName(name || 'Terminal');
    setIsEditing(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNameSave();
    } else if (e.key === 'Escape') {
      handleNameCancel();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only show context menu if clicking on the header area
    const target = e.target as HTMLElement;
    if (target.closest('.terminal-pane-header')) {
      setContextMenu({ x: e.clientX, y: e.clientY });
    }
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);
  };

  // Drag the pane by its title bar to move it (within a tab, across tabs, or out).
  const handleHeaderPointerDown = usePaneDrag({
    terminalId: terminalId || '',
    sourcePaneId: paneId,
    name,
    shellType,
  });

  return (
    <>
      <div
        ref={paneRef}
        className={`terminal-pane ${isActive ? 'active' : ''} ${solo ? 'solo' : ''}`}
        data-pane-id={paneId}
        onContextMenu={handleContextMenu}
      >
        <div
          className="terminal-pane-header"
          onPointerDown={handleHeaderPointerDown}
        >
          <div className="terminal-pane-title">
            {isEditing ? (
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleNameSave}
                onKeyDown={handleNameKeyDown}
                className="pane-name-input"
                autoFocus
              />
            ) : (
              <span
                className="pane-name"
                onDoubleClick={handleNameEdit}
                title="Double-click to rename"
              >
                {name || 'Terminal'}
              </span>
            )}
          </div>
          <div className="terminal-pane-controls">
            <button
              className="pane-control-button"
              onClick={handleSplitHorizontal}
              title="Split Horizontal"
              aria-label="Split Horizontal"
            >
              {/* Top/bottom panes: box with a horizontal divider. */}
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
            <button
              className="pane-control-button"
              onClick={handleSplitVertical}
              title="Split Vertical"
              aria-label="Split Vertical"
            >
              {/* Left/right panes: box with a single vertical divider. */}
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <line x1="8" y1="1.5" x2="8" y2="14.5" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
            <button
              className={`pane-control-button ${maximized ? 'maximized' : ''}`}
              onClick={handleToggleMaximize}
              title={maximized ? 'Restore pane (Ctrl+Shift+Enter)' : 'Maximize pane (Ctrl+Shift+Enter)'}
              aria-label={maximized ? 'Restore pane' : 'Maximize pane'}
            >
              {maximized ? '⤡' : '⤢'}
            </button>
            <button
              className="pane-control-button close"
              onClick={handleClose}
              title="Close Pane"
              aria-label="Close Pane"
            >
              ×
            </button>
          </div>
        </div>
        <div className="terminal-pane-content">
          {terminalId && processId ? (
            <TerminalDisplay
              terminalId={terminalId}
              processId={processId}
              paneId={paneId}
              fontSize={effectiveFontSize}
              isActive={isTabActive}
              // Focus this terminal only when it's the active pane of the active
              // tab — restores the cursor on tab switch / pane select.
              shouldFocus={isActive && isTabActive}
              onData={(data: string) => {
                // Send data to PTY through terminal service
                terminalService.writeToTerminal(terminalId, data).catch(console.error);
              }}
              onResize={(cols: number, rows: number) => {
                // Resize PTY through terminal service
                terminalService.resizeTerminal(terminalId, cols, rows).catch(console.error);
              }}
              onTitleChange={(title: string) => {
                // OSC title sequences (shell/program setting its terminal
                // title) drive the tab's title live — but only when this
                // pane is the tab's currently SELECTED one (a background
                // split pane's title shouldn't hijack the tab name), and
                // only until the user manually renames the tab (see
                // setAutoTabTitle's titleIsCustom guard).
                if (!terminalId) return;
                const st = store.getState();
                const owningTabId = findTabIdByTerminalId(st.panes.treesByTabId, terminalId);
                if (!owningTabId) return;
                const selectedPaneId = getSelectedPaneId(st.panes.treesByTabId, st.panes.activePaneByTabId, owningTabId);
                if (selectedPaneId !== paneId) return;
                dispatch(setAutoTabTitle({ id: owningTabId, title }));
              }}
            />
          ) : terminalId && !processId ? (
            <div className="terminal-placeholder">
              Initializing terminal...
            </div>
          ) : terminalId ? (
            <div className="terminal-placeholder">
              Waiting for shell process...
            </div>
          ) : (
            <div className="terminal-placeholder">
              No terminal assigned to this pane
            </div>
          )}
          {/* Floating agent-identity chip (top-right); shows the detected agent
              CLI while one runs in this pane, hides on exit. */}
          {terminalId && processId && <AgentChip terminalId={terminalId} />}
        </div>
        {/* In-flow below the terminal content (not overlaying it): the content
            area shrinks to make room, so the banner never covers the last rows. */}
        {closedInfo && (
          <SessionClosedBanner
            exitCode={closedInfo.exitCode}
            fontSize={fontSize}
            onRestart={() => {
              void handleRestart();
            }}
            onDismiss={handleDismissBanner}
          />
        )}
      </div>
      {contextMenu && (
        <PaneContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          paneId={paneId}
          paneName={name || 'Terminal'}
          terminalId={terminalId}
          processId={processId}
          onClose={handleCloseContextMenu}
        />
      )}
    </>
  );
};