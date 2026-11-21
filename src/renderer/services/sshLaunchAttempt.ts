import type { LaunchAttemptRef, LaunchSnapshot, SshAPI, SshLaunchApi, SshSessionView } from '../types/ssh';
import type { PaneCapture } from './paneIncarnations';

export type OwnedSshLaunchApi = Pick<SshAPI, 'sshSessionOpen' | 'sshSessionState' | 'sshSessionReconnect'> & { ssh?: SshLaunchApi };
export interface OwnedSshPlacement {
  terminalId: string;
  connectionId: string;
  processIncarnation: string;
  owner: PaneCapture;
  current(): boolean;
}
export interface SshLaunchObservation {
  session: SshSessionView;
  snapshot?: LaunchSnapshot;
}
const hasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

/** The caller supplies an acknowledged placement and requalifies its copy and process on every hop. */
export async function observeOwnedSshLaunch(
  api: OwnedSshLaunchApi,
  placement: OwnedSshPlacement,
  action: 'open' | 'restart' | 'query',
): Promise<SshLaunchObservation | undefined> {
  const { terminalId, connectionId, processIncarnation, current } = placement;
  const { ssh } = api;
  if (!ssh) return;
  try {
    const ownerIncarnation = await placement.owner;
    if (!current()) return;
    let session: SshSessionView | undefined;
    if (action !== 'open') {
      try { session = await api.sshSessionState(terminalId); }
      catch (error) { if (!hasCode(error, 'not-found')) throw error; }
      if (!current()) return;
      if (session && (session.terminalId !== terminalId || session.connectionId !== connectionId || session.probeId)) return;
    }
    if (action === 'restart' && session) session = await api.sshSessionReconnect(terminalId);
    else if (action !== 'query') session = await api.sshSessionOpen(terminalId, connectionId);
    if (!current() || !session || session.terminalId !== terminalId || session.connectionId !== connectionId || session.probeId) return;
    const { generation, gate, reason, knownHostsPaths } = session;
    if (generation === undefined || !Number.isSafeInteger(generation)) return;
    const attempt: LaunchAttemptRef = {
      sessionGeneration: generation,
      attemptReceipt: { generation, gate, ...(reason !== undefined ? { reason } : {}), ...(knownHostsPaths ? { knownHostsPaths } : {}) },
      processIncarnation, ownerIncarnation,
    };
    let snapshot: LaunchSnapshot | undefined;
    try {
      snapshot = action === 'query'
        ? await ssh.terminalLaunchState(terminalId, attempt)
        : await ssh.launchTerminal(terminalId, connectionId, attempt);
    } catch (error) {
      if (action !== 'query' || !hasCode(error, 'NotFound')) throw error;
    }
    if (!current()) return;
    if (snapshot && (snapshot.terminalId !== terminalId || snapshot.connectionId !== connectionId
        || snapshot.attempt.sessionGeneration !== generation || snapshot.attempt.processIncarnation !== processIncarnation
        || snapshot.attempt.ownerIncarnation.pg !== ownerIncarnation.pg || snapshot.attempt.ownerIncarnation.seq !== ownerIncarnation.seq)) return;
    // Retain the whole 067 view (including promptId/promptTarget); the slice fences revision independently.
    return { session, snapshot };
  } catch (error) {
    if (current()) throw error;
    return undefined;
  }
}
