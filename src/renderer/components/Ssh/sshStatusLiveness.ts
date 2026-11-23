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
  return metricsSession(state, id).connected;
}

export function sshStatusMarkerVisible({ terminalLive, barShown, barConnected }: {
  terminalLive: boolean; barShown: boolean; barConnected: boolean;
}) {
  return !terminalLive && !(barShown && !barConnected);
}
