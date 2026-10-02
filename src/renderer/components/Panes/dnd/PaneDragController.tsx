import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { listen } from '@tauri-apps/api/event';
import { store, AppDispatch } from '../../../store';
import { movePaneWithinTab, movePaneToTab } from '../../../store/slices/panesSlice';
import { setActiveTab, removeTab } from '../../../store/slices/tabsSlice';
import { PaneNode } from '../../../store/slices/panesSlice';
import { computeZone } from './zone';
import { tabHasNoPanes, findLeaf, terminalIdentityOf } from '../../../store/slices/paneTreeOps';
import { PaneDragSource, PaneDragState, PaneDropTarget } from './types';
import { PaneDragLayer } from './PaneDragLayer';
import { PaneDropOverlay } from './PaneDropOverlay';
import {
  detachPaneToNewWindow,
  buildPaneDetachPayload,
  newDetachToken,
  applyCrossWindowPayload,
  stageDetachPayload,
  cancelDetachTransfer,
  waitDetachTransfer,
  captureDetachGesture,
  type DetachGesture,
  type SourceTransferReceipt,
} from './detach';
import { captureWorkspace, isCurrentWorkspace } from '../../../services/workspaceReplacement';
import { acceptsTransferNotice, paneIncarnations, type PaneCapture } from '../../../services/paneIncarnations';
import './dnd.css';

const THRESHOLD = 5; // px the pointer must travel before a press becomes a drag

/**
 * The leaf to hand another window, read from the LIVE pane tree.
 *
 * **Not rebuilt from `PaneDragSource`.** That struct carries only what the title bar
 * needed for the drag preview — `terminalId`, `name`, `shellType` — so a node assembled
 * from it silently arrived in the destination window without `sessionKey`,
 * `seededForTabId` or `notifyMuted`: a migrated pane's armed pty-host session orphaned,
 * a tab's ownership record destroyed, a muted pane unmuted. Review 170 finding 1, and
 * the same defect class as the split and swap paths.
 *
 * Reading the tree instead of widening `PaneDragSource` is deliberate: the tree is the
 * authority on what a pane holds, and a seventh terminal-bound field then travels with
 * no change here at all.
 *
 * The fallback covers only a source pane the tree cannot name, where losing the drag
 * outright would be worse than losing the extra fields — this is exactly the old
 * behaviour, kept for that one case rather than as the normal path.
 */
function leafForDrag(s: PaneDragSource): PaneNode {
  const live = findLeaf(store.getState().panes.treesByTabId[s.sourceTabId] ?? null, s.sourcePaneId);
  return {
    id: s.sourcePaneId,
    type: 'terminal',
    ...(live
      ? terminalIdentityOf(live)
      : { terminalId: s.terminalId, name: s.name, shellType: s.shellType }),
  };
}
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
  pi?: PaneCapture;
  gesture: DetachGesture;
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
  ready: Promise<boolean>;
}

