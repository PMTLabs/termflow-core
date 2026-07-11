import peersReducer, {
  setPeers,
  upsertPeer,
  removePeer,
  setPendingRequests,
  addPendingRequest,
  removePendingRequest,
  setAcceptPeers,
  setFabricInstalled,
} from '../peersSlice';
import type { PeerInfo, PeerRequestInfo } from '../../../types/electron';

const peer = (deviceId: string, over: Partial<PeerInfo> = {}): PeerInfo => ({
  deviceId,
  name: `dev-${deviceId}`,
  addresses: ['192.168.1.10'],
  online: true,
  lastSeen: null,
  grants: {},
  ...over,
});

const request = (deviceId: string, over: Partial<PeerRequestInfo> = {}): PeerRequestInfo => ({
  deviceId,
  name: `dev-${deviceId}`,
  addr: '192.168.1.10',
  ...over,
});

describe('peersSlice defaults', () => {
  it('starts empty with peering off and fabric not installed', () => {
    const state = peersReducer(undefined, { type: '@@INIT' } as any);
    expect(state.peers).toEqual([]);
    expect(state.pendingRequests).toEqual([]);
    expect(state.acceptPeers).toBe(false);
    expect(state.fabricInstalled).toBe(false);
  });
});

describe('peersSlice peers list', () => {
  it('sets and removes peers', () => {
    let state = peersReducer(undefined, setPeers([peer('A')]));
    expect(state.peers).toHaveLength(1);
    state = peersReducer(state, removePeer('A'));
    expect(state.peers).toHaveLength(0);
  });

  it('setPeers bulk-replaces the whole list', () => {
    let state = peersReducer(undefined, setPeers([peer('A')]));
    state = peersReducer(state, setPeers([peer('B'), peer('C')]));
    expect(state.peers.map(p => p.deviceId)).toEqual(['B', 'C']);
  });

  it('upsertPeer inserts a new peer', () => {
    const state = peersReducer(undefined, upsertPeer(peer('A')));
    expect(state.peers).toHaveLength(1);
    expect(state.peers[0].deviceId).toBe('A');
  });

  it('upsertPeer replaces an existing peer by deviceId (no duplicate)', () => {
    let state = peersReducer(undefined, upsertPeer(peer('A', { online: true })));
    state = peersReducer(state, upsertPeer(peer('A', { online: false })));
    expect(state.peers).toHaveLength(1);
    expect(state.peers[0].online).toBe(false);
  });

  it('removePeer only removes the matching deviceId', () => {
    let state = peersReducer(undefined, setPeers([peer('A'), peer('B')]));
    state = peersReducer(state, removePeer('A'));
    expect(state.peers.map(p => p.deviceId)).toEqual(['B']);
  });
});

describe('peersSlice pending requests', () => {
  it('addPendingRequest appends a request', () => {
    const state = peersReducer(undefined, addPendingRequest(request('A')));
    expect(state.pendingRequests).toHaveLength(1);
  });

  it('addPendingRequest de-dupes by deviceId (re-fire replaces)', () => {
    let state = peersReducer(undefined, addPendingRequest(request('A', { name: 'first' })));
    state = peersReducer(state, addPendingRequest(request('A', { name: 'second' })));
    expect(state.pendingRequests).toHaveLength(1);
    expect(state.pendingRequests[0].name).toBe('second');
  });

  it('removePendingRequest drops just that request', () => {
    let state = peersReducer(undefined, setPendingRequests([request('A'), request('B')]));
    state = peersReducer(state, removePendingRequest('A'));
    expect(state.pendingRequests.map(r => r.deviceId)).toEqual(['B']);
  });

  it('setPendingRequests bulk-replaces the list', () => {
    const state = peersReducer(undefined, setPendingRequests([request('A'), request('B')]));
    expect(state.pendingRequests).toHaveLength(2);
  });
});

describe('peersSlice flags', () => {
  it('setAcceptPeers toggles the flag', () => {
    const state = peersReducer(undefined, setAcceptPeers(true));
    expect(state.acceptPeers).toBe(true);
  });

  it('setFabricInstalled toggles the flag', () => {
    const state = peersReducer(undefined, setFabricInstalled(true));
    expect(state.fabricInstalled).toBe(true);
  });
});

describe('peersSlice Immer-safe plain snapshot', () => {
  // Regression guard mirroring settingsSlice: the state returned by a reducer
  // must be a finalized plain value, not a live Immer draft. A leaked draft is
  // revoked once the reducer returns, so a later JSON.stringify (e.g. by an
  // async persistence writer) would throw "proxy has been revoked". Snapshot
  // the state and assert it round-trips cleanly to a plain object.
  it('produces JSON-serializable state that survives draft revocation', () => {
    let state = peersReducer(undefined, setPeers([peer('A')]));
    state = peersReducer(state, upsertPeer(peer('B', { online: false })));
    state = peersReducer(state, addPendingRequest(request('C')));
    state = peersReducer(state, setAcceptPeers(true));
    state = peersReducer(state, setFabricInstalled(true));

    expect(() => JSON.stringify(state)).not.toThrow();
    const plain = JSON.parse(JSON.stringify(state));
    expect(plain).toEqual({
      peers: [peer('A'), peer('B', { online: false })],
      pendingRequests: [request('C')],
      acceptPeers: true,
      fabricInstalled: true,
    });
  });
});
