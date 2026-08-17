import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { terminalCache } from '@termflow/terminal-core';
import { runningActivityTracker } from '../../services/RunningActivityTracker';
import { terminalService } from '../../services/TerminalService';
import { getAllLeafIds } from '../../store/slices/paneTreeOps';
import { RootState } from '../../store';
import {
  CanvasEdge, addEdge, focusNode, panViewport, removeEdge, selectEdge, selectNode, setEdges,
  setNearestGroup, setNodeGeom, setOverlayNode, setSidebarOpen,
} from '../../store/slices/canvasSlice';
import { focusPaneInTab } from '../../store/slices/panesSlice';
import { addTab, setActiveTab } from '../../store/slices/tabsSlice';
import { CanvasViewport, useFlyTo } from './CanvasViewport';
import { CanvasSidebar, ROW_FLY_ZOOM } from './CanvasSidebar';
import { CanvasGroupFrame } from './CanvasGroupFrame';
import { CanvasNode } from './CanvasNode';
import { NodeTerminal } from './NodeTerminal';
import { NodeSnapshot } from './NodeSnapshot';
import { snapshotCache } from './snapshotCache';
import {
  Rect, assignTiers, overlayGeometry, canvasMetrics, headScale, chromeScale, isFullyVisible,
  zoomAt, NODE_W, NODE_H, HEAD_H, Z_MIN,
} from './canvasGeometry';
import { CanvasMetricsContext } from './canvasMetricsContext';
import { measureHostBox, clearHostBoxes } from './canvasHostBoxes';
import { useCanvasDrag } from './useCanvasDrag';
import { useArrange } from './useArrange';
import { PortClick, useWireDrag } from './useWireDrag';
import { CanvasWires } from './CanvasWires';
import { CanvasWireMenu } from './CanvasWireMenu';
import { CanvasMenu, CanvasMenuItem } from './CanvasMenu';
import { CanvasProfileMenu } from './CanvasProfileMenu';
import { closeEventFor, decideCanvasClose } from './canvasClose';
import { planCanvasSpawn, spawnRectAt, spawnRectNear } from './canvasSpawn';
import { connectWhenReady } from './canvasConnect';
import { chipOffsets } from './groupChips';
import { worldPoint } from './canvasMutations';
import { ShellProfileLike } from '../../services/newTabActions';
import { neighbourhood } from './wireGeometry';
import { CanvasMinimap } from './CanvasMinimap';
import { CanvasBeacons } from './CanvasBeacons';
import { beaconLayout, nearestGroupToCentre, stepNodeId } from './orientation';
import { CanvasKey, canvasKeyAction, terminalKeyAction } from './canvasGestures';
import { boundsOf, centreOn, fitViewport } from './viewportStyles';
import { useCanvasRenderPolicy } from './useCanvasRenderPolicy';
import {
  CanvasNodeModel,
  selectCanvasModel, visibleNodeIds, allCollapsed, snapshotNodeIds, nodeRegistryPayload,
  GROUP_CHIP_ZOOM, NODE_CHIP_ZOOM,
} from './canvasSelectors';
import { createEdge, deleteEdge, fetchGraph, putNodes } from '../../services/canvasGraph';
import './Canvas.css';

/** How long the node registry waits for the model to settle. A group drag would otherwise
 *  publish once per `pointermove`. */
const PUBLISH_DEBOUNCE_MS = 250;

/**
 * How much of the viewport edge does NOT count as framed, when deciding whether a newly
 * created node needs flying to.
 *
 * Not zero: the toolbar sits top-right, the minimap bottom-right and the beacons on every
 * edge, so a node technically inside the viewport but flush against a side is underneath
 * canvas chrome. Sized to clear the minimap, which is the largest of them.
 */
const FRAME_INSET = 130;

/**
 * One press of a toolbar zoom button (Tam's item 4).
 *
 * 1.3, so a press is unmistakably a step rather than a nudge, and ~5 of them cross the working
 * range between the chip tier and 1:1. Deliberately coarser than the wheel, which is continuous
 * and reversible mid-gesture; a button is neither, so a step it takes several presses to notice
 * reads as a button that does not work.
 */
const ZOOM_STEP = 1.3;

/**
 * Anything on the canvas that owns <kbd>Tab</kbd> because it is a real, focusable control.
 *
 * Tab steps between TERMINALS only when the press lands on the canvas itself. Taking it
 * everywhere would strand a keyboard user: the sidebar search, the toolbar buttons and the
 * minimap are all reachable only by tabbing to them, and a canvas that swallowed the key would
 * be a surface you could enter and never leave.
 *
 * `[tabindex]` is what catches the minimap, which is a plain `div` made focusable — matching it
 * by class would have to be updated by whoever adds the next one, and would not be.
 */
const FOCUSABLE_CHROME = 'button, input, select, textarea, a[href], [tabindex]';

/**
 * Does this terminal still have a process?
 *
 * The same predicate `App.tsx` resolves a tab's exit with — `TerminalService` deletes the
 * mapping on `pty:exit`, so it goes false exactly when the PTY dies. Module-level because it
 * closes over nothing: a `useCallback` here would be a dependency on every hook that needs it,
 * for a function that can never change.
 */
const isTerminalAlive = (terminalId: string): boolean =>
  !!terminalService.getProcessIdForTerminal(terminalId);

/** The node geometry the stylesheet needs, as CSS variables rather than numbers repeated in
 *  Canvas.css. The host half is per-session — see `canvasMetrics` — so this is built from the
 *  frozen metrics rather than being a module constant. */
const geometryVars = (
  m: { hostW: number; hostH: number; surfaceScale: number },
  zoom: number,
) => ({
  '--canvas-node-w': `${NODE_W}px`,
  '--canvas-node-h': `${NODE_H}px`,
  '--canvas-head-h': `${HEAD_H}px`,
  '--canvas-host-w': `${m.hostW}px`,
  '--canvas-host-h': `${m.hostH}px`,
  '--canvas-surface-scale': `${m.surfaceScale}`,
  // The two counter-scales. Published ONCE at the root rather than inline on every node,
  // because both are functions of the zoom alone — nothing about them is per-node. That is
  // also what lets a GROUP FRAME use `--node-chrome-k`: frames are siblings of nodes, not
  // children, so a node-level variable could never have reached them, and the frame's border
  // was the one piece of canvas chrome still growing with the zoom.
  '--node-k': `${headScale(zoom)}`,
  '--node-chrome-k': `${chromeScale(zoom)}`,
}) as React.CSSProperties;

