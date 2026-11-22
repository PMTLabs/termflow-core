import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { newerSshView, SshSessionView, type LaunchSnapshot } from '../../types/ssh';
import type { SshMetricsControl, SshMetricsSample, SshMetricsWatchReceipt } from '../../types/ssh';

export const SSH_METRICS_MAX_AGE = 5000;
export const SSH_METRICS_CLOCK_SKEW = 250;
export interface MetricsClock { mono: number; wall: number }
export interface MetricsFence extends MetricsClock {
  consumerId: string; generation: number; sampleFloor: number; trustWall: boolean;
}
interface MetricsReading { sample: SshMetricsSample; deadline: number; fence: MetricsFence }
export interface SshPaneState {
  connectionId: string; session?: SshSessionView; reattachedProcessId?: string; metrics?: Record<string, unknown>; files?: unknown[]; browserPath?: string;
  metricsFence?: MetricsFence; metricsPreviousFences?: MetricsFence[]; metricsReading?: MetricsReading; metricsLastStamp?: number;
  metricsControl?: SshMetricsControl; metricsUnavailable?: string; metricsDelayed?: boolean;
}

export function metricsClockChanged(fence: MetricsClock, now: MetricsClock): boolean {
  return Math.abs((now.wall - fence.wall) - (now.mono - fence.mono)) > SSH_METRICS_CLOCK_SKEW;
}
export function compareMetricsControl(a: SshMetricsControl, b?: SshMetricsControl): number {
  return b ? a.generation - b.generation || a.pauseSeq - b.pauseSeq : 1;
}
function disarmMetrics(pane: SshPaneState) {
  delete pane.metricsFence;
  delete pane.metricsPreviousFences;
  delete pane.metricsReading;
}
function reconcileMetricsControl(pane: SshPaneState, control: SshMetricsControl) {
  if (compareMetricsControl(control, pane.metricsControl) <= 0) return;
  pane.metricsControl = control;
  disarmMetrics(pane);
}
export interface SshSessionsState { byTerminal: Record<string, SshPaneState> }
const initialState: SshSessionsState = { byTerminal: {} };
const slice = createSlice({ name: 'sshSession', initialState, reducers: {
  sshOwnersChanged(state, action: PayloadAction<Record<string, string>>) {
    for (const id of Object.keys(state.byTerminal)) if (state.byTerminal[id].connectionId !== action.payload[id]) delete state.byTerminal[id];
    for (const [id, connectionId] of Object.entries(action.payload)) state.byTerminal[id] ??= { connectionId };
  },
  sshAttachmentResolved(state, { payload }: PayloadAction<{ terminalId: string; connectionId: string; reattachedProcessId?: string }>) {
    // A reattach can resolve before the owner sync creates the entry. Dropping the flag would
    // bring back the endless "Preparing SSH…" (P068-10), so create the entry for it. A later
    // owner sync keeps it (`??=`), or deletes it if the leaf is not tagged with this connection.
    // A fresh Create has nothing to record and must not create an entry early.
    const existing = state.byTerminal[payload.terminalId];
    if (!existing && !payload.reattachedProcessId) return;
    const pane = existing ?? (state.byTerminal[payload.terminalId] = { connectionId: payload.connectionId });
    if (pane.connectionId !== payload.connectionId) return;
    pane.reattachedProcessId = payload.reattachedProcessId;
  },
  sshSessionObserved(state, action: PayloadAction<SshSessionView>) {
    const view = action.payload;
    if (!view.terminalId || view.probeId) return;
    const pane = state.byTerminal[view.terminalId];
    if (!pane || pane.connectionId !== view.connectionId || !newerSshView(pane.session, view)) return;
    if (view.state !== 'connected' || pane.session?.state !== 'connected' || pane.session.generation !== view.generation) {
      disarmMetrics(pane);
      delete pane.metricsLastStamp;
      delete pane.metricsDelayed;
      delete pane.metricsControl;
      delete pane.metricsUnavailable;
    }
    pane.session = view;
    if (view.state !== 'connected') { delete pane.metrics; delete pane.files; }
  },
  sshLiveData(state, action: PayloadAction<{ terminalId: string; generation: number; metrics?: Record<string, unknown>; files?: unknown[] }>) {
    const pane = state.byTerminal[action.payload.terminalId];
    if (pane?.session?.state !== 'connected' || pane.session.generation !== action.payload.generation) return;
    pane.metrics = action.payload.metrics; pane.files = action.payload.files;
  },
  sshMetricsDisarmed(state, { payload: id }: PayloadAction<string>) {
    const pane = state.byTerminal[id];
    if (pane) {
      if (pane.metricsFence) pane.metricsDelayed = true;
      disarmMetrics(pane);
    }
  },
  sshMetricsUnavailable(state, { payload }: PayloadAction<{ terminalId: string; reason?: string }>) {
    const pane = state.byTerminal[payload.terminalId];
    if (pane?.session?.state === 'connected') pane.metricsUnavailable = payload.reason;
  },
  sshMetricsControlled(state, { payload }: PayloadAction<SshMetricsControl>) {
    const pane = state.byTerminal[payload.terminalId];
    if (pane?.session?.state === 'connected' && pane.session.generation === payload.generation) reconcileMetricsControl(pane, payload);
  },
  sshMetricsArmed(state, { payload }: PayloadAction<{
    terminalId: string; receipt: SshMetricsWatchReceipt; fence: MetricsFence;
  }>) {
    const { terminalId, receipt, fence } = payload;
    const pane = state.byTerminal[terminalId];
    if (pane?.session?.state !== 'connected' || pane.session.generation !== receipt.generation) return;
    const control = { terminalId, generation: receipt.generation, pauseSeq: receipt.pauseSeq, pausedReason: receipt.pausedReason };
    if (compareMetricsControl(control, pane.metricsControl) < 0) return;
    reconcileMetricsControl(pane, control);
    const previous = pane.metricsFence;
    if (previous?.consumerId === fence.consumerId && previous.generation === fence.generation) {
      // Keep only the overlapping window: in-flight collections may predate the newest floor.
      pane.metricsPreviousFences = [previous, ...(pane.metricsPreviousFences ?? [])]
        .filter(candidate => fence.mono - candidate.mono < SSH_METRICS_MAX_AGE);
    } else {
      disarmMetrics(pane);
    }
    pane.metricsFence = fence;
    delete pane.metricsUnavailable;
  },
  sshMetricsSampled(state, { payload }: PayloadAction<{ sample: SshMetricsSample; now: MetricsClock; consumerId: string }>) {
    const { sample, now, consumerId } = payload;
    const pane = state.byTerminal[sample.terminalId];
    const current = pane?.metricsFence;
    if (pane?.session?.state !== 'connected' || !current || current.consumerId !== consumerId || current.generation !== pane.session.generation
      || pane.metricsControl?.pausedReason != null || !Number.isSafeInteger(sample.sampledAt)
      || sample.sampledAt <= (pane.metricsLastStamp ?? -Infinity) || metricsClockChanged(current, now)
      || now.mono - current.mono >= SSH_METRICS_MAX_AGE) return;
    const fence = [current, ...(pane.metricsPreviousFences ?? [])].find(candidate => sample.sampledAt > candidate.sampleFloor
      && now.mono - candidate.mono < SSH_METRICS_MAX_AGE && !metricsClockChanged(candidate, now));
    if (!fence) return;
    const age = now.wall - sample.sampledAt;
    if (fence.trustWall && (age < 0 || age >= SSH_METRICS_MAX_AGE)) return;
    const deadline = Math.min(fence.mono + SSH_METRICS_MAX_AGE,
      fence.trustWall ? now.mono + SSH_METRICS_MAX_AGE - age : Infinity);
    if (now.mono >= deadline) return;
    delete pane.metricsDelayed;
    pane.metricsLastStamp = sample.sampledAt;
    pane.metricsReading = { sample, deadline, fence };
  },
  sshMetricsExpired(state, { payload }: PayloadAction<{ terminalId: string; mono: number }>) {
    const pane = state.byTerminal[payload.terminalId];
    if (pane?.metricsReading && payload.mono >= pane.metricsReading.deadline) {
      delete pane.metricsReading;
      pane.metricsDelayed = true;
    }
  },
} });
export const { sshOwnersChanged, sshAttachmentResolved, sshSessionObserved, sshLiveData, sshMetricsDisarmed, sshMetricsUnavailable,
  sshMetricsControlled, sshMetricsArmed, sshMetricsSampled, sshMetricsExpired } = slice.actions;

