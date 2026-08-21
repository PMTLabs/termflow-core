import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { TerminalDisplay } from '../Terminal/TerminalDisplay';
import { AgentChip } from '../Terminal/AgentChip';
import { terminalService } from '../../services/TerminalService';
import { RootState, store } from '../../store';
import { renamePanes, setPaneMuted } from '../../store/slices/panesSlice';
import { findTabIdByTerminalId, findLeaf, getSelectedPaneId, findSessionKeyByTerminalId } from '../../store/slices/paneTreeOps';
import { clearTabExited, setAutoTabTitle } from '../../store/slices/tabsSlice';
import { markSessionClosed, clearSessionClosed } from '../../store/slices/sessionExitSlice';
import { BellIcon } from '../UI/BellIcon';
import { resetZoom, ZOOM_DEFAULT } from '../../store/slices/zoomSlice';
import { EndedOverlay, paneClassName } from './EndedOverlay';
import { PaneContextMenu } from './PaneContextMenu';
import { SessionClosedBanner } from './SessionClosedBanner';
import { useRestartHotkey } from './useRestartHotkey';
import { StateManager } from '../../services/StateManager';
import { takeInitialCwd } from '../../services/initialCwd';
import { setCwdSnapshot, getCwdSnapshot, clearCwdSnapshot, sampleCwdGeneration } from '../../services/cwdSnapshot';
import { reattachPromptGate, takeArmProbePending } from '../../services/reattachGate';
import { usePaneDrag } from './dnd/usePaneDrag';
import { getPaneStartupStatus } from '../../services/paneStartupStatus';
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
  // Set when the most recent create/restart attempt's promise rejected. Drives
  // the top-row "Failed to start shell" status (P0: never leave a silent blank
  // while startup is in flight or has failed).
  const [startupFailed, setStartupFailed] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(name || 'Terminal');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // Set when THIS pane's process exits but the pane is kept open (tab terminals
  // with closeTabOnProcessExit off, and all split panes). Drives the bottom banner.
  //
  // In the STORE rather than in `useState` since `plan/024` Req 4: a canvas node has to draw
  // itself muted when its session is over, and the canvas overlay has to show this same banner —
  // neither can read a sibling component's local state. The pane is still the only WRITER; what
  // changed is that the fact is now legible from outside it. See `sessionExitSlice`.
  const closedInfo = useSelector(
    (state: RootState) => (terminalId ? state.sessionExit.byTerminalId[terminalId] : undefined),
  ) ?? null;
  // UI-level guard so the Restart button/Ctrl+R don't re-enter handleRestart
  // while a restart is already in flight. Belt-and-suspenders on top of
  // TerminalService's leaf-keyed single-flight (review 109 H1) — that is the
  // actual fix; this just keeps the visible affordance from looking broken.
  const isRestartingRef = useRef(false);

  // Sync editName when name prop changes (e.g., after successful rename)
  useEffect(() => {
    if (!isEditing) {
      setEditName(name || 'Terminal');
    }
  }, [name, isEditing]);

  // The tab this pane lives in. Resolved through the pane tree, NOT by matching
  // `t.id === terminalId`: that equality only ever held for a renderer-created
  // tab root, and design 014 removed it — every leaf is now a minted `tm-`, so
  // the old lookup silently matched nothing for every pane in the app.
  const tab = useSelector((state: RootState) => {
    if (!terminalId) return undefined;
    const owner = findTabIdByTerminalId(state.panes.treesByTabId, terminalId);
    return owner ? state.tabs.tabs.find(t => t.id === owner) : undefined;
  });

  // Get the default profile from settings
  const defaultProfile = useSelector((state: RootState) => state.settings.defaultProfile);
  const shellProfiles = useSelector((state: RootState) => state.settings.shellProfiles);
  const fontSize = useSelector((state: RootState) => state.settings.fontSize);
  const nonFocusedPaneOpacity = useSelector((state: RootState) => state.settings.nonFocusedPaneOpacity);
  // Terminal font family — the startup status must render in the same font as
  // the terminal it stands in for (not a hardcoded stack), so it honours the
  // user's font settings.
  const fontFamily = useSelector((state: RootState) => state.settings.fontFamily);
  // Per-pane zoom multiplier (keyed by terminalId; defaults to 100%). Multiplied
  // into the font size we hand the engine, so zoom reflows this pane (more zoom =
  // larger text, fewer cols/rows) WITHOUT changing the shared font-size setting.
  const zoom = useSelector((state: RootState) =>
    terminalId ? state.zoom.levels[terminalId] ?? ZOOM_DEFAULT : ZOOM_DEFAULT
  );
  const effectiveFontSize = Math.max(8, Math.min(128, Math.round(fontSize * zoom)));

  // Notification-mute state for the header bell. `paneMuted` is this pane's own
  // flag; `tabMuted` is its owning tab's flag. The bell shows slashed when
  // EITHER is set (effective state — no notification actually fires), but the
  // toggle only ever flips this pane's own flag (tab mute is managed from the
  // tab context menu). Each selector returns a plain boolean and resolves the
  // pane/tab itself (self-contained — no cross-selector closure that could read a
  // stale owningTabId during an intermediate store-notification pass).
  const paneMuted = useSelector((state: RootState) => {
    for (const tid of Object.keys(state.panes.treesByTabId)) {
      const leaf = findLeaf(state.panes.treesByTabId[tid], paneId);
      if (leaf) return !!leaf.notifyMuted;
    }
    return false;
  });
  const tabMuted = useSelector((state: RootState) => {
    if (!terminalId) return false;
    const tid = findTabIdByTerminalId(state.panes.treesByTabId, terminalId);
    return !!(tid && state.tabs.tabs.find(t => t.id === tid)?.notifyMuted);
  });
  const effectiveMuted = tabMuted || paneMuted;
  const handleToggleMute = () => {
    dispatch(setPaneMuted({ paneId, muted: !paneMuted }));
  };
  // Mirrors the shellType fallback the create/reattach effects below use (shellType
  // prop > defaultProfile > 'default') — passed down so the engine can gate the
  // Ctrl+Backspace/Ctrl+Delete word-delete shim off the real shell
  // (decideWordDeleteShim in terminal-core). A separate computation rather than
  // reusing the effects' local consts, which aren't in scope at render time.
  //
  // There used to be a root-vs-split branch here (`tm-`/`pane-terminal-` => split,
  // else the tab's stored shellType). Design 014 mints a `tm-` leaf for EVERY pane,
  // so the split arm is the only arm — the pane node's own `shellType`, which the
  // seed copies from the tab, is what carries a tab's profile down now.
  const finalShellTypeForDisplay = shellType || defaultProfile || 'default';

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

    // Clear any stale "Failed to start shell" status before (re)resolving this
    // terminalId, so an early-return path (reuse / locked / tab-gone) can never
    // surface a false failure left over from a prior id on this instance. The
    // genuine-spawn path below relies on this having run first.
    setStartupFailed(false);

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
      // Design 006 (review 008 M-1): a reconcile-reattached hooked shell got the
      // safe DISARMED baseline at fetch time; sample the bare-prompt answer NOW,
      // immediately before the engine mounts, and refresh the gate handoff — a
      // child that appeared since the reconcile fetch stays disarmed. Marker is
      // single-use, so ordinary same-session remounts skip the probe entirely.
      if (takeArmProbePending(terminalId)) {
        void (async () => {
          try {
            const seed = await window.electronAPI.probeReattachPromptGate?.(existingProcessId);
            if (seed) {
              terminalService.stashPromptGate(
                terminalId,
                reattachPromptGate(seed.promptHook, seed.atPrompt),
              );
            }
          } catch (e) {
            console.warn('TerminalPane: pre-mount arm probe skipped (baseline stays disarmed):', e);
          } finally {
            setProcessId(existingProcessId);
          }
        })();
      } else {
        setProcessId(existingProcessId);
      }
      return;
    }

    // A "this leaf IS a tab, and that tab is gone" guard stood here, keyed on
    // `terminalId.startsWith('tb-'|'tab-')`. Design 014 mints a `tm-` leaf for every
    // pane, so it could never fire again. It is NOT generalised to `if (!tab)`: a
    // pane renders from the `tabPanes` window mirror before its tree reaches
    // `treesByTabId`, so an unresolved owner means "not committed yet", not "tab
    // gone" — treating it as the latter strands the pane on "Initializing".

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

    // The pane's own shellType wins; otherwise the configured default. The seed
    // copies a tab's profile onto its root leaf, so there is nothing a root needs
    // here that a split does not (design 014 — every leaf is a minted `tm-`).
    const finalShellType = shellType || defaultProfile || 'default';

    // Resolve CWD — FIRST-SPAWN precedence (spec 045 §3.3):
    //   1. a cwd inherited from a pane split (backlog 004) — the user's most
    //      recent intent, and it must win;
    //   2. a directory restored from a previous session;
    //   3. the profile default.
    // Deliberately the REVERSE of handleRestart's rule, where there is no live
    // split to inherit from. takeInitialCwd consumes its value once — we've
    // already passed the reuse/lock guards above, so this runs only on a genuine
    // spawn.
    const profile = shellProfiles.find(p => p.id === finalShellType);
    const cwd = takeInitialCwd(terminalId) ?? getCwdSnapshot(terminalId) ?? profile?.cwd;

    console.log(`TerminalPane: Terminal ${terminalId} - owning tab: ${tab?.id ?? '(uncommitted)'}, defaultProfile: ${defaultProfile}, shellType prop: ${shellType}, final shellType: ${finalShellType}, cwd: ${cwd}`);

    // Determine the terminal name - prioritize the pane name, then tab title
    const terminalName = name || tab?.title || 'Terminal';
    console.log(`TerminalPane: Determining name - pane name: "${name}", tab title: "${tab?.title}", final: "${terminalName}"`);

    // Ownership lives only in the pane tree, so resolve it here — and send
    // NOTHING when the tree has not been committed yet. The old `|| terminalId`
    // fallback leaned on a renderer root's leaf being its own tab id; after
    // design 014 that id is a `tm-`, so the fallback would file a terminal id
    // as an owning TAB id and route this pane's activity at a tab that does not
    // exist. Undefined is self-healing instead: `reassertOwnerAfterSpawn` below
    // pushes the real owner the moment the tree lands, whichever order they
    // arrive in (see paneOwnership.ts).
    const owningTabId =
      findTabIdByTerminalId(store.getState().panes.treesByTabId, terminalId) ?? undefined;

    // Create the promise and store it immediately
    const initPromise = terminalService.createTerminal(
      terminalId, finalShellType, terminalName, cwd, undefined, undefined, owningTabId,
      findSessionKeyByTerminalId(store.getState().panes.treesByTabId, terminalId),
    );
    terminalInitPromises.set(terminalId, initPromise);
    terminalInitMap.set(terminalId, true);

    initPromise
      .then(async pid => {
        console.log(`TerminalPane: Created terminal ${terminalId} with process ${pid}`);

        // Backlog 011: if the backend REATTACHED this terminal after a core-restart
        // hot-swap, reconcile could not seed the command-suggest prompt gate (the
        // terminal list was empty then), so the backend stashed the shell's
        // prompt-hook. Drain it and re-seed the gate BEFORE setProcessId mounts the
        // engine (TerminalDisplay renders only once processId is set, and reads the
        // handoff on mount) — otherwise the popup leaks keystrokes into an agent CLI
        // that survived the update. Best-effort; never block terminal init.
        try {
          // `pid`, NOT `terminalId`. Design 014 re-keyed `reattach_prompt_hooks` and
          // `state.terminals` off the leaf onto the minted `pc-` process id
          // (commands.rs:424, 573-582), and this reader was left behind: a `tm-` leaf
          // looked up in a `pc-` map missed every time, so the seed below never ran and
          // BOTH of the things it unlocks stayed broken on every reattach. The sibling
          // probe above has always passed `existingProcessId`; the two agree again now.
          const seed = await window.electronAPI.takeReattachPromptHook?.(pid);
          if (seed) {
            terminalService.stashPromptGate(
              terminalId,
              reattachPromptGate(seed.promptHook, seed.atPrompt),
            );
            // A drained seed IS the "backend reattached this session" signal, so
            // it also re-seeds Win32-Input-Mode: ConPTY announced ?9001h once,
            // before this renderer (and this core) existed, and neither the
            // hydration snapshot nor the persisted scrollback replays a mode.
            // Without it the pane sends legacy bytes to a ConPTY expecting
            // records and Escape never reaches the agent CLI that survived the
            // update. Hook-independent — ConPTY asserts the mode for every
            // Windows session, hookless shells included.
            terminalService.markReattachedSession(terminalId);
          }
        } catch (e) {
          console.warn('TerminalPane: reattach prompt-gate seed skipped:', e);
        }

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
        setStartupFailed(true);
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
    // Deliberately narrow: re-spawning is keyed on the leaf and the profile that
    // decides the shell, nothing else. `tab?.shellType` used to sit here and is
    // gone with the branch that read it — leaving it would re-run this effect on
    // a tab profile change now that `tab` actually resolves (design 014).
  }, [terminalId, defaultProfile]);

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
    // Sampled here, while this pane's terminal is LIVE. If the pane is closed
    // before its exit event lands (performClose clears the snapshot synchronously,
    // the event arrives after), the generation moves and the write below is
    // dropped — a pane that no longer exists must not re-add its entry. Re-sampled
    // on restart, when processId changes and this effect re-subscribes, so a
    // restarted shell's own exit still records its directory.
    const generation = sampleCwdGeneration(terminalId);
    const onExit = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const matches =
        (d.terminalId && d.terminalId === terminalId) ||
        (processId && d.processId === processId);
      if (matches) {
        // Spec 045 §3.3: the backend hands us the shell's final directory here
        // (it wipes its own record before emitting, so we cannot read it back).
        // `final` because this is the directory the shell actually died in: it
        // outranks any 30s-tick refresh still in flight, which can only carry a
        // reading from while the shell was alive (i.e. before its last `cd`).
        setCwdSnapshot(terminalId, d.cwd, { final: true, generation });
        dispatch(markSessionClosed({
          terminalId,
          exitCode: typeof d.exitCode === 'number' ? d.exitCode : null,
        }));
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
    if (isRestartingRef.current) return;
    isRestartingRef.current = true;
    // Same collapse as the create path: after design 014 every leaf is a `tm-`,
    // so the root arm of the old root-vs-split branch was unreachable.
    const finalShellType = shellType || defaultProfile || 'default';
    const profile = shellProfiles.find(p => p.id === finalShellType);
    // Spec 045 §3.3 — RESTART precedence: the directory the shell died in wins,
    // then a cwd inherited from a split, then the profile default. This is
    // deliberately the REVERSE of the first-spawn rule below (there is no live
    // split to inherit from at restart). A directory that no longer exists is
    // handled by the backend (pty_manager.rs is_dir()-checks the spawn cwd).
    const cwd = getCwdSnapshot(terminalId) ?? takeInitialCwd(terminalId) ?? profile?.cwd;
    const terminalName = name || tab?.title || 'Terminal';
    // A tab can be marked "exited" once every pane in its tree has exited
    // (see App.tsx handleTerminalProcessExit / resolveExitedTabId), even for
    // a non-root pane's terminalId — so resolve the owning tab rather than
    // assuming terminalId === tab.id. Resolved up front so it can also be
    // forwarded to the backend at spawn (design 011 §6). No `|| terminalId`
    // fallback, for the reason the create path above gives: post-014 that would
    // be a terminal id masquerading as a tab id.
    const ownerTabId =
      findTabIdByTerminalId(store.getState().panes.treesByTabId, terminalId) ?? undefined;

    try {
      const newPid = await terminalService.createTerminal(
        terminalId,
        finalShellType,
        terminalName,
        cwd,
        undefined,
        undefined,
        ownerTabId,
        // A restart must reuse the MIGRATED session key, not mint one: the host
        // still knows this session by its old id (design 014 A2.1).
        findSessionKeyByTerminalId(store.getState().panes.treesByTabId, terminalId),
      );
      // The engine re-attaches to the new process when processId changes below.
      setProcessId(newPid);
      dispatch(clearSessionClosed({ terminalId }));
      // The snapshot has been consumed. Clearing it stops a LATER exit that
      // carries no cwd from silently reusing this directory (spec 045 §3.3).
      clearCwdSnapshot(terminalId);
      // A restarted session is a fresh shell — return its zoom to 100%.
      dispatch(resetZoom(terminalId));
      if (ownerTabId) dispatch(clearTabExited(ownerTabId));
    } catch (error) {
      console.error('TerminalPane: Failed to restart session:', error);
    } finally {
      isRestartingRef.current = false;
    }
  }, [terminalId, shellType, defaultProfile, tab?.title, shellProfiles, name, dispatch]);

  const handleDismissBanner = useCallback(
    () => { if (terminalId) dispatch(clearSessionClosed({ terminalId })); },
    [terminalId, dispatch],
  );

  // While the banner is up, Ctrl+R restarts in place. The binding itself now lives in
  // `useRestartHotkey`, shared with the Canvas overlay so the hint the banner prints means the
  // same thing on both surfaces (`plan/024` Req 4).
  const restartSessionCb = useCallback(() => { void handleRestart(); }, [handleRestart]);
  useRestartHotkey(paneRef, !!closedInfo, restartSessionCb);

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
        className={paneClassName({ isActive, solo, closedInfo })}
        data-pane-id={paneId}
        onContextMenu={handleContextMenu}
        style={isActive ? undefined : { opacity: nonFocusedPaneOpacity / 100 }}
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
              className={`pane-control-button${effectiveMuted ? ' muted' : ''}`}
              onClick={handleToggleMute}
              title={
                tabMuted
                  ? 'Notifications muted for the whole tab'
                  : paneMuted
                    ? 'Notifications muted — click to unmute this pane'
                    : 'Mute notifications for this pane'
              }
              aria-label={paneMuted ? 'Unmute pane notifications' : 'Mute pane notifications'}
              aria-pressed={paneMuted}
            >
              <BellIcon muted={effectiveMuted} />
            </button>
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
              shellType={finalShellTypeForDisplay}
              // Focus this terminal only when it's the active pane of the active
              // tab — restores the cursor on tab switch / pane select.
              shouldFocus={isActive && isTabActive}
              // Published into `surfaceChrome` so the Canvas overlay can render THIS pane's
              // session-closed banner and act on it (`plan/024` Req 4). The pane keeps the only
              // implementation — a restart needs the profile, the cwd the shell died in and the
              // migrated session key, none of which the canvas has.
              // MEMOISED, never an inline arrow. `TerminalDisplay` wraps this in a
              // `useCallback` keyed on the prop itself and publishes the result into
              // `surfaceChrome`, whose `same()` compares callbacks BY REFERENCE — so a fresh
              // arrow each render makes every publish look like a change, and every canvas node
              // re-renders on every render of this pane. That is the exact regression
              // `surfaceChrome`'s "writes are NO-OPS when nothing observable changed" rule
              // exists to prevent.
              onRestartSession={restartSessionCb}
              onDismissSessionClosed={handleDismissBanner}
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
            (() => {
              const status = getPaneStartupStatus(processId, startupFailed);
              // status is never null here (processId is falsy in this branch),
              // but the check keeps the helper's contract honest.
              return status ? (
                <div
                  className={`terminal-startup-status${status.failed ? ' failed' : ''}`}
                  // Match the terminal's own font (family + effective, zoom-aware
                  // size) so the status reads like the shell's first line.
                  style={{ fontFamily, fontSize: effectiveFontSize }}
                >
                  {status.text}
                </div>
              ) : null;
            })()
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
          <EndedOverlay closedInfo={closedInfo} />
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
          // The tab this pane lives in NOW — resolved from the tree rather than
          // inferred from the leaf, which stopped implying it in design 014.
          owningTabId={
            terminalId
              ? findTabIdByTerminalId(store.getState().panes.treesByTabId, terminalId) || undefined
              : undefined
          }
          processId={processId}
          onClose={handleCloseContextMenu}
        />
      )}
    </>
  );
};