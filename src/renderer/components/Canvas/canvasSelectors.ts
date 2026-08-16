import { createSelector } from '@reduxjs/toolkit';
// Type-only: this module is unit-tested in a `node` environment, and a value import
// of `../../store` would construct the real Redux store (and everything it imports)
// just to read a type.
import type { RootState } from '../../store';
import type { PaneNode } from '../../store/slices/panesSlice';
import type { Tab } from '../../store/slices/tabsSlice';
import {
  NODE_W, NODE_H, CHIP_H, CULL_MARGIN, T_GPU, T_SNAP, Z_MIN,
  LodTier, Rect, Viewport, isVisible,
} from './canvasGeometry';
import { fitGroupFrame, seedNodePosition, PAD, PAD_TOP, GROUP_GAP } from './canvasLayout';
import { isVirtualTab } from '../../services/tabKinds';
import type { NodeInfoPayload } from '../../services/canvasGraph';

export interface CanvasNodeModel {
  terminalId: string;
  tabId: string;
  /** The pane leaf this node was projected from. Carried so "open in its tab" can put the
   *  cursor on the pane the user actually clicked, not just the tab it lives in. */
  paneId: string;
  /** PaneNode.name — NOT Tab.title. See design 010 §2.1. */
  title: string;
  shellType: string;
  rect: Rect;
  isRunning: boolean;
  hasUnseenOutput: boolean;
}

export interface CanvasGroupModel {
  tabId: string;
  title: string;
  rect: Rect;
  nodeIds: string[];
  anyRunning: boolean;
}

export interface CanvasModel {
  nodes: CanvasNodeModel[];
  groups: CanvasGroupModel[];
}

/** Every terminal leaf in a tree, paired with its pane metadata, in visual order. */
function leaves(node: PaneNode | null | undefined): PaneNode[] {
  if (!node) return [];
  if (node.type === 'terminal') return node.terminalId ? [node] : [];
  return (node.children ?? []).flatMap(leaves);
}

/**
 * Counter-scale for a world-space label, so it holds a CONSTANT on-screen size at
 * any zoom: the label lives inside `.canvas-world`, which is scaled by `z`, so
 * scaling the label by `1/z` makes the two cancel exactly.
 *
 * The clamp is a guard against a degenerate `z`, NOT a style choice, so it is
 * derived from the legal zoom range rather than picked — and the top of that range is now a
 * property of the display the session opened on, so it is passed in. An arbitrary tighter ceiling
 * would quietly break the promise in the sentence above: at the group-collapse end of
 * the range `1/z` reaches 20, so a ceiling of (say) 3 would leave every frame label
 * rendering at under 3 real pixels across the whole chip band — present in the DOM,
 * invisible on screen, and passing any test that only probes zooms near 1.
 */
export function counterScale(z: number, zMax: number): number {
  return Math.min(1 / Z_MIN, Math.max(1 / zMax, 1 / z));
}

/**
 * Font size for a node chip's label, in WORLD units.
 *
 * Unlike a group chip — which counter-scales the whole element and so stays exactly
 * legible — a node chip is a world-space box only `CHIP_H` tall, and its text has to
 * fit inside that box. So the ceiling here is geometric: text cannot outgrow the chip
 * it labels. Where that ceiling binds (the lower half of the chip band) the label
 * degrades into a size cue rather than readable copy, which is the intended reading of
 * the tier — the readable rendering of a collapsed group is `.canvas-gchip`.
 */
export function chipFontSize(z: number): number {
  return Math.min(CHIP_H * 0.8, Math.max(11, 13 / z));
}

/** Zoom a group chip flies to: its terminals land inside the snapshot tier. */
export const GROUP_CHIP_ZOOM = (T_SNAP + 14) / NODE_W;
/** Zoom a node chip flies to: the node lands inside the gpu tier. */
export const NODE_CHIP_ZOOM = T_GPU / NODE_W + 0.1;

/**
 * Project tabs+panes into canvas models, seeding geometry for anything that has
 * never been placed. Pure and deterministic — the same state always yields the
 * same layout, so a restart does not reshuffle the workspace.
 */
