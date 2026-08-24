import { Rect } from './canvasGeometry';
import { CanvasEdge } from '../../store/slices/canvasSlice';
import { CanvasModel } from './canvasSelectors';
import { fanPlacement } from './agentPlacement';

/**
 * Where an agent-spawned terminal's node should land — `plan/013` Task 20 Step 6.
 *
 * Pure, and separate from `fanPlacement`, because the two answer different questions:
 * `fanPlacement` is the geometry, this is everything that has to be true before the geometry
 * is worth computing. It lives outside `App.tsx` for the usual reason — nothing in this repo
 * can mount that component, so a decision left inline is a decision no test can reach.
 *
 * Returns null when the spawn should just fall through to Task 8's ordinary seeding: no
 * parent was named, the parent is not on the canvas, or the parent IS the new node.
 */
export function planAgentPlacement(
  model: CanvasModel,
  edges: CanvasEdge[],
  parentTerminalId: string | undefined,
  newLeafId: string | undefined,
): { terminalId: string; rect: Rect } | null {
  if (!parentTerminalId || !newLeafId || parentTerminalId === newLeafId) return null;

  // The parent may be named in either id space — the MCP caller header carries a `pc-*`
  // process id, while the canvas model is keyed by renderer leaves. Only a leaf can be
  // located here; the backend does its own resolution for the EDGE, which is why a miss is a
  // placement fall-through rather than an error.
  const caller = model.nodes.find((n) => n.terminalId === parentTerminalId);
  if (!caller) return null;

  // How many nodes this caller has already spawned, so a run of them fans instead of
  // stacking. Counted from the edges the caller points AT — `origin` is deliberately not
  // filtered: a user who has hand-drawn wires out of this terminal has used those angles
  // too, and the fan should continue past them rather than restart underneath them.
  const index = edges.filter((e) => e.from === parentTerminalId).length;

  const taken = model.nodes.map((n) => n.rect);
  const p = fanPlacement(caller.rect, taken, index);
  return {
    terminalId: newLeafId,
    rect: { x: p.x, y: p.y, w: caller.rect.w, h: caller.rect.h },
  };
}
