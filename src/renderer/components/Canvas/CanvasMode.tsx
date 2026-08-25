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
import { addTabTree, focusPaneInTab } from '../../store/slices/panesSlice';
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
  aimedNodeRect,
  paintedNodeRect, zoomAt, NODE_W, NODE_H, HEAD_H, Z_MIN,
} from './canvasGeometry';
import { CanvasMetricsContext } from './canvasMetricsContext';
import { measureHostBox, clearHostBoxes } from './canvasHostBoxes';
import { useCanvasDrag } from './useCanvasDrag';
import { useArrange } from './useArrange';
import { PortClick, useWireDrag } from './useWireDrag';
import { CanvasWires } from './CanvasWires';
import { CanvasWireMenu } from './CanvasWireMenu';
import { CanvasNodeMenu } from './CanvasNodeMenu';
import { CanvasGroupMenu } from './CanvasGroupMenu';
import { CanvasProfileMenu } from './CanvasProfileMenu';
import { closeEventFor, closeEndedRequests, decideCanvasClose } from './canvasClose';
import { planCanvasSpawn, spawnRectAt, spawnRectNear } from './canvasSpawn';
import { connectWhenReady } from './canvasConnect';
import { chipOffsets } from './groupChips';
import { worldPoint } from './canvasMutations';
import { ShellProfileLike } from '../../services/newTabActions';
import { neighbourhood } from './wireGeometry';
import { CanvasMinimap } from './CanvasMinimap';
import { CanvasBeacons } from './CanvasBeacons';
import { beaconLayout, nearestGroupToCentre, stepNodeId } from './orientation';
import { CanvasCombos, CanvasKey, canvasKeyAction, terminalKeyAction } from './canvasGestures';
import { effectiveCombo } from '../../services/shortcutActions';
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
  // Read ONCE here and passed down, not subscribed to per node — see `CanvasNode`'s prop doc.
  const busyCue = useSelector((s: RootState) => s.settings.canvasBusyCue);
  // Session-closed state and the terminal font size, for the overlay's banner (`plan/024` Req 4).
  // Read once here for the same reason as `busyCue`: a per-node subscription would wake every
  // node on every change. The MAP is selected, never a per-node object — `NodeTerminal` is
  // memoised on prop identity, so each node must receive the store's own stable reference.
  const sessionExitByTerminalId = useSelector((s: RootState) => s.sessionExit.byTerminalId);
  const terminalFontSize = useSelector((s: RootState) => s.settings.fontSize);
  // For `closeNode` only — the pane COUNT per tab, which decides whether closing a node is a
  // pane close or a tab close. `selectCanvasModel` reads this too, so it is already a
  // subscription this tree pays for.
  const treesByTabId = useSelector((s: RootState) => s.panes.treesByTabId);
  // For `spawn` only, to keep a new terminal's title unique. Selects the ARRAY, not a mapped
  // copy of it: `s.tabs.tabs` is a stable reference between changes, whereas `.map(...)` in a
  // selector allocates a new array on every dispatch in the app and re-renders the canvas.
  const tabs = useSelector((s: RootState) => s.tabs.tabs);
  /**
   * The canvas's six user-assignable combos (Settings > Shortcuts > Canvas Mode).
   *
   * Resolved here rather than inside the rules so the pure layer stays pure, and memoised on the
   * overrides object alone — `effectiveCombo` falls back to each action's default, so the
   * identity of this object changes only when the user actually rebinds something. That matters:
   * it is in the dependency list of BOTH capture-phase key listeners below, and a fresh object
   * every render would tear down and re-register them on every frame of canvas output.
   * (`customKeybindings` is a stable reference between changes; `InputHandler`'s own store
   * subscription already depends on that same property.)
   *
   * The `?? ''` is NOT a default — the defaults live in the registry and `effectiveCombo` already
   * returns them. It is only reachable when an action id here does not exist, and `''` is chosen
   * over a plausible literal deliberately: `matchesCombo('')` matches nothing, so a typo shows up
   * as a dead key rather than as a shortcut quietly bound to something that looks right. The six
   * ids are pinned against the registry in `canvasKeysWiring.test.ts`.
   */
  const customKeybindings = useSelector((s: RootState) => s.settings.customKeybindings);
  const combos = useMemo<CanvasCombos>(() => ({
    enlarge: effectiveCombo('canvasEnlargeNode', customKeybindings) ?? '',
    openTab: effectiveCombo('canvasOpenNodeTab', customKeybindings) ?? '',
    leaveTerminal: effectiveCombo('canvasLeaveTerminal', customKeybindings) ?? '',
    openTabFromOverlay: effectiveCombo('canvasOpenNodeTabFromOverlay', customKeybindings) ?? '',
    arrange: effectiveCombo('canvasArrange', customKeybindings) ?? '',
    toggleList: effectiveCombo('canvasToggleList', customKeybindings) ?? '',
  }), [customKeybindings]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [wireMenu, setWireMenu] = useState<{ edge: CanvasEdge; x: number; y: number } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ node: CanvasNodeModel; x: number; y: number } | null>(null);
  /** The group menu's target — a group IS a tab, so the identity it carries is the tab's, and
   *  `title` is only the seed the rename box opens with. */
  const [groupMenu, setGroupMenu] = useState<{ tabId: string; title: string; x: number; y: number } | null>(null);
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

  /**
   * Is this canvas still on screen?
   *
   * Read by fire-and-forget work that outlives a render — `connectWhenReady` polls for up to
   * ten seconds — so it can stop instead of finishing against a canvas that has gone. A ref
   * rather than state: nothing renders from it, and a setState on unmount is the bug this
   * exists to avoid, not a way to express it.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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
  //
  // Both are DRAWN rects, never layout rects. A node is shorter than its `rect` above zoom 1
  // (`paintedNodeRect`), and `portPoint` puts the south port at the rect's bottom edge — so
  // wires used to leave from a point in the empty space below the node, while the `.canvas-port`
  // dot the user grabs is laid out by CSS on the drawn box. Tam: *"at a certain zoom level, the
  // connection point doesn't touch the terminal at the bottom."* Feeding the drawn box in fixes
  // all four faces at once, because east and west are centred on the same height.
  const { wireRects, maskRects } = useMemo(() => {
    const all: Record<string, Rect> = {};
    const painted: Record<string, Rect> = {};
    for (const n of model.nodes) {
      const box = paintedNodeRect(n.rect, vp.z, tiers[n.terminalId] === 'chip');
      all[n.terminalId] = box;
      if (!isHidden(n.terminalId) && n.terminalId !== overlayId) painted[n.terminalId] = box;
    }
    return { wireRects: all, maskRects: painted };
  }, [model.nodes, tiers, vp.z, isHidden, overlayId]);

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
  const wire = useWireDrag(wireRects, useCallback((click: PortClick) => {
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

  /**
   * The one way to close the overlay — backdrop, header toggle and Ctrl+Shift+E all land here.
   *
   * There used to be three closes and only the keyboard one gave the keyboard back, which is
   * the whole of the bug Tam reported as "E only works once": the pointer paths left
   * `focusedId` set, the canvas-key listener below opens with `if (focusedId) return`, and the
   * canvas went deaf to every key it owns until you clicked empty space. `setOverlayNode` now
   * releases input ownership in the STORE, so this callback exists for the half a reducer
   * cannot reach — the caret.
   *
   * xterm's keyboard sink is a real textarea. Left focused, it keeps every later keystroke
   * inside a terminal the user has just shrunk back to a node, and `openOverlayShortcut`
   * refuses an editable target — so the `E` meant to bring the overlay back would be swallowed
   * by the very terminal it was aimed at.
   */
  const closeOverlay = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    dispatch(setOverlayNode(null));
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
  //
  // `overlayId` is deliberately NOT cleared here (`plan/020` §4), and the difference between
  // the two is the point. `focusedId` is INPUT OWNERSHIP, which the canvas gives up the moment
  // it leaves the screen. `overlayId` is WHICH NODE IS ENLARGED — a view fact of this tab, no
  // more transient than the viewport or the node geometry sitting beside it in this slice, and
  // clearing it made every tab switch throw away an overlay the user had opened on purpose.
  // A node that dies while the canvas is away still takes its overlay with it: the prune in
  // `pruneCanvas` owns that, which is the right place for "the terminal is gone".
  useEffect(() => () => {
    if (focusRaf.current) cancelAnimationFrame(focusRaf.current);
    focusRaf.current = null;
    dispatch(focusNode(null));
    // Same edge, same reason (design 010 §5.1). The tab strip's "you are here" marker means
    // "the group you are looking at"; there is no such group once the canvas is not on screen,
    // and a marker left behind would point at one from a canvas nobody is in.
    dispatch(setNearestGroup(null));
  }, [dispatch]);

  // The other half of that split (`plan/020` §4). Coming back with `overlayId` set but
  // `focusedId` cleared would restore the overlay as a picture: `NodeTerminal`'s pointer gate
  // stays shut without `focused`, so the terminal under it takes neither keys nor clicks — the
  // "overlay you cannot type into is a screenshot" case `setOverlayNode` already names.
  //
  // Read from a ref so this runs once, on the way in, with the value the canvas was left with.
  // Not focus theft: the user just activated this tab, and the effect above has already put the
  // caret in that terminal a frame later.
  const overlayAtMount = useRef(overlayId);
  useEffect(() => {
    if (overlayAtMount.current) dispatch(focusNode(overlayAtMount.current));
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
    // `aimedNodeRect`, not `n.rect`: both calls POINT at the node, and the reserved rect
    // carries up to a title bar of slack the node does not paint. Testing it made a fully
    // visible node near the bottom edge report as clipped and fly for nothing.
    if (n && !isFullyVisible(vp, aimedNodeRect(n.rect, vp.z), size.w, size.h, FRAME_INSET)) {
      flyTo(centreOn(aimedNodeRect(n.rect, vp.z), size.w, size.h, vp.z, metrics.zMax));
    }
  }, [model.nodes, selectedId, dispatch, vp, size, flyTo, metrics]);

  /**
   * Every node, read through a ref by the two key listeners below.
   *
   * A ref rather than a dependency for the reason `overlayIdRef` is one: `model.nodes` gets a new
   * identity on every frame of terminal output, and putting it in either effect's dep list would
   * tear down and re-register a capture-phase `keydown` listener at that rate — including while a
   * keypress is in flight.
   */
  const nodesRef = useRef(model.nodes);
  nodesRef.current = model.nodes;

  // Leave the canvas for the tab this node lives in, with the cursor on its own pane.
  // `focusPaneInTab` before `setActiveTab`, because the activation path RESTORES the
  // tab's remembered pane — writing `activePaneId` directly would be overwritten.
  //
  // Declared ABOVE the key listeners deliberately: a `useEffect` dependency array is evaluated
  // during render, so an effect listing this while it was still declared further down the
  // component would throw on the temporal dead zone rather than merely reading a stale value.
  const openAsTab = useCallback((tabId: string, paneId: string) => () => {
    dispatch(focusPaneInTab({ tabId, paneId }));
    dispatch(setActiveTab(tabId));
  }, [dispatch]);

  /**
   * The same departure, addressed by TERMINAL id — what both keyboard paths have in hand.
   *
   * Routed through `openAsTab` rather than dispatching the pair itself, so there is exactly one
   * implementation of "leave the canvas for a node's tab" behind the header button and both
   * shortcuts. Two copies would be free to drift on the part that is easy to get wrong, which is
   * the ORDER of the two dispatches.
   *
   * **The lookup is by `terminalId` and nothing else.** Both callers hold one — `selectedId` and
   * `overlayId` are terminal ids (`setOverlayNode(n.terminalId)`) — while the value this needs to
   * ACT on is the node's `tabId`/`paneId`. Those three id spaces are all bare strings, so a
   * lookup against the wrong field would type-check and quietly address another node.
   */
  const openTabForTerminal = useCallback((terminalId: string | null) => {
    if (!terminalId) return;
    const n = nodesRef.current.find((x) => x.terminalId === terminalId);
    if (n) openAsTab(n.tabId, n.paneId)();
  }, [openAsTab]);

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
        combos,
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
        // Only reachable with a node selected — `canvasKeyAction` resolves this to nothing at
        // all otherwise, so the key is left alone rather than flying the user to a tab they
        // never chose.
        case 'open-tab': openTabForTerminal(selectedId); break;
        case 'step': stepNode(action.dir); break;
        case 'zoom': zoomKey(action.intent); break;
        case 'pan': panScreen(action.dx, action.dy); break;
        // Only reachable with a connection selected — `canvasKeyAction` resolves Delete to
        // nothing at all otherwise, so the `!` is the rule's guarantee rather than a hope.
        case 'delete-edge': dropEdge(selectedEdgeId!); break;
        // The keyboard halves of the toolbar's Arrange and List buttons — Tam, 2026-08-24.
        case 'arrange': arrange(); break;
        case 'toggle-list': dispatch(setSidebarOpen(!sidebarOpen)); break;
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
    dropEdge, dispatch, combos, openTabForTerminal, arrange, sidebarOpen]);

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
    // The DESTINATION zoom, in both places: the drawn height is a function of the zoom the
    // camera arrives at, not the one it leaves from.
    const z = Math.max(vp.z, ROW_FLY_ZOOM);
    flyTo(centreOn(aimedNodeRect(n.rect, z), size.w, size.h, z, metrics.zMax));
  }, [model.nodes, dispatch, flyTo, size, vp.z, metrics]);

  /** A minimap click: pan to that world point, keeping the zoom the user chose. A zero-size
   *  rect is a point as far as `centreOn` is concerned. */
  const flyToWorld = useCallback((w: { x: number; y: number }) => {
    flyTo(centreOn({ x: w.x, y: w.y, w: 0, h: 0 }, size.w, size.h, vp.z, metrics.zMax));
  }, [flyTo, size, vp.z, metrics]);

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
   * Close every node whose session has already ended — the toolbar's Close Ended button, Tam's
   * ask 2026-08-24. See `closeEndedRequests` for why this is safe to fire as a batch: grouping by
   * tab before deciding is what lets a multi-pane tab with several ended siblings close correctly
   * without re-reading live state between dispatches.
   */
  const closeAllEnded = useCallback(() => {
    const ended = model.nodes.filter((n) => n.exited);
    const panesInTab = (tabId: string) => getAllLeafIds(treesByTabId[tabId] ?? null).length;
    closeEndedRequests(ended, panesInTab, isTerminalAlive).forEach((req) => {
      const { type, detail } = closeEventFor(req);
      window.dispatchEvent(new CustomEvent(type, { detail }));
    });
  }, [model.nodes, treesByTabId]);

  /**
   * Create a terminal from the canvas — Tam's items 3 and 4.
   *
   * **The order is the whole thing.** `buildCanvasModel` reads `canvas.nodes` for a stored rect
   * and seeds a position only when there is none, so the geometry has to be written BEFORE the
   * tab exists. Doing it the other way round races Task 8's seeding and shows a visible jump
   * from a seeded slot to the place the user actually pointed at. This is the same ordering
   * `App.tsx` uses for an agent-spawned terminal, and for the same reason.
   *
   * **The node id is `plan.leafId`, never `plan.tab.id`.** This used to be the tab id, and that
   * worked only because a renderer-created tab's root pane carried `terminalId === tab.id`.
   * Design 014 mints a `tm-` leaf for every root, so the tab id now addresses no node at all —
   * the geometry would land under a key nothing reads, the selection would match nothing, and
   * `connectWhenReady` would wait out its full timeout for a terminal that never registers.
   * `planCanvasSpawn` mints the leaf up front precisely so it is knowable here, before any pane
   * has been built, and ships the tree that carries it (installed with `addTabTree` below, so
   * `planSeeds` does not manufacture a second root under a leaf we never saw).
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
    dispatch(setNodeGeom({ id: plan.leafId, rect: plan.rect }));
    dispatch(addTab(plan.tab));
    dispatch(addTabTree({ tabId: plan.tab.id, tree: plan.tree }));

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
    dispatch(selectNode(plan.leafId));
    if (!isFullyVisible(vp, aimedNodeRect(plan.rect, vp.z), size.w, size.h, FRAME_INSET)) {
      flyTo(centreOn(aimedNodeRect(plan.rect, vp.z), size.w, size.h, vp.z, metrics.zMax));
    }

    // Open it as the overlay right away — a spawned shell is exactly the terminal the user is
    // about to type into, so hand it the keyboard instead of leaving it a node they still have
    // to double-click. `setOverlayNode` also sets `focusedId`, and the `focusRaf` effect above
    // puts the caret in it a frame later.
    dispatch(setOverlayNode(plan.leafId));

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
          // Stop polling if the canvas is unmounted while we wait. Without this the loop
          // ran its full ten seconds against a screen nobody is looking at and then wired
          // the pair anyway.
          abandoned: () => !mounted.current,
        },
        source.terminalId,
        plan.leafId,
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
   * Esc's OTHER job — releasing a node that holds the keyboard with no overlay open — is
   * currently unreachable, and deliberately kept anyway. It relied on closing the overlay
   * leaving `focusedId` set; that was the "E only works once" bug and `setOverlayNode` no
   * longer does it, so `focusedId` is now non-null only while `overlayId` is. The arm stays
   * because `terminalKeyAction` is a tested pure function and deleting the branch would drag
   * its `overlayOpen` parameter — and with it the load-bearing "Esc reaches the PTY" rule —
   * along behind it. Whether focus should ever exist without an overlay is a design question,
   * not something to settle by quietly deleting the only code that would serve it.
   */
  useEffect(() => {
    if (!focusedId) return;
    const onKey = (e: KeyboardEvent) => {
      const action = terminalKeyAction(e as unknown as CanvasKey, !!overlayIdRef.current, combos);
      // Completely untouched — no preventDefault, no stopPropagation — so it reaches the PTY.
      // This is the arm a bare `T` lands on, which is Tam's requirement from the inside: while a
      // node is being edited, the letter is the shell's.
      if (action === 'passthrough') return;
      e.preventDefault();
      e.stopPropagation();
      // Both exits blur first: xterm's keyboard sink is a real textarea that holds DOM focus,
      // and leaving it focused would keep every later keystroke inside a terminal the user has
      // just stepped out of — including the `E` that is supposed to bring the overlay back.
      // `closeOverlay` owns that blur for the leave path; the release-focus arm below, which
      // closes nothing, still does its own.
      if (action === 'leave') { closeOverlay(); return; }
      // Ctrl+T. `overlayIdRef.current` is a TERMINAL id, and the only id this listener holds —
      // `focusedId` is the same terminal. The overlay is deliberately left OPEN on the way out:
      // `overlayId` is a view fact belonging to the canvas tab that already survives a tab
      // switch by design, and this component's unmount cleanup releases `focusedId` while the
      // remount path re-grants it. Closing it here would make this the one departure that also
      // discarded the user's view.
      if (action === 'open-tab') { openTabForTerminal(overlayIdRef.current ?? focusedId); return; }
      (document.activeElement as HTMLElement | null)?.blur();
      dispatch(focusNode(null));
    };
    // Capture phase, matching InputHandler's ownership of global shortcuts.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [focusedId, dispatch, closeOverlay, combos, openTabForTerminal]);

  // Read through a ref inside the Esc handler above: that effect is keyed on `focusedId`, and
  // adding `overlayId` to its deps would tear down and re-register the capture-phase listener
  // every time the overlay opened or closed.
  const overlayIdRef = useRef<string | null>(null);
  overlayIdRef.current = overlayId;

  // For the toolbar's Close Ended button — how many nodes it would close, and whether there is
  // anything for it to do.
  const endedCount = model.nodes.filter((n) => n.exited).length;

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
            // `preventDefault` because nothing else suppresses the browser's own menu here: the
            // viewport bails out on `.canvas-glabel` and `.canvas-gchip` without preventing
            // anything. `stopPropagation` for the reason `CanvasNode` gives — the bail list and
            // the stop are belt and braces, and the node already carries both.
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setGroupMenu({ tabId: g.tabId, title: g.title, x: e.clientX, y: e.clientY });
            }}
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
            onPointerDown={(e) => { e.stopPropagation(); closeOverlay(); }}
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
              busyCue={busyCue}
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
              onChipClick={() => flyTo(centreOn(
                aimedNodeRect(n.rect, NODE_CHIP_ZOOM), size.w, size.h, NODE_CHIP_ZOOM, metrics.zMax,
              ))}
              combos={combos}
              onOpenAsTab={openAsTab(n.tabId, n.paneId)}
              onOpenOverlay={() => (isOverlaid ? closeOverlay() : dispatch(setOverlayNode(n.terminalId)))}
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
              <NodeTerminal terminalId={n.terminalId} focused={focusedId === n.terminalId}
                overlaid={isOverlaid}
                exitInfo={sessionExitByTerminalId[n.terminalId] ?? null}
                fontSize={terminalFontSize} />
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
            title={`${sidebarOpen ? 'Hide' : 'Show'} the terminal list (${combos.toggleList})`}
          >
            List
          </button>
          <button
            type="button"
            className="canvas-tbtn"
            onClick={arrange}
            title={`Grid each group's terminals, then the groups themselves (${combos.arrange})`}
          >
            Arrange
          </button>
          {/* Tam, 2026-08-24: a way to clear the "ended" tint in one press rather than closing
              each dead node by hand. Disabled rather than hidden at zero, matching the zoom
              buttons below — a button that vanishes the moment it would be useful is harder to
              find than one that is merely greyed out. */}
          <button
            type="button"
            className="canvas-tbtn"
            onClick={closeAllEnded}
            disabled={endedCount === 0}
            title={endedCount > 0
              ? `Close ${endedCount} terminal${endedCount === 1 ? '' : 's'} whose session has ended`
              : 'No ended sessions to close'}
          >
            Close Ended
          </button>
          {/* Viewport controls, separated from the ones above because they do something to the
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
        <CanvasNodeMenu
          x={nodeMenu.x}
          y={nodeMenu.y}
          title={nodeMenu.node.title}
          // Read from `overlayId` rather than remembered when the menu opened: the overlay can be
          // dismissed by a backdrop click while the menu is up, and a stale copy would then offer
          // "Shrink back to the canvas" for a node that is already back on it.
          overlaid={overlayId === nodeMenu.node.terminalId}
          // The SAME expressions the header buttons use (see the node's `onOpenOverlay` /
          // `onOpenAsTab` props below) rather than second implementations of them — one action
          // reached two ways has to be one action.
          onToggleOverlay={() => (overlayId === nodeMenu.node.terminalId
            ? closeOverlay()
            : dispatch(setOverlayNode(nodeMenu.node.terminalId)))}
          onOpenAsTab={openAsTab(nodeMenu.node.tabId, nodeMenu.node.paneId)}
          onCloseTerminal={() => closeNode(nodeMenu.node)}
          onDismiss={() => setNodeMenu(null)}
        />
      )}
      {groupMenu && (
        <CanvasGroupMenu
          x={groupMenu.x}
          y={groupMenu.y}
          tabId={groupMenu.tabId}
          title={groupMenu.title}
          onClose={() => setGroupMenu(null)}
        />
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
