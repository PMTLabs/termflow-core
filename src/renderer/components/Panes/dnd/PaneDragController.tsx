import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { listen } from '@tauri-apps/api/event';
import { store, AppDispatch } from '../../../store';
import { movePaneWithinTab, movePaneToTab } from '../../../store/slices/panesSlice';
import { setActiveTab, removeTab } from '../../../store/slices/tabsSlice';
import { PaneNode } from '../../../store/slices/panesSlice';
import { computeZone } from './zone';
import { PaneDragSource, PaneDragState, PaneDropTarget } from './types';
import { PaneDragLayer } from './PaneDragLayer';
import { PaneDropOverlay } from './PaneDropOverlay';
import {
  detachPaneToNewWindow,
  buildPaneDetachPayload,
  newDetachToken,
  removeSourcePane,
  applyCrossWindowPayload,
} from './detach';
import './dnd.css';

const THRESHOLD = 5; // px the pointer must travel before a press becomes a drag
const DWELL_MS = 400; // hover-over-tab dwell before activating it (Phase 2)
const ORPHAN_DELAY_MS = 160; // give a destination window a chance to claim before we open a new window

interface PaneDragContextValue {
  drag: PaneDragState | null;
  beginPress: (e: React.PointerEvent, source: PaneDragSource) => void;
}

const PaneDragContext = createContext<PaneDragContextValue | null>(null);

export const usePaneDragContext = (): PaneDragContextValue => {
  const ctx = useContext(PaneDragContext);
  if (!ctx) throw new Error('usePaneDragContext must be used within PaneDragProvider');
  return ctx;
};

interface PressState {
  source: PaneDragSource;
  startX: number;
  startY: number;
  dragging: boolean;
}

interface GlobalSource {
  token: string;
  sourceTabId: string;
  sourcePaneId: string;
  terminalId: string;
}

const isOutside = (x: number, y: number) =>
  x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;

