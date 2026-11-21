import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { newerSshView, SshSessionView } from '../../types/ssh';
export interface SshPaneState { connectionId: string; session?: SshSessionView; metrics?: Record<string, unknown>; files?: unknown[]; browserPath?: string }
export interface SshSessionsState { byTerminal: Record<string, SshPaneState> }
const initialState: SshSessionsState = { byTerminal: {} };
const slice = createSlice({ name: 'sshSession', initialState, reducers: {
  sshOwnersChanged(state, action: PayloadAction<Record<string, string>>) {
    for (const id of Object.keys(state.byTerminal)) if (state.byTerminal[id].connectionId !== action.payload[id]) delete state.byTerminal[id];
    for (const [id, connectionId] of Object.entries(action.payload)) state.byTerminal[id] ??= { connectionId };
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
export const { sshOwnersChanged, sshSessionObserved, sshLiveData } = slice.actions;
export const sshFilesEnabled = (state: SshSessionsState, terminalId: string): boolean => state.byTerminal[terminalId]?.session?.state === 'connected';
export default slice.reducer;
