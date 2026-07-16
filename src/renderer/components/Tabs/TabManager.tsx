import React, { useCallback, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { store, RootState, AppDispatch } from '../../store';
import { removeTab, setActiveTab, updateTabTitle, reorderTabs } from '../../store/slices/tabsSlice';
import { setShowLayoutManager } from '../../store/slices/layoutsSlice';
import { NewTabDropdown } from '../NewTabDropdown';
import { cleanupTerminalCache } from '../Terminal/TerminalDisplay';
import { TabContextMenu } from './TabContextMenu';
import { TabRenamePopup } from './TabRenamePopup';
import { terminalService } from '../../services/TerminalService';
import { StateManager } from '../../services/StateManager';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import { CloseSummary } from './CloseSummary';
import { computeAffectedTabs, filterMeaningfulProcesses } from '../../services/closeTabs';
import type { CloseKind } from '../../services/closeTabs';
import { getAllTerminalIds } from '../../store/slices/paneTreeOps';
import { clearCwdSnapshot } from '../../services/cwdSnapshot';
import { runSettingsGuard } from '../../services/settingsNavGuard';
import { dropTabAcrossWindows } from '../Panes/dnd/detach';
import { getCachedIcon, loadIcon } from '../../services/binaryIcons';
import './TabManager.css';

/** A pending tab-close awaiting confirmation (single tab or a bulk set). */
interface PendingClose {
  kind: CloseKind;
  /** Affected tab ids, in display order. */
  tabIds: string[];
  /** Clicked tab's title (used in the single-close message). */
  anchorTitle: string;
  /** tabId -> title, captured at request time so a later tab change can't blank one. */
  titlesById: Record<string, string>;
}

/**
 * Tab drag is pointer-based, NOT HTML5 drag. On macOS WKWebView, HTML5 drag
 * events report screenX/screenY as 0 and never deliver `dragend` to us, so we
 * cannot tell where a tab was dropped in screen space — which broke
 * "drag a tab out -> new window". Pointer events don't have that problem: while
 * a mouse button is held, macOS captures the pointer to the source window, so
 * `pointermove`/`pointerup` keep firing on this window with correct screen
 * coordinates even when the cursor is outside the window bounds.
 */

/**
 * True when a viewport (client) point lies outside this window's content area.
 * We use client coordinates, not screen coordinates: this WKWebView zeroes the
 * screen coords on pointer events, but client coords are reliable — while the
 * mouse button is held, macOS captures the pointer to this window and reports
 * client coords that go negative / past innerWidth|innerHeight once the cursor
 * leaves the window.
 */
function pointOutsideViewport(clientX: number, clientY: number): boolean {
  return clientX < 0 || clientY < 0 || clientX > window.innerWidth || clientY > window.innerHeight;
}

const DRAG_THRESHOLD_PX = 5;

interface TabDragHandlers {
  tabId: string;
  tabTitle: string;
  onDragStateChange: (dragging: boolean) => void;
  /** Move the dragged tab to sit where the tab currently under the pointer is. */
  requestReorder: (draggedId: string, targetId: string) => void;
}

/**
 * DOM fallback preview (browser / non-Tauri): a window-shaped card that follows
 * the cursor. It cannot leave the window bounds — that's why the Tauri path uses
 * a real OS preview window instead (see beginTabDrag).
 */
function makeTabGhost(title: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tab-drag-ghost';
  const bar = document.createElement('div');
  bar.className = 'tab-drag-ghost__bar';
  bar.textContent = title;
  const body = document.createElement('div');
  body.className = 'tab-drag-ghost__body';
  el.appendChild(bar);
  el.appendChild(body);
  document.body.appendChild(el);
  return el;
}

/**
 * Begin a pointer-based tab drag. Tracks movement on the window (so it keeps
 * receiving events when the cursor leaves the tab strip or the window), reorders
 * live as the pointer passes over other tabs, and on release detaches the tab to
 * a new window if the release point is outside this window.
 *
 * The drag preview is a real OS window (`show/move/hide_drag_preview`) so it stays
 * visible after the cursor leaves the source window — across monitors. When the
 * Tauri bridge isn't present, it falls back to an in-window DOM ghost.
 */
function beginTabDrag(e: React.PointerEvent, h: TabDragHandlers): void {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let ghost: HTMLElement | null = null;

  const api = window.electronAPI;
  // The native preview is a whole separate transparent/always-on-top Tauri window,
  // created on the fly while the pointer drag is in flight. On Linux (tao + GTK)
  // that races tao's window bookkeeping and aborts the process with a `.unwrap()`
  // panic in its Linux event-loop impl — so fall back to the DOM ghost there,
  // the same path already used when the Tauri bridge isn't present at all.
  const isLinux = navigator.userAgent.toLowerCase().includes('linux');
  const useNativePreview = !isLinux && !!api?.showDragPreview;
  let lastClientX = startX;
  let lastClientY = startY;
  let movePending = false;
  let rafId = 0;
  // Block the browser's text/icon selection sweep across the chrome. Installed
  // immediately on press (the selection starts on the first move, BEFORE the
  // drag threshold), removed on release.
  const preventSelect = (ev: Event) => ev.preventDefault();
  document.addEventListener('selectstart', preventSelect, true);
  window.getSelection?.()?.removeAllRanges?.();
  const scheduleNativeMove = () => {
    if (movePending) return;
    movePending = true;
    rafId = window.requestAnimationFrame(() => {
      movePending = false;
      void api?.moveDragPreview?.(lastClientX, lastClientY);
    });
  };

  const onMove = (ev: PointerEvent) => {
    lastClientX = ev.clientX;
    lastClientY = ev.clientY;
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      document.body.classList.add('tab-dragging');
      window.getSelection?.()?.removeAllRanges?.();
      h.onDragStateChange(true);
      if (useNativePreview) void api?.showDragPreview?.(h.tabTitle, ev.clientX, ev.clientY);
      else ghost = makeTabGhost(h.tabTitle);
    }
    if (useNativePreview) {
      // The OS preview window follows the real cursor (resolved in the backend);
      // throttle the nudge to one IPC call per animation frame.
      scheduleNativeMove();
    } else if (ghost) {
      // DOM ghost: move directly (no React re-render), cursor over its title bar.
      ghost.style.transform = `translate(${ev.clientX - 40}px, ${ev.clientY - 14}px)`;
    }
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const targetTab = el?.closest('[data-tab-target]') as HTMLElement | null;
    const targetId = targetTab?.getAttribute('data-tab-target');
    if (targetId && targetId !== h.tabId) {
      h.requestReorder(h.tabId, targetId);
    }
  };

  const onUp = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('selectstart', preventSelect, true);
    document.body.classList.remove('tab-dragging');
    if (rafId) window.cancelAnimationFrame(rafId);
    if (!dragging) return;
    if (useNativePreview) void api?.hideDragPreview?.();
    else ghost?.remove();
    h.onDragStateChange(false);
    if (pointOutsideViewport(ev.clientX, ev.clientY)) {
      // Released outside this window: reattach into whichever window is under the
      // drop point, or open a new window if none. CLIENT coords are converted to
      // a physical screen point in the backend (source window origin + scale).
      void dropTabAcrossWindows({
        tabId: h.tabId,
        tabTitle: h.tabTitle,
        clientX: ev.clientX,
        clientY: ev.clientY,
      });
    }
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
}