export const PaneDragProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const dispatch = useDispatch<AppDispatch>();
  const [drag, setDrag] = useState<PaneDragState | null>(null);
  const [pressing, setPressing] = useState(false);
  const [remoteOverlay, setRemoteOverlay] = useState<PaneDropTarget | null>(null);
  const [incomingToken, setIncomingToken] = useState<string | null>(null);
  const pressRef = useRef<PressState | null>(null);
  const dragRef = useRef<PaneDragState | null>(null);
  const dwellRef = useRef<{ tabId: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  // Cross-window broker (Phase 4, target-claims): the drag THIS window started.
  const globalSourceRef = useRef<GlobalSource | null>(null);
  const incomingTokenRef = useRef<string | null>(null);

  const applyDrag = useCallback((next: PaneDragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const clearDwell = useCallback(() => {
    if (dwellRef.current) {
      clearTimeout(dwellRef.current.timer);
      dwellRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    pressRef.current = null;
    clearDwell();
    applyDrag(null);
    setPressing(false);
    document.body.classList.remove('pane-dragging');
  }, [applyDrag, clearDwell]);

  // Always-on broker listeners. A cross-window drag is brokered by the backend:
  // the source registers it (pane-drag:active); whichever window the user releases
  // over CLAIMS it; the source is told to drop its pane (pane-drag:claimed).
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let active = true;
    const setup = async () => {
      try {
        const u1 = await listen('pane-drag:active', (ev: any) => {
          const token = ev?.payload;
          if (typeof token !== 'string') return;
          // Ignore our own drag — we're the source, not a drop target for it.
          if (globalSourceRef.current?.token === token) return;
          incomingTokenRef.current = token;
          setIncomingToken(token);
        });
        const u2 = await listen('pane-drag:claimed', (ev: any) => {
          const token = ev?.payload;
          const src = globalSourceRef.current;
          if (src && src.token === token) {
            // Another window took our pane; drop our copy (PTY stays alive there).
            removeSourcePane(src.sourceTabId, src.sourcePaneId, [src.terminalId]);
          }
        });
        const u3 = await listen('pane-drag:ended', () => {
          incomingTokenRef.current = null;
          setIncomingToken(null);
          setRemoteOverlay(null);
          globalSourceRef.current = null;
          // If this window was the source and never got its own pointerup
          // (the OS routed the release elsewhere), clean up its drag visuals.
          if (pressRef.current || dragRef.current) reset();
        });
        if (active) {
          unlisteners.push(u1, u2, u3);
        } else {
          u1(); u2(); u3();
        }
      } catch {
        // Not running under Tauri (e.g. webpack dev server) — broker unavailable.
      }
    };
    void setup();
    return () => {
      active = false;
      unlisteners.forEach((u) => u());
    };
  }, [reset]);

  // Target-side: while a cross-window drag is active and THIS window isn't the
  // source, show a drop overlay where the cursor is and claim on release.
  useEffect(() => {
    if (!incomingToken) return;
    const onTargetMove = (e: PointerEvent) => {
      const x = e.clientX, y = e.clientY;
      if (isOutside(x, y)) { setRemoteOverlay(null); return; }
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const paneEl = el?.closest('[data-pane-id]') as HTMLElement | null;
      if (!paneEl) { setRemoteOverlay(null); return; }
      const tabEl = paneEl.closest('[data-tab-id]') as HTMLElement | null;
      const r = paneEl.getBoundingClientRect();
      const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      setRemoteOverlay({
        tabId: tabEl?.getAttribute('data-tab-id') || '',
        paneId: paneEl.getAttribute('data-pane-id') || '',
        zone: computeZone(rect, x, y),
        rect,
      });
    };
    const onTargetUp = (e: PointerEvent) => {
      const x = e.clientX, y = e.clientY;
      setRemoteOverlay(null);
      if (isOutside(x, y)) return; // released outside this window — not our drop
      const token = incomingTokenRef.current;
      const api = window.electronAPI;
      if (!token || !api?.claimGlobalPaneDrag) return;
      api.claimGlobalPaneDrag(token).then((payload) => {
        if (payload) applyCrossWindowPayload(payload, x, y);
      }).catch((err) => console.error('claimGlobalPaneDrag failed', err));
    };
    window.addEventListener('pointermove', onTargetMove, true);
    window.addEventListener('pointerup', onTargetUp, true);
    return () => {
      window.removeEventListener('pointermove', onTargetMove, true);
      window.removeEventListener('pointerup', onTargetUp, true);
    };
  }, [incomingToken]);

  const beginPress = useCallback((e: React.PointerEvent, source: PaneDragSource) => {
    pressRef.current = { source, startX: e.clientX, startY: e.clientY, dragging: false };
    setPressing(true);
  }, []);

  // Source-side pointer tracking.
  useEffect(() => {
    if (!pressing) return;

    const resolveTarget = (x: number, y: number): PaneDropTarget | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const paneEl = el?.closest('[data-pane-id]') as HTMLElement | null;
      if (!paneEl) return null;
      const tabEl = paneEl.closest('[data-tab-id]') as HTMLElement | null;
      const paneId = paneEl.getAttribute('data-pane-id') || '';
      const tabId = tabEl?.getAttribute('data-tab-id') || '';
      const r = paneEl.getBoundingClientRect();
      const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      return { tabId, paneId, zone: computeZone(rect, x, y), rect };
    };

    const handleTabHover = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const tabBtn = el?.closest('[data-tab-target]') as HTMLElement | null;
      const tabId = tabBtn?.getAttribute('data-tab-target') || null;
      if (!tabId) {
        clearDwell();
        return;
      }
      if (dwellRef.current?.tabId === tabId) return;
      clearDwell();
      dwellRef.current = {
        tabId,
        timer: setTimeout(() => {
          dispatch(setActiveTab(tabId));
          dwellRef.current = null;
        }, DWELL_MS),
      };
    };

    const onMove = (e: PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;
      const x = e.clientX;
      const y = e.clientY;
      if (!press.dragging) {
        if (Math.hypot(x - press.startX, y - press.startY) < THRESHOLD) return;
        press.dragging = true;
        document.body.classList.add('pane-dragging');
      }
      const outsideWindow = isOutside(x, y);

      // The first time the cursor leaves this window, register a cross-window drag
      // so other windows know they can become a drop target.
      const api = window.electronAPI;
      if (outsideWindow && api?.beginGlobalPaneDrag && !globalSourceRef.current) {
        const s = press.source;
        const leaf: PaneNode = {
          id: s.sourcePaneId, type: 'terminal', terminalId: s.terminalId, name: s.name, shellType: s.shellType,
        };
        const token = newDetachToken();
        globalSourceRef.current = {
          token, sourceTabId: s.sourceTabId, sourcePaneId: s.sourcePaneId, terminalId: s.terminalId,
        };
        void api.beginGlobalPaneDrag(token, buildPaneDetachPayload(leaf, { x: e.clientX, y: e.clientY }));
      }

      const target = outsideWindow ? null : resolveTarget(x, y);
      if (!outsideWindow) handleTabHover(x, y);
      applyDrag({ source: press.source, pointer: { x, y }, target, outsideWindow });
    };

    const commitDrop = () => {
      const d = dragRef.current;
      if (!d || !d.target) return;
      const s = d.source;
      const t = d.target;
      if (t.paneId === s.sourcePaneId && t.tabId === s.sourceTabId) return; // dropped on self
      if (t.tabId && t.tabId === s.sourceTabId) {
        dispatch(movePaneWithinTab({
          tabId: s.sourceTabId, sourcePaneId: s.sourcePaneId, targetPaneId: t.paneId, zone: t.zone,
        }));
      } else if (t.tabId) {
        dispatch(movePaneToTab({
          sourceTabId: s.sourceTabId, sourcePaneId: s.sourcePaneId,
          targetTabId: t.tabId, targetPaneId: t.paneId, zone: t.zone,
        }));
        if (store.getState().panes.treesByTabId[s.sourceTabId] === undefined) {
          dispatch(removeTab(s.sourceTabId));
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      const wasDragging = pressRef.current?.dragging;
      const d = dragRef.current;
      const gs = globalSourceRef.current;
      if (wasDragging && d?.outsideWindow) {
        const api = window.electronAPI;
        // CLIENT coords (content-relative); the backend converts to physical
        // screen pixels via the source window's origin+scale. Screen coords are
        // unreliable (zeroed) in this webview.
        const sx = e.clientX;
        const sy = e.clientY;
        if (gs && api?.resolveOrphanGlobalDrag) {
          // Released outside this window. Give a destination window a moment to
          // claim it; if none does, it's an orphan -> open a new window.
          const { token, sourceTabId, sourcePaneId, terminalId } = gs;
          setTimeout(() => {
            // If a window already claimed it, globalSourceRef was cleared by the
            // pane-drag:claimed/ended listeners — nothing to do.
            if (globalSourceRef.current?.token !== token) return;
            api.resolveOrphanGlobalDrag!(token).then((orphan) => {
              if (orphan) {
                void api.createDetachedWindow?.(token, sx, sy);
                removeSourcePane(sourceTabId, sourcePaneId, [terminalId]);
                globalSourceRef.current = null;
              }
            }).catch((err) => console.error('resolveOrphanGlobalDrag failed', err));
          }, ORPHAN_DELAY_MS);
        } else if (!gs) {
          // No broker (not under Tauri): best-effort direct detach to a new window.
          const s = d.source;
          void detachPaneToNewWindow({
            sourceTabId: s.sourceTabId,
            paneNode: { id: s.sourcePaneId, type: 'terminal', terminalId: s.terminalId, name: s.name, shellType: s.shellType },
            cursor: { x: sx, y: sy },
          });
        }
      } else if (wasDragging) {
        commitDrop();
        if (gs) void window.electronAPI?.cancelGlobalPaneDrag?.(gs.token);
        globalSourceRef.current = null;
      }
      reset();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const gs = globalSourceRef.current;
        if (gs) void window.electronAPI?.cancelGlobalPaneDrag?.(gs.token);
        globalSourceRef.current = null;
        reset();
      }
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [pressing, dispatch, applyDrag, clearDwell, reset]);

  return (
    <PaneDragContext.Provider value={{ drag, beginPress }}>
      {children}
      {drag && drag.target && !drag.outsideWindow && <PaneDropOverlay target={drag.target} />}
      {/* Remote (cross-window) overlay only when this window isn't the drag source. */}
      {!drag && remoteOverlay && <PaneDropOverlay target={remoteOverlay} />}
      {drag && <PaneDragLayer drag={drag} />}
    </PaneDragContext.Provider>
  );
};
