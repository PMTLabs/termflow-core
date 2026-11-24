import type { RootState } from '../../store';
import { findLeafByTerminalId } from '../../store/slices/paneTreeOps';
import { selectSshLaunch, type SshLaunchState } from '../../store/slices/sshSessionSlice';

export function launchStageLive(stage: SshLaunchState['stage'] | undefined) {
  return stage !== undefined && stage !== 'ended' && stage !== 'blocked' && stage !== 'cancelled' && stage !== 'error';
}

export const tagConnectionId = (state: RootState, id: string) => findLeafByTerminalId(state.panes.treesByTabId, id)?.ssh?.connectionId;

export function metricsSession(state: RootState, id: string) {
  const observed = state.sshSession.byTerminal[id]?.session;
  const session = observed?.connectionId === tagConnectionId(state, id) ? observed : undefined;
  const launch = selectSshLaunch(state, id);
  // Only the current generation can end the app channel for metrics.
  const ended = launch?.stage === 'ended' && launch.sessionGeneration === session?.generation;
  return { session, ended, connected: !ended && session?.state === 'connected', hasLaunch: !!launch };
}

export function selectSshMetricsRowConnected(state: RootState, id: string) {
  return sshConnectionPhase(state, id) === 'connected';
}

export function sshConnectionPhase(state: RootState, id: string): 'connected' | 'connecting' | 'disconnected' {
  const { session, ended, connected } = metricsSession(state, id);
  const launch = selectSshLaunch(state, id);
  // A launch from an older generation cannot mask a newer observed session.
  const stage = session?.generation !== undefined && launch && launch.sessionGeneration < session.generation ? undefined : launch?.stage;
  if (ended || (stage && !launchStageLive(stage))) return 'disconnected';
  if (connected) return 'connected';
  if (session?.state === 'connecting' || session?.state === 'needs-hostkey' || session?.state === 'needs-secret'
    || (launchStageLive(stage) && (stage !== 'running' || !session))) return 'connecting';
  return 'disconnected';
}

export function sshStatusMarkerVisible({ terminalLive, barShown, barConnected }: {
  terminalLive: boolean; barShown: boolean; barConnected: boolean;
}) {
  return !terminalLive && !(barShown && !barConnected);
}