interface TabItemProps {
  tab: {
    id: string;
    title: string;
    icon?: string;
    isActive: boolean;
    isDirty?: boolean;
    processId?: number;
    exited?: boolean;
    hasBackgroundActivity?: boolean;
    activityTick?: number;
    isRunning?: boolean;
    hasUnseenOutput?: boolean;
    titleColor?: string;
  };
  requestReorder: (draggedId: string, targetId: string) => void;
  /** Whether the context-menu "Move to New Window" is offered (only with >1 tab;
      a single tab can still be dragged onto ANOTHER window). */
  canDetach: boolean;
  /** Real binary icon (data URL) for the tab's shell, when available. */
  iconUrl?: string;
  onClose: (id: string) => void;
  /** Browser-style close action (single/right/left/others) → confirm flow. */
  onCloseKind: (id: string, kind: CloseKind) => void;
  onSelect: (id: string) => void;
  onEditTitle: (id: string, title: string) => void;
  /** Position of THIS tab's context menu if it's the one currently open, else
      null. Lifted to TabManager so only one tab's menu can be open at a time
      — local per-item state let right-clicking another tab open a second
      menu without closing the first. */
  contextMenuPos: { x: number; y: number } | null;
  onOpenContextMenu: (x: number, y: number) => void;
  onCloseContextMenu: () => void;
  /** Position of THIS tab's rename popup if it's the one currently open, else
      null. Lifted to TabManager for the same reason as contextMenuPos — only
      one tab's rename popup should ever be open at a time. */
  renamePos: { x: number; y: number } | null;
  onOpenRename: (x: number, y: number) => void;
  onCloseRename: () => void;
}