function buildModel(
  tabs: Tab[],
  trees: Record<string, PaneNode>,
  stored: Record<string, Rect>,
  storedGroups: Record<string, Rect>,
): CanvasModel {
  const nodes: CanvasNodeModel[] = [];
  const groups: CanvasGroupModel[] = [];

  let frameCursorX = 60;
  for (const rect of Object.values(storedGroups)) {
    frameCursorX = Math.max(frameCursorX, rect.x + rect.w + GROUP_GAP);
  }

  for (const tab of tabs) {
    // Settings and the canvas tab itself are screens, not workspaces. They have no pane
    // tree today, so they would fall through the leaf-less branch below — and that branch
    // draws a frame for anything with a STORED rect, so a stale geometry entry (or a
    // future screen tab that does own panes) would put an empty group on the canvas, and
    // the canvas tab would draw a frame for itself.
    if (isVirtualTab(tab.shellType)) continue;

    const paneLeaves = leaves(trees[tab.id]);

    // An emptied tab keeps its frame at its last size so it stays a visible drop
    // target (design 010 §6.3, §10). Skipping leaf-less tabs here would make the
    // frame vanish the moment its last terminal is dragged out, and `groupAt`
    // would never see it again.
    if (!paneLeaves.length) {
      const kept = storedGroups[tab.id];
      if (kept) {
        groups.push({ tabId: tab.id, title: tab.title, rect: kept, nodeIds: [], anyRunning: false });
      }
      continue;
    }

    const frame: Rect = storedGroups[tab.id] ?? {
      x: frameCursorX,
      y: 60,
      w: PAD * 2 + NODE_W,
      h: PAD_TOP + PAD + NODE_H,
    };
    if (!storedGroups[tab.id]) frameCursorX = frame.x + frame.w + GROUP_GAP;

    // Two passes, deliberately. Every STORED rect is claimed before anything is
    // seeded, so a freshly split pane cannot be seeded into a slot a terminal
    // already occupies. A single pass would compare each seed only against the
    // leaves before it, and a new pane in position 1 would land on top of a
    // stored pane in position 2.
    const rects: Rect[] = new Array(paneLeaves.length);
    const placed: Rect[] = [];
    paneLeaves.forEach((leaf, i) => {
      const r = stored[leaf.terminalId!];
      if (r) { rects[i] = r; placed.push(r); }
    });
    paneLeaves.forEach((_leaf, i) => {
      if (rects[i]) return;
      const p = seedNodePosition(frame, placed);
      const seeded = { x: p.x, y: p.y, w: NODE_W, h: NODE_H };
      rects[i] = seeded;
      placed.push(seeded);
    });

    const nodeIds: string[] = [];
    paneLeaves.forEach((leaf, i) => {
      const id = leaf.terminalId!;
      nodeIds.push(id);
      nodes.push({
        terminalId: id,
        tabId: tab.id,
        paneId: leaf.id,
        title: leaf.name || tab.title || 'Terminal',
        shellType: leaf.shellType || tab.shellType || '',
        rect: rects[i],
        // Running/unseen are TAB-level facts in the store, so every node in a tab
        // shares them. Per-pane activity would need RunningActivityTracker to
        // publish per-terminal state, which it does not.
        isRunning: !!tab.isRunning,
        hasUnseenOutput: !!tab.hasUnseenOutput,
      });
    });

    // A non-empty group's frame is DERIVED — it shrink-wraps its terminals, and a
    // stored frame rect is used only to seed positions, never as the drawn frame.
    // That keeps the frame honest when a terminal is dragged out of its bounds, and
    // it agrees with `arrange`, whose group rects are exactly this shrink-wrap. The
    // consequence for Task 12: dragging a group must move its NODES; writing only
    // the group rect through `setGroupGeom` would be silently discarded here.
    groups.push({
      tabId: tab.id,
      title: tab.title,
      rect: fitGroupFrame(placed) ?? frame,
      nodeIds,
      anyRunning: !!tab.isRunning,
    });
  }

  return { nodes, groups };
}

/** Memoised for the component tree: `buildModel` allocates a fresh object every call,
 *  which a bare `useSelector` would treat as a change on every dispatch in the app. */
