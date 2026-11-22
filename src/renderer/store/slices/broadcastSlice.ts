import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { getAllTerminalIds } from './paneTreeOps';
import type { PaneNode } from './panesSlice';
import { CANVAS_SHELL_TYPE } from '../../services/tabKinds';

// Window-local and never persisted.
export type BroadcastState = { mode: 'off' } | { mode: 'tab'; tabId: string } | { mode: 'window' };
const slice = createSlice({
  name: 'broadcast',
  initialState: { mode: 'off' } as BroadcastState,
  reducers: {
    startTabBroadcast: (_state, action: PayloadAction<string>): BroadcastState => ({ mode: 'tab', tabId: action.payload }),
    startWindowBroadcast: (): BroadcastState => ({ mode: 'window' }),
    stopBroadcast: (): BroadcastState => ({ mode: 'off' }),
  },
});
export const { startTabBroadcast, startWindowBroadcast, stopBroadcast } = slice.actions;
export default slice.reducer;
type MembershipState = {
  broadcast?: BroadcastState;
  panes: { treesByTabId: Record<string, PaneNode | null> };
  tabs: { tabs: Array<{ id: string; shellType: string }> };
};
export const selectBroadcastMembers = createSelector(
  [(state: MembershipState) => state.broadcast, (state: MembershipState) => state.panes.treesByTabId,
    (state: MembershipState) => state.tabs.tabs],
  (broadcast, trees, tabs): string[] => broadcast?.mode === 'tab'
    ? getAllTerminalIds(trees[broadcast.tabId] ?? null)
    : broadcast?.mode === 'window' ? [...new Set(tabs.flatMap(tab => getAllTerminalIds(trees[tab.id] ?? null)))] : [],
);
export function shouldStopBroadcast(state: MembershipState & {
  tabs: { activeTabId: string | null; tabs: Array<{ id: string; shellType: string }> };
}): boolean {
  const broadcast = state.broadcast;
  if (!broadcast || broadcast.mode === 'off') return false;
  // Canvas nodes lack the pane ring and click-to-cancel safety cues.
  return state.tabs.tabs.some(tab => tab.id === state.tabs.activeTabId && tab.shellType === CANVAS_SHELL_TYPE)
    || selectBroadcastMembers(state).length === 0
    || (broadcast.mode === 'tab' && (state.tabs.activeTabId !== broadcast.tabId
      || !state.tabs.tabs.some(tab => tab.id === broadcast.tabId)));
}
