import { CanvasEdge } from '../store/slices/canvasSlice';

/**
 * REST client for the canvas connection graph — `plan/013` Task 18, against the routes
 * Task 17 shipped in `src-tauri/src/canvas_endpoints.rs`.
 *
 * Transport is `electronAPI.canvasApiRequest`, never a bare `fetch`: the API port is
 * user-configurable and resolved at runtime, and the backend enforces a bearer token on every
 * request once it is exposed on the network — including this renderer's own loopback calls.
 *
 * Every call degrades to a null/false rather than throwing. A canvas whose wires failed to load
 * is a canvas with no wires; one that throws out of a render or an effect is a blank tab.
 */

/** What the renderer publishes about each node. Mirrors `canvas_endpoints::NodeInfo`. */
export interface NodeInfoPayload {
  /** The renderer LEAF id (`Terminal.renderer_terminal_id`), never the owning tab. */
  nodeId: string;
  title: string | null;
  groupId: string | null;
  groupTitle: string | null;
}

/** Mirrors `canvas_endpoints::CanvasGraph`. */
export interface CanvasGraphResponse {
  version: number;
  nodes: NodeInfoPayload[];
  groups: Array<{ groupId: string; groupTitle: string | null }>;
  edges: CanvasEdge[];
}

const request = async (
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> => {
  const send = window.electronAPI?.canvasApiRequest;
  if (!send) return null;
  return send(path, init);
};

/**
 * Monotonic publish revision, and this is load-bearing rather than bookkeeping.
 *
 * `put_nodes` answers **409 CONFLICT** when the incoming revision is below the one it already
 * holds for this window, and it holds that registry until the WINDOW CLOSES — a renderer reload
 * (dev HMR, a crash-reload, `location.reload()`) does not clear it. So a counter that starts at
 * zero each time the bundle loads publishes `1` against a stored `57`, is rejected, and keeps
 * being rejected forever: the backend then serves a registry describing the model as it stood
 * before the reload, and `/connections` reports stale titles and groups with a 200. Silent, and
 * exactly the failure design 010 §7.4.1 exists to prevent.
 *
 * Seeding from the wall clock survives a reload. The `last + 1` floor covers the two ways the
 * clock can fail to be monotonic — an NTP step or a manual change backwards, and two publishes
 * inside the same millisecond — without ever going down.
 */
export function nextRevision(now: number, last: number): number {
  return Math.max(now, last + 1);
}

let lastRevision = 0;

/** Reset between tests; the counter is module state by design (one publisher per window). */
export function __resetRevisionForTests(): void {
  lastRevision = 0;
}

const windowId = (): string => {
  try {
    return window.electronAPI?.getWindowLabel?.() ?? 'main';
  } catch {
    return 'main';
  }
};

export async function fetchGraph(): Promise<CanvasGraphResponse | null> {
  try {
    const body = await request('/canvas/graph');
    if (!body || typeof body !== 'object') return null;
    const graph = body as Partial<CanvasGraphResponse>;
    if (!Array.isArray(graph.edges)) return null;
    return {
      version: graph.version ?? 1,
      nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
      groups: Array.isArray(graph.groups) ? graph.groups : [],
      edges: graph.edges,
    };
  } catch (e) {
    console.warn('[CANVAS] fetchGraph failed', e);
    return null;
  }
}

/**
 * Create a connection, and return **the row the server stored**.
 *
 * The id is minted server-side and is the only one a later delete or label edit can name. On a
 * duplicate pair the server returns the EXISTING row rather than an error, which is precisely
 * the id the caller needs — so a repeated drag is idempotent instead of a failure.
 */
export async function createEdge(
  from: string,
  to: string,
  label?: string | null,
): Promise<CanvasEdge | null> {
  try {
    const body = await request('/canvas/edges', {
      method: 'POST',
      body: { from, to, label: label ?? null },
    });
    return body && typeof body === 'object' ? (body as CanvasEdge) : null;
  } catch (e) {
    console.warn('[CANVAS] createEdge failed', e);
    return null;
  }
}

export async function deleteEdge(id: string): Promise<boolean> {
  try {
    await request(`/canvas/edges/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return true;
  } catch (e) {
    console.warn('[CANVAS] deleteEdge failed', e);
    return false;
  }
}

/** `null` CLEARS the label — the endpoint has no "leave unchanged" sentinel by design. */
export async function patchEdgeLabel(id: string, label: string | null): Promise<CanvasEdge | null> {
  try {
    const body = await request(`/canvas/edges/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { label },
    });
    return body && typeof body === 'object' ? (body as CanvasEdge) : null;
  } catch (e) {
    console.warn('[CANVAS] patchEdgeLabel failed', e);
    return null;
  }
}

/**
 * Publish this window's node→group registry.
 *
 * **`windowId` and `revision` are required by the endpoint and were absent from the task's own
 * signature.** `PutNodesReq` deserialises both, so a body carrying only `nodes` is a 400 before
 * any handler logic runs — and nothing here inspects the response, so Step 7 would have looked
 * implemented while `/connections` returned null titles for the life of the session. They are
 * sourced here rather than passed in because both are properties of the PUBLISHER, not of the
 * model: one window, one registry, one counter.
 */
export async function putNodes(nodes: NodeInfoPayload[]): Promise<boolean> {
  lastRevision = nextRevision(Date.now(), lastRevision);
  try {
    await request('/canvas/nodes', {
      method: 'PUT',
      body: { windowId: windowId(), revision: lastRevision, nodes },
    });
    return true;
  } catch (e) {
    console.warn('[CANVAS] putNodes failed', e);
    return false;
  }
}
