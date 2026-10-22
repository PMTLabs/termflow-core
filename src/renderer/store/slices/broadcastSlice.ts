import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { getAllTerminalIds } from './paneTreeOps';
import type { PaneNode } from './panesSlice';

// Window scope can be added as another discriminated branch; no persisted state.
export type BroadcastState = { mode: 'off' } | { mode: 'tab'; tabId: string };
const slice = createSlice({
  name: 'broadcast',
  initialState: { mode: 'off' } as BroadcastState,
  reducers: {
    startTabBroadcast: (_state, action: PayloadAction<string>): BroadcastState => ({ mode: 'tab', tabId: action.payload }),
    stopBroadcast: (): BroadcastState => ({ mode: 'off' }),
  },
});
export const { startTabBroadcast, stopBroadcast } = slice.actions;
export default slice.reducer;
type MembershipState = {
  broadcast?: BroadcastState;
  panes: { treesByTabId: Record<string, PaneNode | null> };
};
export const selectBroadcastMembers = createSelector(
  [(state: MembershipState) => state.broadcast, (state: MembershipState) => state.panes.treesByTabId],
  (broadcast, trees): string[] => broadcast?.mode === 'tab'
    ? getAllTerminalIds(trees[broadcast.tabId] ?? null) : [],
);
export function shouldStopBroadcast(state: MembershipState & {
  tabs: { activeTabId: string | null; tabs: Array<{ id: string; shellType: string }> };
}): boolean {
  const broadcast = state.broadcast;
  return broadcast?.mode === 'tab' && (state.tabs.activeTabId !== broadcast.tabId
    || !state.tabs.tabs.some(tab => tab.id === broadcast.tabId)
    || selectBroadcastMembers(state).length === 0);
}
