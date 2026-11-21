import { useSelector, useStore } from 'react-redux';
import type { RootState } from '../../store';
import { findLeafByTerminalId } from '../../store/slices/paneTreeOps';
import { selectSshHiddenMetrics, setSshHiddenMetrics } from '../../store/slices/panesSlice';
import { selectSshLaunch, selectSshMetricsPause, selectSshMetricsSample, selectSshMetricsUnavailable } from '../../store/slices/sshSessionSlice';
import { addToast } from '../../store/slices/uiSlice';
import { reconnectSshTerminal } from '../../services/sshLaunch';
import { resumeSshMetrics } from '../../services/sshMetricsWatch';
import { writeClipboardText } from '../../utils/clipboard';
import type { MetricKey } from '../../types/ssh';
import { formatSshMetricsCopy } from './metricFormat';

// The chrome can move without owning a watch. Keep the lease in its terminal
// owner, or overlap leases during handoff: the coordinator shares one consumer.
export { retainSshMetrics, useSshMetricsWatch } from '../../services/sshMetricsWatch';
export { reconnectSshTerminal } from '../../services/sshLaunch';
export { selectSshHiddenMetrics, setSshHiddenMetrics } from '../../store/slices/panesSlice';

const tagConnectionId = (state: RootState, id: string) => findLeafByTerminalId(state.panes.treesByTabId, id)?.ssh?.connectionId;

function metricsSession(state: RootState, id: string) {
  const observed = state.sshSession.byTerminal[id]?.session;
  const session = observed?.connectionId === tagConnectionId(state, id) ? observed : undefined;
  const launch = selectSshLaunch(state, id);
  const ended = launch?.stage === 'ended' && launch.sessionGeneration === session?.generation;
  return { session, ended };
}

function currentSample(state: RootState, id: string) {
  const { session, ended } = metricsSession(state, id);
  return !ended && session?.state === 'connected' ? selectSshMetricsSample(state.sshSession, id) : undefined;
}

export function useSshMetrics(terminalId: string) {
  const store = useStore<RootState>();
  const connectionId = useSelector((s: RootState) => tagConnectionId(s, terminalId));
  const identity = useSelector((s: RootState) => {
    const connection = s.ssh.view.connections.find(c => c.id === connectionId);
    return connection ? `${connection.user}@${connection.host}` : connectionId ?? 'SSH host';
  });
  const hidden = useSelector((s: RootState) => selectSshHiddenMetrics(s, terminalId));
  const observed = useSelector((s: RootState) => s.sshSession.byTerminal[terminalId]?.session);
  const launch = useSelector((s: RootState) => selectSshLaunch(s, terminalId));
  const session = observed?.connectionId === connectionId ? observed : undefined;
  const ended = launch?.stage === 'ended' && launch.sessionGeneration === session?.generation;
  const sample = useSelector((s: RootState) => selectSshMetricsSample(s.sshSession, terminalId));
  const paused = useSelector((s: RootState) => selectSshMetricsPause(s.sshSession, terminalId));
  const unavailable = useSelector((s: RootState) => selectSshMetricsUnavailable(s.sshSession, terminalId));
  const delayed = useSelector((s: RootState) => s.sshSession.byTerminal[terminalId]?.metricsDelayed);
  const isCurrent = (s: RootState) => !!connectionId && tagConnectionId(s, terminalId) === connectionId;
  const { dispatch } = store;

  function setPreference(key?: MetricKey) {
    const state = store.getState();
    if (!isCurrent(state)) return;
    const hidden = selectSshHiddenMetrics(state, terminalId);
    const hiddenMetrics = key === undefined ? [] : hidden.includes(key)
      ? hidden.filter(k => k !== key) : [...hidden, key];
    dispatch(setSshHiddenMetrics({ terminalId, hiddenMetrics }));
  }

  async function copy() {
    const state = store.getState();
    const sample = isCurrent(state) && currentSample(state, terminalId);
    if (!sample) return;
    try {
      await writeClipboardText(formatSshMetricsCopy(sample));
      dispatch(addToast({ type: 'success', message: 'Copied SSH host metrics' }));
    } catch {
      dispatch(addToast({ type: 'error', message: 'Could not copy SSH host metrics' }));
    }
  }

  function resume() {
    const state = store.getState();
    const { session, ended } = metricsSession(state, terminalId);
    if (isCurrent(state) && !ended && session?.state === 'connected' && selectSshMetricsPause(state.sshSession, terminalId) !== null)
      void resumeSshMetrics(terminalId);
  }

  async function reconnect() {
    const state = store.getState();
    if (!isCurrent(state)) return;
    const { session, ended } = metricsSession(state, terminalId);
    const paused = selectSshMetricsPause(state.sshSession, terminalId);
    if (!ended && session?.state !== 'disconnected' && session?.state !== 'error' && paused === null) return;
    const result = await reconnectSshTerminal(terminalId);
    if (!result.ok) dispatch(addToast({ type: 'error', message: result.error.message }));
  }

  return { identity, hidden, sample: !ended && session?.state === 'connected' ? sample : undefined, session, ended, paused, unavailable, delayed, setPreference, copy, resume, reconnect };
}
