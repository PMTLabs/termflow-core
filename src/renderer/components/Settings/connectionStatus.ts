export type ConnStatus = 'checking' | 'healthy' | 'offline' | 'conflict';

/**
 * Derive the display status for a connection (P0b). A cross-instance conflict — the
 * port is reachable but owned by ANOTHER instance — takes precedence over
 * healthy/offline so the UI can prompt the user to pick a different port instead of
 * showing a misleading "Connected"/"Offline" badge.
 */
export function connectionStatus(
  h: { healthy: boolean | null; conflict?: boolean } | undefined,
): ConnStatus {
  if (!h) return 'offline';
  if (h.conflict) return 'conflict';
  if (h.healthy === null) return 'checking';
  return h.healthy ? 'healthy' : 'offline';
}