/** Pass a current clock at action time (Copy), not a snapshot captured by a render. */
export function selectSshMetricsSample(state: SshSessionsState, terminalId: string, now: MetricsClock = { mono: performance.now(), wall: Date.now() }): SshMetricsSample | undefined {
  const pane = state.byTerminal[terminalId];
  const fence = pane?.metricsFence;
  const reading = pane?.metricsReading;
  if (pane?.session?.state !== 'connected' || fence?.generation !== pane.session.generation || !fence || !reading
    || pane.metricsControl?.pausedReason != null || reading.sample.sampledAt <= reading.fence.sampleFloor
    || now.mono >= reading.deadline || metricsClockChanged(reading.fence, now) || metricsClockChanged(fence, now)
    || (reading.fence.trustWall && (reading.sample.sampledAt > now.wall || now.wall - reading.sample.sampledAt >= SSH_METRICS_MAX_AGE))) return undefined;
  return reading.sample;
}
export const selectSshMetricsPause = (state: SshSessionsState, id: string) =>
  state.byTerminal[id]?.session?.state === 'connected' ? state.byTerminal[id].metricsControl?.pausedReason ?? null : null;
export const selectSshMetricsUnavailable = (state: SshSessionsState, id: string) => state.byTerminal[id]?.metricsUnavailable;
export const sshFilesEnabled = (state: SshSessionsState, terminalId: string): boolean => state.byTerminal[terminalId]?.session?.state === 'connected';
export default slice.reducer;

