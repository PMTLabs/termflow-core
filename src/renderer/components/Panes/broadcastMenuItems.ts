import { isBroadcastAvailable } from '@termflow/terminal-core';
import type { RootState } from '../../store';
import { getAllTerminalIds } from '../../store/slices/paneTreeOps';
import { startTabBroadcast, stopBroadcast } from '../../store/slices/broadcastSlice';

export function broadcastMenuItems(state: RootState, owningTabId: string | undefined, dispatch: (action: ReturnType<typeof startTabBroadcast> | ReturnType<typeof stopBroadcast>) => unknown) {
  const active = state.broadcast?.mode === 'tab' && state.broadcast.tabId === owningTabId;
  const available = isBroadcastAvailable();
  return [{
    label: active ? 'Stop focusing all panes' : available ? 'Focus all panes in this tab' : 'Focus all panes in this tab — Unavailable',
    enabled: active || (available && !!owningTabId && getAllTerminalIds(state.panes.treesByTabId[owningTabId] ?? null).length >= 2),
    accelerator: active ? state.settings.customKeybindings?.stopBroadcastInput ?? 'Ctrl+Shift+B' : undefined,
    click: () => { if (owningTabId) dispatch(active ? stopBroadcast() : startTabBroadcast(owningTabId)); },
  }];
}