const TabItem: React.FC<TabItemProps> = ({
  tab,
  requestReorder,
  canDetach,
  iconUrl,
  onClose,
  onCloseKind,
  onSelect,
  onEditTitle,
  contextMenuPos,
  onOpenContextMenu,
  onCloseContextMenu,
  renamePos,
  onOpenRename,
  onCloseRename,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  const handlePointerDown = (e: React.PointerEvent) => {
    // Always draggable — even the last tab can be dragged onto another window
    // (which then closes this now-empty window). Ignore presses on the close button.
    if ((e.target as HTMLElement).closest('.tab-close')) return;
    beginTabDrag(e, {
      tabId: tab.id,
      tabTitle: tab.title,
      onDragStateChange: setIsDragging,
      requestReorder,
    });
  };

  const opacity = isDragging ? 0.5 : 1;

  const handleDoubleClick = (e?: React.MouseEvent) => {
    // Don't let the dblclick bubble to the title bar (which would maximize the window).
    e?.stopPropagation();
    // Anchor near the tab itself (just below its bottom-left corner) rather
    // than the cursor position — consistent placement regardless of where
    // inside the tab the double-click landed.
    const rect = ref.current?.getBoundingClientRect();
    const x = rect ? rect.left : (e?.clientX ?? 0);
    const y = rect ? rect.bottom + 4 : (e?.clientY ?? 0);
    onOpenRename(x, y);
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose(tab.id);
  };

  const handleAuxClick = (e: React.MouseEvent) => {
    if (e.button === 1) { // Middle mouse click
      e.preventDefault();
      e.stopPropagation();
      onClose(tab.id);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenContextMenu(e.clientX, e.clientY);
  };

  // Get process ID from terminal service
  const processId = terminalService.getProcessIdForTerminal(tab.id);

  return (
    <>
      <div
        ref={ref}
        className={`tab-item ${tab.isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${tab.exited ? 'exited' : ''} ${tab.hasBackgroundActivity && !tab.isActive ? 'has-activity' : ''} ${tab.isRunning ? 'tab-running' : ''} ${tab.hasUnseenOutput && !tab.isActive ? 'has-unseen' : ''}`}
        style={{ opacity }}
        // Stop the press from reaching the title bar's Tauri drag region so
        // clicking/dragging a tab doesn't drag or maximize the window.
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={handlePointerDown}
        onClick={() => onSelect(tab.id)}
        onAuxClick={handleAuxClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        data-tab-target={tab.id}
        title={tab.title}
      >
        {tab.exited
          ? <span className="tab-exited-icon" title="Process exited — kept open for review">⊘</span>
          : iconUrl
            ? <img className="tab-icon-img" src={iconUrl} alt="" />
            : tab.icon && <span className="tab-icon">{tab.icon}</span>}
        <span
          key={tab.activityTick ?? 0}
          className="tab-title"
          style={tab.titleColor ? { color: tab.titleColor } : undefined}
        >
          {tab.title}
        </span>
        {tab.hasBackgroundActivity && !tab.isActive && (
          <span className="tab-activity-dot" title="Background activity from an external (MCP/API) call">●</span>
        )}
        {tab.hasUnseenOutput && !tab.isActive && (
          <span className="tab-unseen-bell" title="New output you haven't seen yet">🔔</span>
        )}
        {tab.isDirty && <span className="tab-dirty">●</span>}
        <button
          className="tab-close"
          onClick={handleClose}
          aria-label={`Close ${tab.title}`}
        >
          ×
        </button>
      </div>
      {contextMenuPos && (
        <TabContextMenu
          x={contextMenuPos.x}
          y={contextMenuPos.y}
          tabId={tab.id}
          tabTitle={tab.title}
          processId={processId}
          canDetach={canDetach}
          onCloseKind={onCloseKind}
          onClose={onCloseContextMenu}
        />
      )}
      {renamePos && (
        <TabRenamePopup
          x={renamePos.x}
          y={renamePos.y}
          initialTitle={tab.title}
          onSubmit={(title) => onEditTitle(tab.id, title)}
          onClose={onCloseRename}
        />
      )}
    </>
  );
};

interface TabManagerProps {
  onNewTab?: () => void;
}

export const TabManager: React.FC<TabManagerProps> = () => {
  const dispatch = useDispatch<AppDispatch>();
  // Pending close (single or bulk) awaiting confirmation.
  const [pendingClose, setPendingClose] = React.useState<PendingClose | null>(null);
  // tabId -> meaningful (non-shell) foreground process names for the confirm.
  const [processInfo, setProcessInfo] = React.useState<Map<string, string[]>>(new Map());
  // True once getActiveProcesses() resolved and was mapped; false while in-flight
  // or after a failure, in which case the confirm shows a generic message.
  const [processLoaded, setProcessLoaded] = React.useState(false);
  // Bumped on every new/cancelled/confirmed close so a stale getActiveProcesses()
  // resolve never writes into a newer or already-dismissed confirm.
  const closeReqSeq = useRef(0);
  // Which tab's right-click context menu is open (single shared slot, not
  // per-TabItem state) — opening one for any tab implicitly closes any other.
  const [openTabContextMenu, setOpenTabContextMenu] = React.useState<{ tabId: string; x: number; y: number } | null>(null);
  // Which tab's rename popup is open (single shared slot, same reasoning as
  // openTabContextMenu above).
  const [openTabRename, setOpenTabRename] = React.useState<{ tabId: string; x: number; y: number } | null>(null);

  const { tabs } = useSelector((state: RootState) => {
    console.log('TabManager: Redux state tabs:', state.tabs.tabs.map(t => ({ id: t.id, title: t.title })));
    return state.tabs;
  });
  const tabSizingMode = useSelector((state: RootState) => state.settings.tabSizingMode);
  const fixedTabWidth = useSelector((state: RootState) => state.settings.fixedTabWidth);
  const shellProfiles = useSelector((state: RootState) => state.settings.shellProfiles);
  const tabsArray = [...tabs]; // Convert to array for indexing

  // Resolve a tab's shell binary path (via its profile) so we can show the real
  // executable icon instead of the generic emoji.
  const profilePathForTab = useCallback(
    (shellType: string) => shellProfiles.find(p => p.id === shellType)?.path,
    [shellProfiles]
  );

  // Lazily load each tab's real binary icon; bump a tick to re-render when one
  // arrives. Shared cache means flyout-opened icons are reused here for free.
  const [, setIconTick] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      let changed = false;
      for (const tab of tabs) {
        const path = profilePathForTab(tab.shellType);
        if (!path || getCachedIcon(path)) continue;
        const url = await loadIcon(path);
        if (url) changed = true;
      }
      if (changed && !cancelled) setIconTick(t => t + 1);
    })();
    return () => { cancelled = true; };
  }, [tabs, profilePathForTab]);

  // Horizontal scrolling of the tab strip (only used in 'scroll' mode). We track
  // whether either edge can scroll so the arrow buttons can hide/disable when
  // there's nothing more to reveal.
  const tabsListRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);

  const updateScrollState = useCallback(() => {
    const el = tabsListRef.current;
    if (!el) return;
    // 1px slack absorbs sub-pixel rounding so the right arrow doesn't linger
    // enabled when already scrolled fully to the end.
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Keep the arrow enabled-state in sync with content width, container width and
  // scroll position. Runs whenever the tab set or sizing mode changes.
  React.useEffect(() => {
    const el = tabsListRef.current;
    if (!el) return;
    updateScrollState();
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateScrollState, tabSizingMode, fixedTabWidth, tabs]);

  const scrollByTabs = useCallback((direction: -1 | 1) => {
    const el = tabsListRef.current;
    if (!el) return;
    // Scroll by ~75% of the visible width so a click reveals a fresh batch of
    // tabs while keeping one for context.
    el.scrollBy({ left: direction * el.clientWidth * 0.75, behavior: 'smooth' });
  }, []);

  // Translate vertical wheel movement into horizontal tab-strip scrolling so a
  // plain mouse wheel reaches off-screen tabs (only meaningful in 'scroll'/'fixed' mode).
  const handleTabsWheel = useCallback((e: React.WheelEvent) => {
    if (tabSizingMode !== 'scroll' && tabSizingMode !== 'fixed') return;
    const el = tabsListRef.current;
    if (!el) return;
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (delta === 0) return;
    el.scrollLeft += delta;
    updateScrollState();
  }, [tabSizingMode, updateScrollState]);

  // Tear down one tab's terminals and remove it from Redux. No confirm-state side
  // effects, so it is safe to call in a loop for a bulk close.
  const closeOneTab = useCallback((id: string) => {
    console.log(`TabManager: Starting close process for tab ${id}`);

    // Get the pane tree for this tab to find all terminals
    const tabPanes = (window as any).tabPanes;
    const paneTree = tabPanes ? tabPanes[id] : null;

    const closeAllTerminalsInNode = (node: any) => {
      if (!node) return;
      if (node.type === 'terminal' && node.terminalId) {
        console.log(`TabManager: Closing terminal ${node.terminalId} from pane ${node.id}`);
        terminalService.closeTerminal(node.terminalId).catch(error => {
          console.error(`Failed to close terminal ${node.terminalId}:`, error);
        });
        // Spec 045 §3.3: the terminal is gone for good — drop its directory, as
        // PaneManager.performClose does for a single pane. Without this, closing a
        // whole tab leaked its panes' entries for the rest of the session.
        clearCwdSnapshot(node.terminalId);
      } else if (node.type === 'split' && node.children) {
        node.children.forEach(closeAllTerminalsInNode);
      }
    };

    if (paneTree) {
      closeAllTerminalsInNode(paneTree);
      console.log(`TabManager: Cleaning up tabPanes entry for ${id}`);
      delete tabPanes[id];
    }

    // Also close the tab's main terminal if it's not in the pane tree
    // (Usually it is, but just in case)
    terminalService.closeTerminal(id).catch((error) => {
      // Non-fatal (process may already be gone) but never silent: a failed
      // backend close with a removed tab = invisible orphaned PTY.
      console.warn(`TabManager: closeTerminal(${id}) failed:`, error);
    });
    // Mirrors the close above: the root pane's terminalId is usually the tab id
    // (so the walk covered it), but clear it unconditionally for the same reason
    // the close is unconditional — a tab whose tree we never saw.
    clearCwdSnapshot(id);

    // Remove tab from Redux state (UI update)
    dispatch(removeTab(id));
    console.log(`TabManager: Removed tab ${id} from Redux state`);

    // Clean up terminal cache for this tab
    cleanupTerminalCache(id);
  }, [dispatch]);

  // Immediate single-tab close (no confirm) — used by ui:forceTabClose.
  const handleCloseTab = useCallback((id: string) => {
    closeOneTab(id);
    setPendingClose(null);
  }, [closeOneTab]);

  // Fetch live foreground processes and map them to the affected tabs, filtering
  // out bare shells. Guarded by `seq` so a resolve after the confirm was closed or
  // replaced is ignored. Never throws into the caller — closing is not blocked.
  const resolveProcesses = useCallback(async (tabIds: string[], seq: number) => {
    try {
      const api = window.electronAPI;
      if (!api?.getActiveProcesses) return; // no bridge → keep the generic message
      const procs = await api.getActiveProcesses();
      if (closeReqSeq.current !== seq) return; // stale: confirm closed/replaced
      const nameByProcessId = new Map<string, string>();
      for (const p of procs) {
        if (p?.id) nameByProcessId.set(p.id, p.currentApp?.name ?? '');
      }
      // Resolve strictly within THIS window's tabs (their own pane trees), so a
      // process from another window's tab can never leak into the list.
      const treesByTabId = store.getState().panes.treesByTabId;
      const map = new Map<string, string[]>();
      for (const tabId of tabIds) {
        const termIds = getAllTerminalIds(treesByTabId[tabId] ?? null);
        const names: string[] = [];
        for (const termId of termIds) {
          // Pane nodes hold the UI terminalId; /api/processes is keyed by the
          // backend processId. TerminalService bridges the two — if a terminal
          // isn't registered yet, we simply can't name it (generic fallback).
          const processId = terminalService.getProcessIdForTerminal(termId);
          if (!processId) continue;
          const name = nameByProcessId.get(processId);
          if (name) names.push(name);
        }
        map.set(tabId, filterMeaningfulProcesses(names));
      }
      if (closeReqSeq.current !== seq) return;
      setProcessInfo(map);
      setProcessLoaded(true);
    } catch (err) {
      console.warn('TabManager: getActiveProcesses failed; using generic close message', err);
    }
  }, []);

  // Open the confirm for a close action. Computes the affected tabs, then fetches
  // their real running processes in the background.
  const handleCloseRequestKind = useCallback((tabId: string, kind: CloseKind) => {
    // The Settings screen is a process-less tab: a clean one has nothing to
    // confirm, so close it immediately; a dirty one is gated only by its own
    // unsaved-changes guard (Save/Discard/Cancel). Either way it must never show
    // the process-confirmation dialog. Single-tab close only — a batch close
    // (others/right/left) that happens to include Settings falls through.
    if (kind === 'single') {
      const settingsTab = store.getState().tabs.tabs.find((t) => t.id === tabId);
      if (settingsTab?.shellType === 'settings') {
        if (runSettingsGuard(() => closeOneTab(tabId))) return;
        closeOneTab(tabId);
        return;
      }
    }
    const orderedTabs = store.getState().tabs.tabs;
    const tabIds = computeAffectedTabs(orderedTabs.map((t) => t.id), tabId, kind);
    if (tabIds.length === 0) return;
    const anchorTitle = orderedTabs.find((t) => t.id === tabId)?.title || 'this tab';
    const titlesById: Record<string, string> = {};
    for (const t of orderedTabs) titlesById[t.id] = t.title;
    const seq = closeReqSeq.current + 1;
    closeReqSeq.current = seq;
    setProcessInfo(new Map());
    setProcessLoaded(false);
    setPendingClose({ kind, tabIds, anchorTitle, titlesById });
    void resolveProcesses(tabIds, seq);
  }, [resolveProcesses, closeOneTab]);

  // Single-tab confirm path — preserved for the close button, Ctrl/Cmd+W and the
  // ui:requestTabClose event.
  const handleCloseRequest = useCallback((id: string) => {
    // Skip the confirmation when the session already closed cleanly (exit 0):
    // nothing is running, so there is nothing to warn about. `tab.exited` is
    // only ever set once EVERY pane in the tab's tree has no live process (see
    // resolveExitedTabId), so this applies equally to a multi-pane tab whose
    // panes have all already closed — not just single-pane tabs.
    const tab = store.getState().tabs.tabs.find(t => t.id === id);
    if (tab?.exited && tab.exitCode === 0) {
      closeOneTab(id);
      return;
    }
    // Settings handling (clean → close now, dirty → unsaved-changes guard) lives
    // in handleCloseRequestKind so every single-close entry point shares it.
    handleCloseRequestKind(id, 'single');
  }, [handleCloseRequestKind, closeOneTab]);

  const handleConfirmClose = useCallback(() => {
    if (pendingClose) pendingClose.tabIds.forEach((id) => closeOneTab(id));
    setPendingClose(null);
    setProcessInfo(new Map());
    setProcessLoaded(false);
    closeReqSeq.current += 1; // invalidate any in-flight process fetch
  }, [pendingClose, closeOneTab]);

  const handleCancelClose = useCallback(() => {
    setPendingClose(null);
    setProcessInfo(new Map());
    setProcessLoaded(false);
    closeReqSeq.current += 1;
  }, []);

  const handleSelectTab = useCallback((id: string) => {
    console.log('TabManager: Selecting tab', id);
    const activeId = store.getState().tabs.tabs.find((t) => t.isActive)?.id;
    const proceed = () => dispatch(setActiveTab(id));
    // Only consult the guard when actually leaving the current (settings) tab.
    if (id !== activeId && runSettingsGuard(proceed)) return;
    proceed();
  }, [dispatch]);

  const handleEditTitle = useCallback(async (id: string, title: string) => {
    console.log(`TabManager: handleEditTitle - id: ${id}, new title: "${title}"`);
    dispatch(updateTabTitle({ id, title }));

    // Also update the terminal name in the backend
    const processId = terminalService.getProcessIdForTerminal(id);
    console.log(`TabManager: Found processId: ${processId} for tab ${id}`);
    if (processId) {
      try {
        await window.electronAPI.updateTerminalName(processId, title);
        console.log(`TabManager: Successfully updated backend name to "${title}"`);
      } catch (error) {
        console.error('Failed to update terminal name:', error);
      }
    }

    // Save state immediately after name change
    setTimeout(() => {
      StateManager.saveState();
      console.log('TabManager: Saved state after title update');
    }, 100);
  }, [dispatch]);

  // Keep the latest tab order in a ref so the pointer-drag reorder callback
  // (created once) always resolves indices against the current order.
  const tabsRef = useRef(tabsArray);
  tabsRef.current = tabsArray;

  const requestReorder = useCallback((draggedId: string, targetId: string) => {
    const current = tabsRef.current;
    const from = current.findIndex(t => t.id === draggedId);
    const to = current.findIndex(t => t.id === targetId);
    if (from === -1 || to === -1 || from === to) return;
    dispatch(reorderTabs({ fromIndex: from, toIndex: to }));
  }, [dispatch]);

  const handleOpenLayoutManager = useCallback(() => {
    dispatch(setShowLayoutManager(true));
  }, [dispatch]);

  // Keyboard shortcuts. Reads tabs via tabsRef so the window listener is
  // registered ONCE — the old [tabsArray] dependency re-added the listener on
  // every tab-state change (i.e. constantly during terminal output).
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'w') {
          e.preventDefault();
          const activeTab = tabsRef.current.find(tab => tab.isActive);
          if (activeTab) {
            // Same confirm-dialog path as the tab close button (was
            // handleCloseTab, which skipped confirmation).
            handleCloseRequest(activeTab.id);
          }
        } else if (e.key >= '1' && e.key <= '9') {
          e.preventDefault();
          const index = parseInt(e.key) - 1;
          if (index < tabsRef.current.length) {
            handleSelectTab(tabsRef.current[index].id);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCloseRequest, handleSelectTab]);

  // Listen for external close requests (e.g. from main menu) — these prompt for
  // confirmation. Also listen for force-close requests (e.g. a terminal whose
  // process already exited), which close immediately without a confirm dialog.
  React.useEffect(() => {
    const handleExternalCloseRequest = (e: any) => {
      const tabId = e.detail?.tabId;
      if (tabId) {
        handleCloseRequest(tabId);
      }
    };
    const handleForceCloseRequest = (e: any) => {
      const tabId = e.detail?.tabId;
      if (tabId) {
        handleCloseTab(tabId);
      }
    };

    window.addEventListener('ui:requestTabClose', handleExternalCloseRequest);
    window.addEventListener('ui:forceTabClose', handleForceCloseRequest);
    return () => {
      window.removeEventListener('ui:requestTabClose', handleExternalCloseRequest);
      window.removeEventListener('ui:forceTabClose', handleForceCloseRequest);
    };
  }, [handleCloseRequest, handleCloseTab]);

  // Smart close confirm (single or bulk), listing the real running processes.
  let closeConfirm: React.ReactNode = null;
  if (pendingClose) {
    const n = pendingClose.tabIds.length;
    const titleByKind: Record<CloseKind, string> = {
      single: 'Close Tab',
      right: 'Close Tabs to the Right',
      left: 'Close Tabs to the Left',
      others: 'Close Other Tabs',
    };
    const confirmText =
      pendingClose.kind === 'single' ? 'Close Tab' : `Close ${n} ${n === 1 ? 'Tab' : 'Tabs'}`;
    closeConfirm = (
      <ConfirmDialog
        isOpen
        destructive
        title={titleByKind[pendingClose.kind]}
        confirmText={confirmText}
        confirmMnemonic="C"
        cancelText="Cancel"
        cancelMnemonic="A"
        message={
          <CloseSummary
            kind={pendingClose.kind}
            tabIds={pendingClose.tabIds}
            anchorTitle={pendingClose.anchorTitle}
            titlesById={pendingClose.titlesById}
            processInfo={processInfo}
            loaded={processLoaded}
          />
        }
        onConfirm={handleConfirmClose}
        onCancel={handleCancelClose}
      />
    );
  }

  return (
    <>
      <div className="tab-manager">
        <div className="tabs-container" data-tauri-drag-region>
          {(tabSizingMode === 'scroll' || tabSizingMode === 'fixed') && canScrollLeft && (
            <button
              className="tab-scroll-button left"
              onClick={() => scrollByTabs(-1)}
              onMouseDown={(e) => e.stopPropagation()}
              title="Scroll tabs left"
              aria-label="Scroll tabs left"
            >
              ‹
            </button>
          )}
          <div
            ref={tabsListRef}
            className={`tabs-list ${tabSizingMode}`}
            style={tabSizingMode === 'fixed' ? { '--fixed-tab-width': `${fixedTabWidth}px` } as React.CSSProperties : undefined}
            data-tauri-drag-region
            onWheel={handleTabsWheel}
            onScroll={updateScrollState}
          >
            {tabsArray.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                requestReorder={requestReorder}
                canDetach={tabsArray.length > 1}
                iconUrl={getCachedIcon(profilePathForTab(tab.shellType))}
                onClose={handleCloseRequest}
                onCloseKind={handleCloseRequestKind}
                onSelect={handleSelectTab}
                onEditTitle={handleEditTitle}
                contextMenuPos={openTabContextMenu?.tabId === tab.id ? { x: openTabContextMenu.x, y: openTabContextMenu.y } : null}
                onOpenContextMenu={(x, y) => setOpenTabContextMenu({ tabId: tab.id, x, y })}
                onCloseContextMenu={() => setOpenTabContextMenu(null)}
                renamePos={openTabRename?.tabId === tab.id ? { x: openTabRename.x, y: openTabRename.y } : null}
                onOpenRename={(x, y) => setOpenTabRename({ tabId: tab.id, x, y })}
                onCloseRename={() => setOpenTabRename(null)}
              />
            ))}
          </div>
          {(tabSizingMode === 'scroll' || tabSizingMode === 'fixed') && canScrollRight && (
            <button
              className="tab-scroll-button right"
              onClick={() => scrollByTabs(1)}
              onMouseDown={(e) => e.stopPropagation()}
              title="Scroll tabs right"
              aria-label="Scroll tabs right"
            >
              ›
            </button>
          )}
          <div className="tab-actions">
            <button
              className="layout-manager-button"
              onClick={handleOpenLayoutManager}
              title="Manage Layouts"
              aria-label="Manage Layouts"
            >
              📁
            </button>
            <NewTabDropdown />
          </div>
        </div>
      </div>
      {closeConfirm}
    </>
  );
};