export interface SshLaunchState {
  stage: LaunchSnapshot['stage'];
  sessionGeneration: number;
  launchSeq: number;
  revision: number;
}

interface LaunchSliceState {
  byTerminal: Record<string, SshLaunchState>;
  owners: Record<string, string>;
}

export function newerSshLaunch(previous: SshLaunchState | undefined, next: SshLaunchState): boolean {
  if (!previous) return true;
  if (next.sessionGeneration !== previous.sessionGeneration) return next.sessionGeneration > previous.sessionGeneration;
  if (next.launchSeq !== previous.launchSeq) return next.launchSeq > previous.launchSeq;
  return next.revision > previous.revision;
}

export function sshLaunchState(snapshot: LaunchSnapshot): SshLaunchState {
  return {
    stage: snapshot.stage, sessionGeneration: snapshot.attempt.sessionGeneration,
    launchSeq: snapshot.launchSeq, revision: snapshot.revision,
  };
}

const launchSlice = createSlice({
  name: 'sshLaunch',
  initialState: { byTerminal: {}, owners: {} } as LaunchSliceState,
  reducers: {
    sshLaunchObserved(state, { payload }: PayloadAction<LaunchSnapshot>) {
      if (state.owners[payload.terminalId] !== payload.connectionId) return;
      const next = sshLaunchState(payload);
      if (newerSshLaunch(state.byTerminal[payload.terminalId], next)) state.byTerminal[payload.terminalId] = next;
    },
  },
  extraReducers: builder => builder.addCase(sshOwnersChanged, (state, { payload }) => {
    for (const id of Object.keys(state.byTerminal)) {
      if (state.owners[id] !== payload[id]) delete state.byTerminal[id];
    }
    state.owners = payload;
  }),
});

export const { sshLaunchObserved } = launchSlice.actions;
export const sshLaunchReducer = launchSlice.reducer;
export function selectSshLaunch(state: { sshLaunch: LaunchSliceState }, terminalId: string): SshLaunchState | undefined {
  return state.sshLaunch.byTerminal[terminalId];
}
