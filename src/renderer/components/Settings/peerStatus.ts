export type PeerStatus = 'online' | 'offline' | 'pending' | 'revoked';

/**
 * Derive the display status for a peer. A pending pairing request takes precedence
 * over online/offline so the UI can prompt the user to accept/decline instead of
 * showing a misleading "Online"/"Offline" badge. `'revoked'` is a terminal state set
 * directly by consumers (a peer whose grant was revoked) and is not derived here.
 */
export function peerStatus(p: { online: boolean; pending?: boolean }): PeerStatus {
  if (p.pending) return 'pending';
  return p.online ? 'online' : 'offline';
}
