import { deliverBroadcast, setBroadcastSink } from '@termflow/terminal-core';
import type { store as appStore } from '../store';
import { selectBroadcastMembers } from '../store/slices/broadcastSlice';
import { terminalService } from './TerminalService';

export function installInputBroadcast(store: Pick<typeof appStore, 'getState' | 'subscribe'>): () => void {
  let active: boolean | undefined;
  const update = () => {
    const on = store.getState().broadcast.mode !== 'off';
    if (active === on) return;
    active = on;
    setBroadcastSink(on ? (source, unit) => {
      const members = selectBroadcastMembers(store.getState());
      if (!members.includes(source)) return;
      for (const target of members) {
        if (target !== source && terminalService.getProcessId(target)) deliverBroadcast(target, unit);
      }
    } : null, on ? (target, data) => terminalService.writeToTerminal(target, data) : null);
  };
  update();
  const unsubscribe = store.subscribe(update);
  return () => { unsubscribe(); setBroadcastSink(null); };
}