async function cancelSourceDrag(source: GlobalSource): Promise<PaneCapture | undefined> {
  await source.ready;
  // End the UI broker before cancel releases the ownership record.
  await window.electronAPI?.cancelGlobalPaneDrag?.(source.token);
  await cancelDetachTransfer(source.token);
  return paneIncarnations.capture(source.terminalId, source.sourcePaneId);
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
  // A staged receipt survives ended/claimed notices and source pointer cleanup.
  const sourceReceiptsRef = useRef(new Map<string, SourceTransferReceipt>());
  const incomingTokenRef = useRef<string | null>(null);
  const claimAttemptRef = useRef<object | null>(null);

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
          const notice = ev?.payload;
          const token = notice?.token;
          if (!active || typeof token !== 'string') return;
          // Ignore our own drag — we're the source, not a drop target for it.
          if (globalSourceRef.current?.token === token || sourceReceiptsRef.current.has(token)) return;
          incomingTokenRef.current = token;
          setIncomingToken(token);
        });
        const u2 = await listen('pane-drag:claimed', (ev: any) => {
          const notice = ev?.payload;
          const token = notice?.token;
          const receipt = sourceReceiptsRef.current.get(token);
          if (receipt) {
            void acceptsTransferNotice(notice).then(async matches => {
              if (!matches) return;
              if (globalSourceRef.current?.token === token) {
                globalSourceRef.current = null;
                reset();
              }
              await waitDetachTransfer(token);
            }).catch(error => console.error('Pane transfer failed', error));
          }
        });
        const u3 = await listen('pane-drag:ended', (ev: any) => {
          const token = ev?.payload;
          if (typeof token === 'string' && token !== incomingTokenRef.current && token !== globalSourceRef.current?.token) return;
          if (typeof token !== 'string') return;
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
      claimAttemptRef.current = null;
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
      const workspace = captureWorkspace();
      const page = paneIncarnations;
      const attempt = {};
      claimAttemptRef.current = attempt;
      // The broker ends its advertisement before answering a successful claim.
      // Keep the attempt alive independently until its reply is consumed.
      api.claimGlobalPaneDrag(token).then((payload) => {
        if (payload && isCurrentWorkspace(workspace) && page === paneIncarnations && page.enabled
            && claimAttemptRef.current === attempt) return applyCrossWindowPayload(payload, x, y, token);
        if (!payload && incomingTokenRef.current === token) {
          incomingTokenRef.current = null;
          setIncomingToken(null);
          setRemoteOverlay(null);
        }
      }).catch((err) => console.error('claimGlobalPaneDrag failed', err)).finally(() => {
        if (claimAttemptRef.current === attempt) claimAttemptRef.current = null;
      });
    };
    window.addEventListener('pointermove', onTargetMove, true);
    window.addEventListener('pointerup', onTargetUp, true);
    return () => {
      window.removeEventListener('pointermove', onTargetMove, true);
      window.removeEventListener('pointerup', onTargetUp, true);
    };
  }, [incomingToken]);

  const beginPress = useCallback((e: React.PointerEvent, source: PaneDragSource) => {
    const leaf = findLeaf(store.getState().panes.treesByTabId[source.sourceTabId] ?? null, source.sourcePaneId);
    const gesture = captureDetachGesture(source.sourceTabId, leaf);
    if (!leaf || leaf.terminalId !== source.terminalId || !gesture.current()) return;
    pressRef.current = { source, gesture, pi: paneIncarnations.capture(source.terminalId, source.sourcePaneId), startX: e.clientX, startY: e.clientY, dragging: false };
    setPressing(true);
  }, []);

  // Source-side pointer tracking.
  useEffect(() => {
    if (!pressing) return;
    const workspace = pressRef.current!.gesture.source.workspace;

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
          if (isCurrentWorkspace(workspace) && store.getState().tabs.tabs.some(tab => tab.id === tabId)) dispatch(setActiveTab(tabId));
          dwellRef.current = null;
        }, DWELL_MS),
      };
    };

    const onMove = (e: PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;
      if (!press.gesture.current()) { reset(); return; }
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
        const leaf = leafForDrag(s);
        const token = newDetachToken();
        const source: GlobalSource = {
          token, sourceTabId: s.sourceTabId, sourcePaneId: s.sourcePaneId, terminalId: s.terminalId,
          ready: Promise.resolve(false),
        };
        globalSourceRef.current = source;
        // `s.sourceTabId` so a pane dropped into another WINDOW keeps its group colour, exactly
        // as `detachPaneToNewWindow` does. Both callers build the same payload; a colour passed
        // by only one of them would depend on how the pane happened to leave the window.
        const payload = buildPaneDetachPayload(leaf, { x: e.clientX, y: e.clientY }, s.sourceTabId);
        source.ready = stageDetachPayload(token, payload, press.gesture).then(async receipt => {
          sourceReceiptsRef.current.set(token, receipt);
          void receipt.completion.finally(() => {
            if (sourceReceiptsRef.current.get(token) === receipt) sourceReceiptsRef.current.delete(token);
          }).catch(error => console.error('Pane transfer failed', error));
          if (!press.gesture.current() || globalSourceRef.current !== source) {
            await cancelDetachTransfer(token);
            return false;
          }
          await api.beginGlobalPaneDrag!(token);
          return true;
        }).catch(async error => {
          await cancelDetachTransfer(token);
          if (globalSourceRef.current === source) globalSourceRef.current = null;
          console.error('Could not stage pane drag', error);
          return false;
        });
      }

      const target = outsideWindow ? null : resolveTarget(x, y);
      if (!outsideWindow) handleTabHover(x, y);
      applyDrag({ source: press.source, pointer: { x, y }, target, outsideWindow });
    };

    const commitDrop = (d: PaneDragState | null, sourcePi?: PaneCapture, targetPi?: PaneCapture) => {
      if (!d || !d.target) return;
      const s = d.source;
      const t = d.target;
      if (!isCurrentWorkspace(workspace)) return;
      const source = findLeaf(store.getState().panes.treesByTabId[s.sourceTabId] ?? null, s.sourcePaneId);
      const target = findLeaf(store.getState().panes.treesByTabId[t.tabId] ?? null, t.paneId);
      if (source?.terminalId !== s.terminalId || !target) return;
      if (paneIncarnations.enabled && (!sourcePi || paneIncarnations.capture(s.terminalId, s.sourcePaneId) !== sourcePi
          || !targetPi || paneIncarnations.capture(target.terminalId!, t.paneId) !== targetPi)) return;
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
        // A tab-strip drag that empties its source still closes it. `tabHasNoPanes` owns
        // the rule; an emptied tab now keeps its key holding null rather than being deleted.
        if (tabHasNoPanes(store.getState().panes.treesByTabId, s.sourceTabId)) {
          dispatch(removeTab(s.sourceTabId));
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      const press = pressRef.current;
      if (press && !press.gesture.current()) { reset(); return; }
      const wasDragging = press?.dragging;
      const d = dragRef.current;
      const sourcePi = pressRef.current?.pi;
      const target = d?.target ? findLeaf(store.getState().panes.treesByTabId[d.target.tabId] ?? null, d.target.paneId) : null;
      const targetPi = target?.terminalId ? paneIncarnations.capture(target.terminalId, target.id) : undefined;
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
          const { token } = gs;
          setTimeout(() => {
            // The advertisement may have ended while its take receipt is pending.
            gs.ready.then(ready => ready && sourceReceiptsRef.current.has(token) ? api.resolveOrphanGlobalDrag!(token) : false).then(async (orphan) => {
              if (orphan) await api.createDetachedWindow?.(token, sx, sy);
              await waitDetachTransfer(token);
              if (globalSourceRef.current === gs) globalSourceRef.current = null;
            }).catch(async (err) => {
              await cancelDetachTransfer(token);
              console.error('resolveOrphanGlobalDrag failed', err);
            });
          }, ORPHAN_DELAY_MS);
        } else if (!gs) {
          // No broker (not under Tauri): best-effort direct detach to a new window.
          const s = d.source;
          void detachPaneToNewWindow({
            sourceTabId: s.sourceTabId,
            paneNode: leafForDrag(s),
            cursor: { x: sx, y: sy },
            gesture: press?.gesture,
          });
        }
      } else if (wasDragging) {
        if (gs) void cancelSourceDrag(gs).then(pi => commitDrop(d, pi, targetPi)).catch(error => console.error('Pane drag rollback failed', error));
        else commitDrop(d, sourcePi, targetPi);
        globalSourceRef.current = null;
      }
      reset();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const gs = globalSourceRef.current;
        if (gs) void cancelSourceDrag(gs).catch(error => console.error('Pane drag rollback failed', error));
        globalSourceRef.current = null;
        reset();
      }
    };

    const unsubscribe = store.subscribe(() => {
      const press = pressRef.current;
      if (press && !press.gesture.current()) {
        const gs = globalSourceRef.current;
        if (gs) void cancelSourceDrag(gs).catch(error => console.error('Pane drag rollback failed', error));
        globalSourceRef.current = null;
        reset();
      }
    });
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      unsubscribe();
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
