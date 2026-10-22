import { isBroadcastAvailable } from '@termflow/terminal-core';
import type { RootState } from '../../store';
import { getAllTerminalIds } from '../../store/slices/paneTreeOps';
import { startTabBroadcast, startWindowBroadcast, stopBroadcast } from '../../store/slices/broadcastSlice';

export function broadcastMenuItems(state: RootState, owningTabId: string | undefined, dispatch: (action: ReturnType<typeof startTabBroadcast> | ReturnType<typeof startWindowBroadcast> | ReturnType<typeof stopBroadcast>) => unknown) {
  const active = state.broadcast?.mode === 'tab' && state.broadcast.tabId === owningTabId;
  const available = isBroadcastAvailable();
  const windowActive = state.broadcast?.mode === 'window';
  const windowCount = new Set(state.tabs.tabs.flatMap(tab => getAllTerminalIds(state.panes.treesByTabId[tab.id] ?? null))).size;
  return [{
    icon: active ? '⏹️' : '⌨️',
    label: active ? 'Stop focusing all panes' : available ? 'Focus all panes in this tab' : 'Focus all panes in this tab — Unavailable',
    enabled: active || (available && !!owningTabId && getAllTerminalIds(state.panes.treesByTabId[owningTabId] ?? null).length >= 2),
    accelerator: active ? state.settings.customKeybindings?.stopBroadcastInput ?? 'Ctrl+Shift+B' : undefined,
    click: () => { if (owningTabId) dispatch(active ? stopBroadcast() : startTabBroadcast(owningTabId)); },
  }, {
    icon: windowActive ? '⏹️' : '📢',
    label: windowActive ? 'Stop focusing all panes' : available ? 'Focus all panes in all tabs' : 'Focus all panes in all tabs — Unavailable',
    enabled: windowActive || (available && windowCount >= 2),
    accelerator: windowActive ? state.settings.customKeybindings?.stopBroadcastInput ?? 'Ctrl+Shift+B' : undefined,
    click: () => dispatch(windowActive ? stopBroadcast() : startWindowBroadcast()),
  }];
}