/**
 * Canvas Mode surface — the body of the canvas TAB.
 *
 * `TerminalContainer` mounts this only while that tab is active, so entering and leaving
 * the canvas is a tab switch. Every other tab stays mounted (hidden) throughout, which is
 * what lets terminals be handed back when you switch away. This amends design 010 D1,
 * which specified a full-surface overlay; see `backlog/007` §4.
 *
 * Every node in the workspace is rendered, and hosts a live terminal, for the whole
 * session regardless of tier or culling — see the note on `CanvasNode` for why that is
 * load-bearing rather than wasteful. Render policy is applied centrally by
 * `useCanvasRenderPolicy`, never per node.
 */
export const CanvasMode: React.FC = () => {
  const dispatch = useDispatch();
  const model = useSelector(selectCanvasModel);
  const vp = useSelector((s: RootState) => s.canvas.viewport);
  const selectedId = useSelector((s: RootState) => s.canvas.selectedId);
  const selectedEdgeId = useSelector((s: RootState) => s.canvas.selectedEdgeId);
  const focusedId = useSelector((s: RootState) => s.canvas.focusedId);
  const overlayId = useSelector((s: RootState) => s.canvas.overlayId);
  const recent = useSelector((s: RootState) => s.canvas.recent);
  const sidebarOpen = useSelector((s: RootState) => s.canvas.sidebarOpen);
  const edges = useSelector((s: RootState) => s.canvas.edges);
  const nearestGroupId = useSelector((s: RootState) => s.canvas.nearestGroupId);
  // For `closeNode` only — the pane COUNT per tab, which decides whether closing a node is a
  // pane close or a tab close. `selectCanvasModel` reads this too, so it is already a
  // subscription this tree pays for.
  const treesByTabId = useSelector((s: RootState) => s.panes.treesByTabId);
  // For `spawn` only, to keep a new terminal's title unique. Selects the ARRAY, not a mapped
  // copy of it: `s.tabs.tabs` is a stable reference between changes, whereas `.map(...)` in a
  // selector allocates a new array on every dispatch in the app and re-renders the canvas.
  const tabs = useSelector((s: RootState) => s.tabs.tabs);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [wireMenu, setWireMenu] = useState<{ edge: CanvasEdge; x: number; y: number } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ node: CanvasNodeModel; x: number; y: number } | null>(null);
  /**
   * The shell-profile menu, and where the terminal it creates should go.
   *
   * One slot for both spawn gestures (items 3 and 4): a right-click on empty canvas carries an
   * `at` and no source, a port click carries a `fromId` and no point. The two are mutually
   * exclusive by construction, which is why they are one nullable state and not two — two
   * would have a fourth, meaningless combination, and the day both were set the menu would
   * open twice.
   */
  const [spawnMenu, setSpawnMenu] = useState<
    { x: number; y: number; at: { x: number; y: number }; fromId?: undefined }
    | { x: number; y: number; at?: undefined; fromId: string }
    | null
  >(null);

  // FROZEN FOR THE SESSION, and the two things about that are both load-bearing.
  //
  // WHY it is per-session: the host box is also the box the overlay renders at 1:1, and one
  // constant cannot serve a 1366-wide laptop and a 4K panel — sized for one, the other gets
  // either a half-empty overlay or a half-size font. `canvasMetrics` sizes it from the display.
  //
  // WHY it is frozen: it IS the CSS box a live terminal is fitted to. Changing it while
  // terminals are relocated in is a `fit()`, a `term.resize()` and a SIGWINCH into every
  // ratatui/codex PTY on the canvas (`012` §6.5 RC2). A `useState` initialiser runs ONCE per
  // mount, during the first render — before any child registers a host — which is exactly the
  // window this has to land in. Do not turn this into a `useMemo` on `size`: that is the same
  // code with the guarantee removed, and it would re-evaluate on every window resize.
  //
  // Measured from the window rather than the canvas element because the element has not been
  // laid out yet at this point. It only picks the box; the overlay's own fit uses the real
  // measured viewport, so an approximation here costs nothing.
  const [metrics] = useState(() => canvasMetrics(
    typeof window === 'undefined' ? 1920 : window.innerWidth,
    typeof window === 'undefined' ? 1040 : window.innerHeight,
  ));
  const flyTo = useFlyTo();

  const onSize = useCallback((w: number, h: number) => setSize({ w, h }), []);

  const tiers = useMemo(() => {
    const rects: Record<string, Rect> = {};
    for (const n of model.nodes) rects[n.terminalId] = n.rect;
    return assignTiers({
      ids: model.nodes.map((n) => n.terminalId),
      rects,
      vp,
      vw: size.w,
      vh: size.h,
      focusedId,
      recent,
    });
  }, [model, vp, size, focusedId, recent]);

  const visible = useMemo(
    () => visibleNodeIds(model.nodes, vp, size.w, size.h),
    [model, vp, size],
  );

  const collapsed = allCollapsed(model.nodes, tiers, vp.z);

  /**
   * Keeps collapsed chips off each other.
   *
   * A chip counter-scales to a constant SCREEN size while its anchor is a WORLD position, so
   * the gap between two chips shrinks with the zoom while the chips do not — measured, two
   * adjacent groups are 46 screen px apart at z=0.1 against a 190px chip. Only computed while
   * collapsed, which is the only time a chip is rendered at all.
   */
  const chipNudge = useMemo(
    () => (collapsed ? chipOffsets(model.groups, vp.z) : {}),
    [collapsed, model.groups, vp.z],
  );

  // Whether a node PAINTS. Extracted because the wire mask and the node's own `hidden` prop
  // must agree exactly — a mask hole for a node that is not there shows the 30% ghost against
  // open canvas, in the shape of a node.
  const isHidden = useCallback(
    (id: string) => collapsed || (tiers[id] ?? 'group') === 'group' || !visible.has(id),
    [collapsed, tiers, visible],
  );

  // TWO rect maps, and the split is load-bearing (see `CanvasWiresProps`): geometry needs every
  // node so a wire to an off-screen one still draws, the mask needs only the ones that paint.
  const { wireRects, maskRects } = useMemo(() => {
    const all: Record<string, Rect> = {};
    const painted: Record<string, Rect> = {};
    for (const n of model.nodes) {
      all[n.terminalId] = n.rect;
      if (!isHidden(n.terminalId) && n.terminalId !== overlayId) painted[n.terminalId] = n.rect;
    }
    return { wireRects: all, maskRects: painted };
  }, [model.nodes, isHidden, overlayId]);

  // At the snapshot tier, on screen, and not swallowed by a whole-canvas collapse. The rule
  // lives in `canvasSelectors` so it can be tested — see `snapshotNodeIds` for why the
  // intersection with `visible` is load-bearing rather than an optimisation.
  const snapshotIds = useMemo(
    () => snapshotNodeIds(model.nodes, tiers, visible, collapsed),
    [model.nodes, tiers, visible, collapsed],
  );

  // Keep the cache to what is actually on screen. Snapshots are cheap to refetch, and an entry
  // per terminal in a large workspace is a screen's worth of ANSI each.
  useEffect(() => {
    snapshotCache.evictAllBut(Array.from(snapshotIds));
  }, [snapshotIds]);

  // Each terminal's own host box, captured from its PANE (`plan/017`).
  //
  // Read during RENDER, deliberately, because this is the only moment the question still has
  // the right answer: React renders a parent before its children, `NodeTerminal` registers its
  // host in a ref callback during the commit, and `useSurfaceRelocation`'s layout effect moves
  // `term.element` after that. By the time any effect runs, `term.element.parentElement` is the
  // canvas host and measuring it would measure our own replica. `measureHostBox` caches on the
  // first call and refuses to measure a container inside `.canvas-surface`, so both the double
  // render of StrictMode and a mistimed call are inert.
  const hostBoxes = useMemo(() => {
    const out: Record<string, { w: number; h: number }> = {};
    for (const n of model.nodes) {
      out[n.terminalId] = measureHostBox(n.terminalId, { w: metrics.hostW, h: metrics.hostH });
    }
    return out;
  }, [model.nodes, metrics]);

  // Frozen boxes outlive their session otherwise, and the next one may open on a different
  // window size, split layout or font.
  useEffect(() => () => clearHostBoxes(), []);

  // Recomputed from the viewport, so the overlay stays screen-centred while the canvas pans
  // and zooms underneath it rather than sliding away with the world.
  //
  // Sized from the OVERLAID TERMINAL's box, not the session's: under `plan/017` decision C the
  // overlay is that terminal at its actual size, so an unsplit tab's terminal fills the screen
  // and a quarter-split's fills a quarter. `surfaceScale` is recomputed from the same box so the
  // "not smaller than an ordinary node" floor inside `overlayGeometry` stays meaningful.
  const overlay = useMemo(() => {
    if (!overlayId) return null;
    const b = hostBoxes[overlayId];
    if (!b) return null;
    return overlayGeometry(vp, size.w, size.h, {
      hostW: b.w, hostH: b.h, surfaceScale: NODE_W / b.w,
    });
  }, [overlayId, vp, size, hostBoxes]);

  useCanvasRenderPolicy(tiers, focusedId, recent);

  // Node drag, group drag and cross-group re-homing (Tasks 11 + 12).
  const drag = useCanvasDrag(model);

  // Auto-arrange (Task 13). A button, never automatic — design 010 D10: a canvas that
  // rearranges itself while you are looking away destroys the spatial memory the whole
  // feature exists to build.
  const arrange = useArrange(model, edges);

  // Draw a connection out of a node port (Task 18).
  const wire = useWireDrag(model, useCallback((click: PortClick) => {
    // A port press that never moved: offer the profile list, and remember which node the new
    // terminal is being wired to. `useWireDrag` has already decided this was a click rather
    // than a drag — see `exceedsDragSlop`.
    setSpawnMenu({ x: click.x, y: click.y, fromId: click.fromId });
  }, []));

  // The graph is backend-owned; `canvasSlice.edges` is a mirror and is never persisted
  // renderer-side. Fetched once per canvas session — every later change goes through an
  // endpoint that returns the authoritative row, so there is nothing to poll for.
  useEffect(() => {
    let cancelled = false;
    void fetchGraph().then((graph) => {
      if (!cancelled && graph) dispatch(setEdges(graph.edges));
    });
    return () => { cancelled = true; };
  }, [dispatch]);

  // Publish the node→group registry — the half Task 17 could not own, because only the renderer
  // holds the titles. Until something publishes, `get_my_connections` and `get_my_terminal.node`
  // return null for every title and group, silently, which is what design §7.4.1 exists to
  // prevent. Debounced so a group drag does not publish per `pointermove`.
  const publishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (publishTimer.current) clearTimeout(publishTimer.current);
    publishTimer.current = setTimeout(() => {
      publishTimer.current = null;
      void putNodes(nodeRegistryPayload(model));
    }, PUBLISH_DEBOUNCE_MS);
    return () => {
      if (publishTimer.current) clearTimeout(publishTimer.current);
      publishTimer.current = null;
    };
  }, [model]);

  // Hover focus (design §5): dim everything more than one hop from the hovered node.
  //
  // Suppressed while a link is being dragged — that gesture has its own highlight, and dimming
  // the canvas underneath it would hide the very nodes the user is aiming at.
  const near = useMemo(
    () => (wire.linking ? null : neighbourhood(edges, hoveredId)),
    [edges, hoveredId, wire.linking],
  );

  // `pointerover`, not `pointerenter`: enter/leave do not bubble, so a delegated handler
  // never sees them. `over` fires on every crossing INCLUDING node → background, where the
  // target has no `.canvas-node` ancestor and this correctly resolves to null — one handler
  // for both directions, and no props threaded through `CanvasNode`.
  const onPointerOver = useCallback((e: React.PointerEvent) => {
    const id = (e.target as HTMLElement | null)
      ?.closest('.canvas-node')?.getAttribute('data-terminal-id') ?? null;
    setHoveredId(id);
  }, []);

  // Both edges of the canvas session relocate every terminal between two differently-sized
  // boxes, which SIGWINCHes every PTY and makes every TUI repaint. Without this the repaint
  // reads as real activity: the running sweep fires across the whole tab strip and a
  // notification pops, for output the user caused by switching to a tab.
  //
  // A layout effect, so the window is armed before the relocation the child hosts trigger can
  // produce anything; the cleanup covers the return trip the same way.
  useLayoutEffect(() => {
    runningActivityTracker.notifyViewChangeBurst();
    return () => runningActivityTracker.notifyViewChangeBurst();
  }, []);

  const clearSelection = useCallback(() => {
    // `selectNode(null)` clears the connection selection too — see `selectedEdgeId`. One
    // dispatch, so a press on empty canvas cannot leave half a selection behind.
    dispatch(selectNode(null));
    dispatch(focusNode(null));
  }, [dispatch]);

  /**
   * Remove a connection — where the ✕ badge and the Delete key both land. (The right-click
   * menu reaches the same two calls from inside `CanvasWireMenu`, which owns its own service
   * calls because it also edits the label.)
   *
   * The store is only touched once the SERVER has forgotten the row. An optimistic removal
   * looks identical for the rest of the session and then hands the user back their deleted wire
   * on the next restart, with nothing on screen to explain where it came from.
   */
  const dropEdge = useCallback((id: string) => {
    void deleteEdge(id).then((ok) => {
      if (ok) dispatch(removeEdge(id));
    });
  }, [dispatch]);

  // Double-click a node BODY to open it as the full-screen overlay.
  //
  // It used to fly the viewport to `FOCUS_ZOOM` and hand over the keyboard in place. That is
  // gone with the zoom ladder (see `FOCUS_ZOOM`): the canvas now stops short of 1:1, so there
  // is no longer a canvas zoom at which a click lands on the right cell — xterm 6 does not
  // divide pointer deltas by an ancestor transform. The overlay renders at exactly 1:1, so it
  // is both the bigger rung and the only one where input is correct. Nothing was lost:
  // typing in place was only ever accurate at that single zoom.
  const focusTerminal = useCallback((terminalId: string) => (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.canvas-node-body')) return;
    dispatch(setOverlayNode(terminalId));
  }, [dispatch]);

  // A frame after the overlay opens, so the pointer gate has lifted with `focused` and the
  // textarea is reachable. Tracked, because leaving Canvas Mode inside that frame would
  // otherwise pull focus into a terminal that is already back in its pane.
  const focusRaf = useRef<number | null>(null);
  useEffect(() => {
    if (!overlayId) return;
    if (focusRaf.current) cancelAnimationFrame(focusRaf.current);
    focusRaf.current = requestAnimationFrame(() => {
      focusRaf.current = null;
      terminalCache.get(overlayId)?.terminal.focus();
    });
  }, [overlayId]);

  // Leaving the canvas hands input back. This used to be a side effect of
  // `setCanvasEnabled(false)`; with the canvas a tab, the mode can be left in ways that
  // never reach a canvas action at all — a click in the tab strip, Ctrl+Tab, closing the
  // tab — so the unmount itself is the only reliable place to clear it. A stale
  // `focusedId` would keep granting a node the `gpu` tier (design 010 D8) from a canvas
  // nobody is looking at.
  useEffect(() => () => {
    if (focusRaf.current) cancelAnimationFrame(focusRaf.current);
    focusRaf.current = null;
    dispatch(focusNode(null));
    dispatch(setOverlayNode(null));
    // Same edge, same reason (design 010 §5.1). The tab strip's "you are here" marker means
    // "the group you are looking at"; there is no such group once the canvas is not on screen,
    // and a marker left behind would point at one from a canvas nobody is in.
    dispatch(setNearestGroup(null));
  }, [dispatch]);

  /**
   * Which group is under the viewport centre — the tab strip's marker (design 010 D9, §5.1).
   *
   * Written through Redux because `TabManager` lives inside `TitleBar` and this lives under
   * `.app-body`: two React trees that share only the store.
   *
   * The equality guard is load-bearing rather than tidy. `setViewport` fires once per
   * `pointermove` during a pan, and this effect runs on each — dispatching the SAME id every
   * frame would re-render every tab in the strip for the whole gesture.
   */
  useEffect(() => {
    const id = nearestGroupToCentre(model.groups, vp, size.w, size.h);
    if (id !== nearestGroupId) dispatch(setNearestGroup(id));
  }, [model.groups, vp, size, nearestGroupId, dispatch]);

  /** Frame the whole workspace.
   *
   *  Group rects, not node rects: a non-empty frame shrink-wraps its terminals (see
   *  `buildModel`), so their union already contains every node — and an EMPTIED group keeps its
   *  stored frame and is still part of the workspace, which a node-only union would drop. */
  const fitAll = useCallback(() => {
    const b = boundsOf(model.groups.map((g) => g.rect));
    if (b) flyTo(fitViewport(b, size.w, size.h, metrics.zMax));
  }, [model.groups, flyTo, size, metrics]);

  /** Frame the group you are working in — the selected node's, falling back to the one the
   *  marker is already pointing at, so the key always does something. */
  const fitGroup = useCallback(() => {
    const tabId = model.nodes.find((n) => n.terminalId === selectedId)?.tabId ?? nearestGroupId;
    const g = model.groups.find((x) => x.tabId === tabId);
    if (g) flyTo(fitViewport(g.rect, size.w, size.h, metrics.zMax));
  }, [model, selectedId, nearestGroupId, flyTo, size, metrics]);

  /** One arrow-key step, in screen pixels. Relative, so this callback never reads the viewport
   *  and stays referentially stable — see `panViewport` for why that matters to the listener
   *  below. */
  const panScreen = useCallback((dx: number, dy: number) => {
    dispatch(panViewport({ dx, dy }));
  }, [dispatch]);

  /** One press of a zoom button, about the middle of the viewport — the point the user is
   *  looking at, and the only anchor a button has (the wheel has the cursor). */
  const zoomStep = useCallback((factor: number) => {
    flyTo(zoomAt(vp, factor, size.w / 2, size.h / 2, metrics.zMax));
  }, [flyTo, vp, size, metrics]);

  /**
   * Ctrl/Cmd + `+`/`−`/`0` — the same three steps as the buttons, so a user who learns one
   * gets the other. `reset` goes to 1:1 by asking for the factor that lands there, rather than
   * writing `z: 1` directly, so it is anchored on the viewport centre like every other zoom.
   */
  const zoomKey = useCallback((intent: 'in' | 'out' | 'reset') => {
    zoomStep(intent === 'in' ? ZOOM_STEP : intent === 'out' ? 1 / ZOOM_STEP : 1 / vp.z);
  }, [zoomStep, vp.z]);

  /**
   * Tab / Shift+Tab step the selection through the terminals.
   *
   * Flown to only when it is not already framed, which is the same rule a spawn uses and for the
   * same reason: centring a node the user can already see yanks the viewport for nothing, and
   * doing it on every press of a key people hold down is worse. The zoom is left exactly where
   * they put it — this is "show me the next one", not "take me somewhere".
   */
  const stepNode = useCallback((dir: 1 | -1) => {
    const next = stepNodeId(model.nodes.map((n) => n.terminalId), selectedId, dir);
    if (!next) return;
    dispatch(selectNode(next));
    const n = model.nodes.find((x) => x.terminalId === next);
    if (n && !isFullyVisible(vp, n.rect, size.w, size.h, FRAME_INSET)) {
      flyTo(centreOn(n.rect, size.w, size.h, vp.z, metrics.zMax));
    }
  }, [model.nodes, selectedId, dispatch, vp, size, flyTo, metrics]);

  /**
   * Keys the CANVAS owns — while nothing has handed the keyboard to a terminal.
   *
   * Shift+1 / Shift+2 fit (design 010 §5), `E` enlarges the selected node (Tam's item 2) and the
   * arrows pan (item 3). They share one listener because they share one precondition, which is
   * the whole reason `focusedId` is checked here rather than inside the rules: a focused node has
   * a live terminal taking keystrokes, where `!`, `e` and an arrow are all just input. The rules
   * themselves have no business knowing that.
   *
   * A LOCAL listener rather than `InputHandler` shortcuts, for two independent reasons:
   * `InputHandler` matches on a canonicalised `event.key`, so `Shift+1` would be registered as
   * `Shift+1`, matched as `Shift+!`, and never fire; and being mounted is exactly the gate these
   * need, since `TerminalContainer` mounts this only while the canvas tab is active.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (focusedId) return;
      const action = canvasKeyAction(
        e as unknown as CanvasKey,
        { node: !!selectedId, edge: !!selectedEdgeId },
      );
      if (!action) return;

      // Two vetoes that need the DOM, so neither can live in the rule — and both are scoped to
      // the ONE action they are about, because a blanket bail on either element would take the
      // other keys with it.
      const el = e.target as HTMLElement | null;
      // The minimap owns its own arrows, at its own scale (`minimapPanStep`). This listener is
      // in the CAPTURE phase, so it runs BEFORE the minimap's React handler and stopping the
      // event there would be too late.
      if (action.do === 'pan' && el?.closest?.('.canvas-minimap')) return;
      // Tab is how a keyboard user reaches the search box, the toolbar and the minimap. It only
      // steps terminals when the press lands on the canvas ITSELF.
      if (action.do === 'step' && el?.closest?.(FOCUSABLE_CHROME)) return;

      e.preventDefault();
      e.stopPropagation();
      switch (action.do) {
        case 'fit': (action.target === 'all' ? fitAll : fitGroup)(); break;
        case 'overlay': dispatch(setOverlayNode(selectedId)); break;
        case 'step': stepNode(action.dir); break;
        case 'zoom': zoomKey(action.intent); break;
        case 'pan': panScreen(action.dx, action.dy); break;
        // Only reachable with a connection selected — `canvasKeyAction` resolves Delete to
        // nothing at all otherwise, so the `!` is the rule's guarantee rather than a hope.
        case 'delete-edge': dropEdge(selectedEdgeId!); break;
        default: {
          // Exhaustiveness, and the reason this is a switch rather than the if-chain it was:
          // the event is ALREADY consumed by the time we get here, so an unhandled action is a
          // key that is swallowed and does nothing — the most invisible failure this file has.
          // Adding a variant to `CanvasAction` without an arm is now a compile error.
          const unhandled: never = action;
          void unhandled;
        }
      }
    };
    // Capture phase, matching InputHandler's ownership of global shortcuts.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focusedId, fitAll, fitGroup, selectedId, selectedEdgeId, panScreen, stepNode, zoomKey,
    dropEdge, dispatch]);

  /** Off-screen running terminals (design §10). Suppression under the overlay belongs to the
   *  render gate below, which covers the minimap in the same breath — a second `overlayId`
   *  branch here would keep this list empty even if that gate were removed, hiding the fact
   *  that the gate is what does the work. */
  const beacons = useMemo(
    () => beaconLayout(model.nodes, vp, size.w, size.h),
    [model.nodes, vp, size],
  );

  /** A beacon click. The same destination a sidebar row click gets — it is the same gesture,
   *  "take me to that terminal" — so it shares `ROW_FLY_ZOOM` rather than picking a second one. */
  const flyToNode = useCallback((terminalId: string) => {
    const n = model.nodes.find((x) => x.terminalId === terminalId);
    if (!n) return;
    dispatch(selectNode(terminalId));
    flyTo(centreOn(n.rect, size.w, size.h, Math.max(vp.z, ROW_FLY_ZOOM), metrics.zMax));
  }, [model.nodes, dispatch, flyTo, size, vp.z, metrics]);

  /** A minimap click: pan to that world point, keeping the zoom the user chose. A zero-size
   *  rect is a point as far as `centreOn` is concerned. */
  const flyToWorld = useCallback((w: { x: number; y: number }) => {
    flyTo(centreOn({ x: w.x, y: w.y, w: 0, h: 0 }, size.w, size.h, vp.z, metrics.zMax));
  }, [flyTo, size, vp.z, metrics]);

  // Leave the canvas for the tab this node lives in, with the cursor on its own pane.
  // `focusPaneInTab` before `setActiveTab`, because the activation path RESTORES the
  // tab's remembered pane — writing `activePaneId` directly would be overwritten.
  const openAsTab = useCallback((tabId: string, paneId: string) => () => {
    dispatch(focusPaneInTab({ tabId, paneId }));
    dispatch(setActiveTab(tabId));
  }, [dispatch]);

  /**
   * Close a node's terminal by handing the request to the surface that owns it — see
   * `canvasClose.ts` for why the canvas decides pane-vs-tab and confirm-vs-force but performs
   * neither. `PaneManager` and `TabManager` are mounted for every tab while the canvas is up
   * (`TerminalContainer` renders them all), so the event always finds its owner.
   *
   * The pane COUNT is read from the tree, not from `model.nodes`: the model drops leaves that
   * have no terminal yet, and a tab mid-split has one of those.
   */
  const closeNode = useCallback((node: CanvasNodeModel) => {
    const panes = getAllLeafIds(treesByTabId[node.tabId] ?? null).length;
    const { type, detail } = closeEventFor(decideCanvasClose(node, panes, isTerminalAlive));
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }, [treesByTabId]);

  /**
   * Create a terminal from the canvas — Tam's items 3 and 4.
   *
   * **The order is the whole thing.** `buildCanvasModel` reads `canvas.nodes` for a stored rect
   * and seeds a position only when there is none, so the geometry has to be written BEFORE the
   * tab exists. Doing it the other way round races Task 8's seeding and shows a visible jump
   * from a seeded slot to the place the user actually pointed at. This is the same ordering
   * `App.tsx` uses for an agent-spawned terminal, and for the same reason.
   *
   * A renderer-created tab's root pane carries `terminalId === tab.id`, which is what makes the
   * new tab's id usable as the node id here, before any pane has been built.
   */
  const spawn = useCallback((profile: ShellProfileLike) => {
    const menu = spawnMenu;
    if (!menu) return;
    const source = menu.fromId
      ? model.nodes.find((n) => n.terminalId === menu.fromId)
      : undefined;
    // A port click on a node that vanished between press and release — its tab closed, its
    // pane was re-homed — has nowhere to fan from and nothing to connect to. Dropping the
    // spawn is right: half of what was asked for is a terminal wired to nothing.
    if (menu.fromId && !source) return;

    const rect = source
      ? spawnRectNear(source.rect, model.nodes.map((n) => n.rect),
          edges.filter((e) => e.from === source.terminalId).length)
      : spawnRectAt(menu.at!);

    const plan = planCanvasSpawn(profile, tabs.map((t) => t.title), rect);
    dispatch(setNodeGeom({ id: plan.tab.id, rect: plan.rect }));
    dispatch(addTab(plan.tab));

    // Select it, and bring it into view if it is not already framed — Tam's requested flow is
    // click port → create → connect → LOOK AT IT → type. A port spawn fans a full node-width
    // away from its parent, so at any working zoom it lands off screen about as often as not.
    //
    // Containment, not intersection (`isFullyVisible`): a node clipped by the right edge does
    // reach the viewport, and is still not something you can read.
    //
    // Guarded rather than unconditional, because the background spawn puts the node under the
    // cursor — flying to a node the user just placed where they were looking would yank the
    // viewport for nothing.
    dispatch(selectNode(plan.tab.id));
    if (!isFullyVisible(vp, plan.rect, size.w, size.h, FRAME_INSET)) {
      flyTo(centreOn(plan.rect, size.w, size.h, vp.z, metrics.zMax));
    }

    // Then the wire, if this came from a port. Server-minted id only, exactly as the drag path
    // does — an optimistic client id is never replaced, so a later delete would name a row
    // that does not exist and leave the real edge behind.
    //
    // NOT a bare `createEdge`: the endpoint 404s on a terminal it has not registered, and this
    // one is several async hops from existing. See `canvasConnect`.
    if (source) {
      void connectWhenReady(
        {
          isReady: isTerminalAlive,
          createEdge,
          wait: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: () => Date.now(),
        },
        source.terminalId,
        plan.tab.id,
      ).then((edge) => {
        if (edge) dispatch(addEdge(edge));
      });
    }
  }, [spawnMenu, model.nodes, edges, tabs, dispatch, vp, size, flyTo, metrics]);

  /**
   * Keys that get you OUT of a terminal — the mirror of the listener above, and gated on the
   * mirror condition.
   *
   * **Esc no longer closes the overlay (Tam's item 1).** It used to, and that quietly made Esc
   * unusable in the one place a terminal is shown at full size: vim, less, fzf and every menu in
   * codex want that key, and the canvas was eating it to shrink a window the user was working
   * in. So Esc is now handed straight through whenever an overlay is open, and
   * Ctrl/Cmd+Shift+E — a chord no TUI binds — is the way out.
   *
   * Esc keeps its other job. With no overlay open, a node can still be holding the keyboard
   * (closing the overlay deliberately does not blur, see `setOverlayNode`), and there Esc is
   * what hands it back.
   */
  useEffect(() => {
    if (!focusedId) return;
    const onKey = (e: KeyboardEvent) => {
      const action = terminalKeyAction(e as unknown as CanvasKey, !!overlayIdRef.current);
      // Completely untouched — no preventDefault, no stopPropagation — so it reaches the PTY.
      if (action === 'passthrough') return;
      e.preventDefault();
      e.stopPropagation();
      // Both exits blur first: xterm's keyboard sink is a real textarea that holds DOM focus,
      // and leaving it focused would keep every later keystroke inside a terminal the user has
      // just stepped out of — including the `E` that is supposed to bring the overlay back.
      (document.activeElement as HTMLElement | null)?.blur();
      if (action === 'leave') dispatch(setOverlayNode(null));
      dispatch(focusNode(null));
    };
    // Capture phase, matching InputHandler's ownership of global shortcuts.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focusedId, dispatch]);

  // Read through a ref inside the Esc handler above: that effect is keyed on `focusedId`, and
  // adding `overlayId` to its deps would tear down and re-register the capture-phase listener
  // every time the overlay opened or closed.
  const overlayIdRef = useRef<string | null>(null);
  overlayIdRef.current = overlayId;

  return (
    <CanvasMetricsContext.Provider value={metrics}>
    <div
      className={`canvas-mode${wire.linking ? ' linking' : ''}`}
      data-testid="canvas-mode"
      style={geometryVars(metrics, vp.z)}
      // Capture, so a press on a port becomes a link drag before the node's own pointerdown
      // selects it or the viewport starts a pan.
      onPointerDownCapture={wire.onPointerDownCapture}
      onPointerOver={onPointerOver}
      onPointerLeave={() => setHoveredId(null)}
    >
      {/* Before the viewport, so it takes the left edge — Task 15's resize handle goes between
          them. `size` is measured from `.canvas-viewport` itself, so the fly-to targets the
          space the canvas actually has rather than the whole window. */}
      {sidebarOpen && <CanvasSidebar model={model} vw={size.w} vh={size.h} />}
      <CanvasViewport
        onSize={onSize}
        onBackgroundPointerDown={clearSelection}
        // Item 3. The world point is resolved HERE rather than inside the viewport because the
        // conversion needs the current `vp`, and `e.currentTarget` is `.canvas-viewport` itself
        // — the box `worldPoint` must measure against, since `.canvas-world` sits at its origin
        // and the sidebar puts ~255px between that and the window.
        onBackgroundContextMenu={(e) => {
          const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setSpawnMenu({ x: e.clientX, y: e.clientY, at: worldPoint(e.clientX, e.clientY, box, vp) });
        }}
        // Screen-space, but in VIEWPORT coordinates rather than `.canvas-mode`'s — which is why
        // this is a slot on `CanvasViewport` and not a sibling of it like `.canvas-toolbar`.
        // See the prop's own note: the sidebar puts ~255px between the two origins.
        overlay={!overlayId ? (
          <>
            <CanvasBeacons beacons={beacons} onPick={flyToNode} />
            {model.groups.length > 0 && (
              <CanvasMinimap
                model={model}
                vp={vp}
                vw={size.w}
                vh={size.h}
                onPick={flyToWorld}
                // Already in screen pixels — the minimap sized the step against its own
                // projection, which is the only place that scale is known.
                onPan={panScreen}
              />
            )}
          </>
        ) : null}
      >
        {/* Before the frames and nodes in document order; the two layers place themselves
            around them by z-index (1 under, 8 over), not by where they sit here. */}
        <CanvasWires
          edges={edges}
          rects={wireRects}
          masked={maskRects}
          hoveredId={near ? hoveredId : null}
          selectedEdgeId={selectedEdgeId}
          // The same counter-scale the stylesheet publishes as `--node-chrome-k`. Passed as a
          // number because the handles are SVG geometry, and `r`/`transform` are attributes a
          // CSS variable cannot reach.
          chromeK={chromeScale(vp.z)}
          onWireClick={(edge) => dispatch(selectEdge(edge.id))}
          onWireDelete={(edge) => dropEdge(edge.id)}
          onWireContextMenu={(edge, e) => {
            e.preventDefault();
            e.stopPropagation();
            setWireMenu({ edge, x: e.clientX, y: e.clientY });
          }}
        />
        {wire.ghost && (
          <svg className="canvas-wires under" width={1} height={1} style={{ overflow: 'visible' }}>
            <path className="canvas-ghostwire" d={wire.ghost} />
          </svg>
        )}
        {model.groups.map((g) => (
          <CanvasGroupFrame
            key={g.tabId}
            group={g}
            zoom={vp.z}
            collapsed={collapsed}
            chipOffset={chipNudge[g.tabId]}
            dropTarget={drag.dropTabId === g.tabId}
            moving={drag.movingTabId === g.tabId}
            onLabelPointerDown={drag.onGroupLabelPointerDown(g.tabId)}
            onChipClick={() => flyTo(centreOn(g.rect, size.w, size.h, GROUP_CHIP_ZOOM, metrics.zMax))}
          />
        ))}
        {overlay && (
          // World-space, not screen-space: `.canvas-world` sets `will-change: transform` and
          // is therefore a stacking context, so a backdrop outside it could never sit between
          // the ordinary nodes and the overlaid one.
          <div
            className="canvas-overlay-backdrop"
            style={{
              left: overlay.backdrop.x, top: overlay.backdrop.y,
              width: overlay.backdrop.w, height: overlay.backdrop.h,
            }}
            onPointerDown={(e) => { e.stopPropagation(); dispatch(setOverlayNode(null)); }}
          />
        )}
        {model.nodes.map((n) => {
          const isOverlaid = overlay !== null && n.terminalId === overlayId;
          // The overlaid node is the SAME node with a different world rect — no second host,
          // no relocation, no fit. See `overlayGeometry`.
          const node = isOverlaid ? { ...n, rect: overlay!.rect } : n;
          const tier = isOverlaid ? 'gpu' : (tiers[n.terminalId] ?? 'group');
          return (
            <CanvasNode
              key={n.terminalId}
              node={node}
              tier={tier}
              zoom={vp.z}
              selected={selectedId === n.terminalId}
              focused={focusedId === n.terminalId}
              // Hover focus (design §5). The other half of `CanvasWires`'s heat: without it the
              // wires brighten against a canvas where nothing else changed.
              dimmed={near !== null && !near.has(n.terminalId)}
              linkTarget={wire.targetId === n.terminalId}
              // Culling reads the node's ORIGINAL rect, which for an overlaid node can be far
              // off screen — the overlay would then be hidden the moment you opened it.
              hidden={!isOverlaid && isHidden(n.terminalId)}
              overlaid={isOverlaid}
              hostBox={hostBoxes[n.terminalId]}
              onPointerDown={() => dispatch(selectNode(n.terminalId))}
              // The ORIGINAL rect, never the overlay's: dragging an overlaid node would
              // otherwise start from a screen-filling box and fling it across the world.
              onHeaderPointerDown={isOverlaid ? undefined : drag.onNodeHeaderPointerDown(n.terminalId, n.tabId, n.rect)}
              onDoubleClick={focusTerminal(n.terminalId)}
              onChipClick={() => flyTo(centreOn(n.rect, size.w, size.h, NODE_CHIP_ZOOM, metrics.zMax))}
              onOpenAsTab={openAsTab(n.tabId, n.paneId)}
              onOpenOverlay={() => dispatch(setOverlayNode(isOverlaid ? null : n.terminalId))}
              onClose={() => closeNode(n)}
              // `n`, never `node`: `node` is the overlay's inflated copy, and the menu needs the
              // terminal's identity, not its current rect.
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                dispatch(selectNode(n.terminalId));
                setNodeMenu({ node: n, x: e.clientX, y: e.clientY });
              }}
            >
              {/* RC4: mounted for EVERY node, at every tier, for the whole canvas
                  session. The tier ladder and the cull margin decide what a node
                  PAINTS; they never decide where `term.element` lives. */}
              <NodeTerminal terminalId={n.terminalId} focused={focusedId === n.terminalId} />
              {/* The exact opposite rule, and for the exact opposite reason: this one is
                  culled hard, because what it owns is a timer rather than a terminal. */}
              {snapshotIds.has(n.terminalId) && <NodeSnapshot terminalId={n.terminalId} />}
            </CanvasNode>
          );
        })}
      </CanvasViewport>
      {/* Screen-space chrome, deliberately OUTSIDE `CanvasViewport`: everything passed to it as
          a child lands inside `.canvas-world`, which pans, zooms and would need counter-scaling.
          Top-right because the sidebar (Task 14) owns the left edge and the minimap (Task 23)
          the bottom-right corner.

          Hidden while a node is overlaid. The overlay's backdrop lives in world space, so a
          button here paints over it — and it would then be the one spot on screen where a click
          does not dismiss the overlay, acting on a layout the user cannot see. */}
      {!overlayId && model.groups.length > 0 && (
        <div className="canvas-toolbar">
          {/* `sidebarOpen` is in `canvasSlice` and persisted by Task 22; without a control it
              would be a stored field permanently stuck at its initial value. */}
          <button
            type="button"
            className="canvas-tbtn"
            aria-pressed={sidebarOpen}
            onClick={() => dispatch(setSidebarOpen(!sidebarOpen))}
            title={sidebarOpen ? 'Hide the terminal list' : 'Show the terminal list'}
          >
            List
          </button>
          <button
            type="button"
            className="canvas-tbtn"
            onClick={arrange}
            title="Grid each group's terminals, then the groups themselves"
          >
            Arrange
          </button>
          {/* Viewport controls, separated from the two above because they do something to the
              VIEW rather than to the workspace. Tam's item 4. */}
          <span className="canvas-tsep" aria-hidden="true" />
          {/* Disabled at the clamps rather than left to no-op: `zoomAt` returns the same viewport
              once `clampZoom` bites, so without this the button would be indistinguishable from
              one that is broken. */}
          <button
            type="button"
            className="canvas-tbtn canvas-tbtn-icon"
            onClick={() => zoomStep(1 / ZOOM_STEP)}
            disabled={vp.z <= Z_MIN}
            // Named here because a `−` in a 27px box is the only clue the chord exists, and it
            // is the one people go looking for after learning the terminal's own font zoom.
            // "Ctrl" rather than a platform branch, matching every other shortcut hint in the
            // app (`TerminalPane`'s maximise button, the tab menu) — Cmd works too.
            title="Zoom out (Ctrl -)"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="canvas-tbtn canvas-tbtn-icon"
            onClick={() => zoomStep(ZOOM_STEP)}
            disabled={vp.z >= metrics.zMax}
            title="Zoom in (Ctrl +)"
            aria-label="Zoom in"
          >
            +
          </button>
          {/* The same destination Shift+1 flies to, through the same callback — a second "show
              me everything" that framed something slightly different would be worse than none. */}
          <button
            type="button"
            className="canvas-tbtn"
            onClick={fitAll}
            title="Zoom out until every terminal is on screen (Shift+1)"
          >
            View All
          </button>
        </div>
      )}
      {!model.nodes.length && !model.groups.length && (
        <div className="canvas-empty">No terminals yet</div>
      )}
      {wireMenu && (
        <CanvasWireMenu
          x={wireMenu.x}
          y={wireMenu.y}
          edge={wireMenu.edge}
          fromTitle={model.nodes.find((n) => n.terminalId === wireMenu.edge.from)?.title ?? 'gone'}
          toTitle={model.nodes.find((n) => n.terminalId === wireMenu.edge.to)?.title ?? 'gone'}
          onClose={() => setWireMenu(null)}
        />
      )}
      {nodeMenu && (
        <CanvasMenu x={nodeMenu.x} y={nodeMenu.y} onClose={() => setNodeMenu(null)}>
          <div className="context-menu-header">{nodeMenu.node.title}</div>
          <div className="context-menu-divider" />
          <CanvasMenuItem
            icon="✕"
            danger
            onClick={() => { setNodeMenu(null); closeNode(nodeMenu.node); }}
          >
            Close Terminal
          </CanvasMenuItem>
        </CanvasMenu>
      )}
      {spawnMenu && (
        <CanvasProfileMenu
          x={spawnMenu.x}
          y={spawnMenu.y}
          // The header is the only thing that tells the two gestures apart on screen, and they
          // do different things: one drops a terminal where you pointed, the other also wires
          // it to the node whose port you clicked.
          header={spawnMenu.fromId ? 'Connect a new terminal' : 'New terminal here'}
          onPick={spawn}
          onClose={() => setSpawnMenu(null)}
        />
      )}
    </div>
    </CanvasMetricsContext.Provider>
  );
};

export default CanvasMode;