export const selectCanvasModel = createSelector(
  [
    (s: RootState) => s.tabs.tabs,
    (s: RootState) => s.panes.treesByTabId,
    (s: RootState) => s.canvas.nodes,
    (s: RootState) => s.canvas.groups,
  ],
  buildModel,
);

export function buildCanvasModel(state: RootState): CanvasModel {
  return buildModel(
    state.tabs.tabs,
    state.panes.treesByTabId,
    state.canvas.nodes,
    state.canvas.groups,
  );
}

/**
 * The paint-cull set — the one place it is derived, so Tasks 10, 18 and 23 share it.
 *
 * A node OUTSIDE this set is still MOUNTED and still holds its terminal: culling is a
 * paint decision, never a relocation (design 010 §4.4, `012` §6.5 RC4). Unmounting on
 * a pan would relocate terminals at gesture frequency and SIGWINCH every ratatui/codex
 * PTY on the canvas. This set gates work — snapshot polling, edge mask rects, chrome —
 * and `visibility`, nothing else.
 */
/**
 * The node→group registry this window publishes to `PUT /api/canvas/nodes` (Task 18 Step 7).
 *
 * The backend knows every terminal's id and owning tab after P0-A, but **only the renderer knows
 * the TITLES** — `PaneNode.name` and `Tab.title` never leave it — and those are what make an
 * agent's answer to "what am I connected to" readable rather than a list of `tm-` ids
 * (design 010 §7.4.1).
 *
 * A group lookup map rather than a `find` per node: a workspace with many tabs turns the obvious
 * nested scan into O(nodes x groups) on a path that runs on every model change.
 */
export function nodeRegistryPayload(model: CanvasModel): NodeInfoPayload[] {
  const titles = new Map(model.groups.map((g) => [g.tabId, g.title]));
  return model.nodes.map((n) => ({
    nodeId: n.terminalId,
    title: n.title,
    groupId: n.tabId,
    groupTitle: titles.get(n.tabId) ?? null,
  }));
}

export function visibleNodeIds(
  nodes: CanvasNodeModel[],
  vp: Viewport,
  vw: number,
  vh: number,
  margin = CULL_MARGIN,
): Set<string> {
  const out = new Set<string>();
  for (const n of nodes) if (isVisible(vp, n.rect, vw, vh, margin)) out.add(n.terminalId);
  return out;
}

/** True when the whole workspace has collapsed to group chips. Empty is not collapsed —
 *  there would be no chips to show, only the empty-canvas message. */
export function allCollapsed(nodes: CanvasNodeModel[], tiers: Record<string, LodTier>): boolean {
  return nodes.length > 0 && nodes.every((n) => tiers[n.terminalId] === 'group');
}

/**
 * Which nodes get a POLLING snapshot (`plan/013` Task 10).
 *
 * A rule rather than three conditions inlined in `CanvasMode`, because `CanvasMode` cannot be
 * mounted under the root Jest config — so anything expressed only in its JSX is untestable, and
 * this is the one part of the snapshot tier with real consequences if it drifts.
 *
 * **The intersection with `visible` is load-bearing, not an optimisation.** `assignTiers` labels
 * an off-screen node `snapshot`; it does not omit it (see its `isVisible` branch). So the tier
 * alone would mount `NodeSnapshot` for every terminal in the workspace and leave a 500ms loop
 * running for each, for the whole session. `snapshotCache.evictAllBut` cannot clean up after
 * that either — a still-mounted component refills the cache on its next tick, so the eviction
 * and the loop would simply fight.
 *
 * Note this culls the SNAPSHOT, never the node: `CanvasNode` mounts for every terminal all
 * session (`012` §6.5 RC4), because unmounting it would relocate a live terminal at pan
 * frequency. The two rules point opposite ways because what they own is different — a timer
 * versus a terminal.
 */
export function snapshotNodeIds(
  nodes: CanvasNodeModel[],
  tiers: Record<string, LodTier>,
  visible: Set<string>,
  collapsed: boolean,
): Set<string> {
  const out = new Set<string>();
  // Nothing is showing a screen when the whole workspace is group chips.
  if (collapsed) return out;
  for (const n of nodes) {
    if (tiers[n.terminalId] === 'snapshot' && visible.has(n.terminalId)) out.add(n.terminalId);
  }
  return out;
}
