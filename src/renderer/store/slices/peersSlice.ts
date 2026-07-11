import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { PeerInfo, PeerRequestInfo } from '../../types/electron';

// Runtime peering state (Plan 010). Unlike settingsSlice, none of this is
// persisted — it is live state sourced from the termflow-fabric sidecar via the
// peer Tauri commands + `peer:event` feed, so the reducers have no config
// side-effects (they are pure state transitions).
interface PeersState {
  // Known peer devices, as last reported by the fabric control API.
  peers: PeerInfo[];
  // Incoming pairing requests awaiting the local user's Accept/Decline.
  pendingRequests: PeerRequestInfo[];
  // Whether this machine currently accepts inbound pairing/peer connections.
  acceptPeers: boolean;
  // False when the termflow-fabric binary is absent (peering degrades
  // gracefully — the Peers panel shows "Peering not installed").
  fabricInstalled: boolean;
}

const initialState: PeersState = {
  peers: [],
  pendingRequests: [],
  acceptPeers: false,
  fabricInstalled: false,
};

const peersSlice = createSlice({
  name: 'peers',
  initialState,
  reducers: {
    // Bulk-replace the whole peer list (e.g. from a `peers_list` refresh).
    setPeers: (state, action: PayloadAction<PeerInfo[]>) => {
      state.peers = action.payload;
    },

    // Insert or replace a single peer by deviceId (from a `peer:event` update).
    upsertPeer: (state, action: PayloadAction<PeerInfo>) => {
      const index = state.peers.findIndex(p => p.deviceId === action.payload.deviceId);
      if (index === -1) {
        state.peers.push(action.payload);
      } else {
        state.peers[index] = action.payload;
      }
    },

    removePeer: (state, action: PayloadAction<string>) => {
      state.peers = state.peers.filter(p => p.deviceId !== action.payload);
    },

    // Bulk-replace pending pairing requests.
    setPendingRequests: (state, action: PayloadAction<PeerRequestInfo[]>) => {
      state.pendingRequests = action.payload;
    },

    // Add an incoming request, de-duped by deviceId (a re-fired request for the
    // same device replaces the existing entry rather than stacking duplicates).
    addPendingRequest: (state, action: PayloadAction<PeerRequestInfo>) => {
      const index = state.pendingRequests.findIndex(r => r.deviceId === action.payload.deviceId);
      if (index === -1) {
        state.pendingRequests.push(action.payload);
      } else {
        state.pendingRequests[index] = action.payload;
      }
    },

    removePendingRequest: (state, action: PayloadAction<string>) => {
      state.pendingRequests = state.pendingRequests.filter(r => r.deviceId !== action.payload);
    },

    setAcceptPeers: (state, action: PayloadAction<boolean>) => {
      state.acceptPeers = action.payload;
    },

    setFabricInstalled: (state, action: PayloadAction<boolean>) => {
      state.fabricInstalled = action.payload;
    },
  },
});

export const {
  setPeers,
  upsertPeer,
  removePeer,
  setPendingRequests,
  addPendingRequest,
  removePendingRequest,
  setAcceptPeers,
  setFabricInstalled,
} = peersSlice.actions;

export default peersSlice.reducer;
