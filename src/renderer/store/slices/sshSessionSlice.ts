import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { newerSshView, SshSessionView, type LaunchSnapshot } from '../../types/ssh';
export interface SshPaneState { connectionId: string; session?: SshSessionView; reattachedProcessId?: string; metrics?: Record<string, unknown>; files?: unknown[]; browserPath?: string }
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
    pane.session = view;
    if (view.state !== 'connected') { delete pane.metrics; delete pane.files; }
  },
  sshLiveData(state, action: PayloadAction<{ terminalId: string; generation: number; metrics?: Record<string, unknown>; files?: unknown[] }>) {
    const pane = state.byTerminal[action.payload.terminalId];
    if (pane?.session?.state !== 'connected' || pane.session.generation !== action.payload.generation) return;
    pane.metrics = action.payload.metrics; pane.files = action.payload.files;
  },
} });
export const { sshOwnersChanged, sshAttachmentResolved, sshSessionObserved, sshLiveData } = slice.actions;
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
