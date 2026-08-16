/**
 * @jest-environment jsdom
 */
import {
  nextRevision, putNodes, fetchGraph, createEdge, deleteEdge, patchEdgeLabel,
  __resetRevisionForTests,
} from '../canvasGraph';

type Call = { path: string; init?: { method?: string; body?: any } };

const calls: Call[] = [];
let reply: (c: Call) => unknown = () => null;

beforeEach(() => {
  calls.length = 0;
  reply = () => null;
  __resetRevisionForTests();
  (window as any).electronAPI = {
    getWindowLabel: () => 'main',
    canvasApiRequest: (path: string, init?: any) => {
      const call = { path, init };
      calls.push(call);
      return Promise.resolve(reply(call));
    },
  };
});

afterEach(() => {
  delete (window as any).electronAPI;
});

describe('nextRevision', () => {
  it('uses the wall clock when it is ahead', () => {
    expect(nextRevision(1_700_000_000_000, 5)).toBe(1_700_000_000_000);
  });

  it('never returns a value at or below the last one', () => {
    // Two publishes in the same millisecond, and a clock that stepped backwards.
    expect(nextRevision(1000, 1000)).toBe(1001);
    expect(nextRevision(400, 1000)).toBe(1001);
  });

  it('is strictly increasing across a run of adversarial clocks', () => {
    const clocks = [1000, 1000, 999, 1001, 500, 1_700_000_000_000, 3, 1_700_000_000_000];
    let last = 0;
    for (const now of clocks) {
      const r = nextRevision(now, last);
      expect(r).toBeGreaterThan(last);
      last = r;
    }
  });
});

describe('putNodes', () => {
  const node = { nodeId: 'tm-1', title: 'zsh', groupId: 'tab-1', groupTitle: 'Work' };

  it('sends windowId and revision, which the endpoint requires', async () => {
    // The defect this pins. `PutNodesReq` deserialises `windowId: String` and
    // `revision: u64`; a body carrying only `nodes` is a 400 before any handler logic runs,
    // and nothing inspects the response — so the registry would stay empty in silence and
    // every `/connections` title would come back null.
    await putNodes([node]);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/canvas/nodes');
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[0].init?.body).toEqual({
      windowId: 'main',
      revision: expect.any(Number),
      nodes: [node],
    });
    expect(calls[0].init?.body.revision).toBeGreaterThan(0);
  });

  it('raises the revision on every publish', async () => {
    await putNodes([node]);
    await putNodes([node]);
    await putNodes([node]);
    const revisions = calls.map((c) => c.init?.body.revision);
    expect(revisions[1]).toBeGreaterThan(revisions[0]);
    expect(revisions[2]).toBeGreaterThan(revisions[1]);
  });

  it('starts above zero so a renderer reload cannot publish beneath the stored revision', async () => {
    // The backend keeps a window's registry until the window CLOSES, so a reload republishes
    // into a registry that already has a high revision. A counter starting at 1 would 409
    // forever and freeze the registry at its pre-reload contents.
    await putNodes([node]);
    expect(calls[0].init?.body.revision).toBeGreaterThan(1_600_000_000_000);
  });

  it('uses this window\'s own label, so two windows keep separate registries', async () => {
    (window as any).electronAPI.getWindowLabel = () => 'detached-7';
    await putNodes([node]);
    expect(calls[0].init?.body.windowId).toBe('detached-7');
  });

  it('falls back to "main" when the bridge cannot answer', async () => {
    (window as any).electronAPI.getWindowLabel = () => { throw new Error('not a tauri window'); };
    await putNodes([node]);
    expect(calls[0].init?.body.windowId).toBe('main');
  });

  it('reports failure instead of throwing out of the publisher', async () => {
    (window as any).electronAPI.canvasApiRequest = () => Promise.reject(new Error('409'));
    await expect(putNodes([node])).resolves.toBe(false);
  });
});

describe('fetchGraph', () => {
  it('returns the parsed graph', async () => {
    const edge = { id: 'ce-1', from: 'a', to: 'b', label: null, origin: 'user', createdAt: 7 };
    reply = () => ({ version: 1, nodes: [], groups: [], edges: [edge] });
    const graph = await fetchGraph();
    expect(calls[0]).toEqual({ path: '/canvas/graph', init: undefined });
    expect(graph?.edges).toEqual([edge]);
  });

  it('returns null rather than a half-built graph when edges are missing', async () => {
    // A body without `edges` is not a graph with no edges — `setEdges([])` on that would
    // erase every wire on screen because the server had a bad day.
    reply = () => ({ version: 1, nodes: [] });
    expect(await fetchGraph()).toBeNull();
  });

  it('survives a rejected request', async () => {
    (window as any).electronAPI.canvasApiRequest = () => Promise.reject(new Error('503'));
    expect(await fetchGraph()).toBeNull();
  });

  it('returns null when no bridge is present at all', async () => {
    delete (window as any).electronAPI;
    expect(await fetchGraph()).toBeNull();
  });
});

describe('edge mutations', () => {
  it('posts the ordered pair and returns the server row', async () => {
    const stored = { id: 'ce-9', from: 'a', to: 'b', label: null, origin: 'user', createdAt: 3 };
    reply = () => stored;
    expect(await createEdge('a', 'b')).toEqual(stored);
    expect(calls[0].path).toBe('/canvas/edges');
    expect(calls[0].init).toEqual({ method: 'POST', body: { from: 'a', to: 'b', label: null } });
  });

  it('returns null on a rejected create, so no client id is invented', async () => {
    (window as any).electronAPI.canvasApiRequest = () => Promise.reject(new Error('400'));
    expect(await createEdge('a', 'a')).toBeNull();
  });

  it('escapes the id in the path', async () => {
    await deleteEdge('ce-1/../x');
    expect(calls[0].path).toBe('/canvas/edges/ce-1%2F..%2Fx');
    expect(calls[0].init?.method).toBe('DELETE');
  });

  it('patches a label, and sends null to clear it', async () => {
    await patchEdgeLabel('ce-1', 'deploys to');
    expect(calls[0].init).toEqual({ method: 'PATCH', body: { label: 'deploys to' } });
    await patchEdgeLabel('ce-1', null);
    expect(calls[1].init).toEqual({ method: 'PATCH', body: { label: null } });
  });
});
