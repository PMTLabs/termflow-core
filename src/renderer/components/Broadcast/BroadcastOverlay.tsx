import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { selectBroadcastMembers, stopBroadcast } from '../../store/slices/broadcastSlice';
import { terminalService } from '../../services/TerminalService';
import './BroadcastOverlay.css';

export function BroadcastOverlay() {
  const dispatch = useDispatch();
  const windowActive = useSelector((state: RootState) => state.broadcast.mode === 'window');
  const members = useSelector(selectBroadcastMembers);
  const shortcut = useSelector((state: RootState) => state.settings.customKeybindings?.stopBroadcastInput ?? 'Ctrl+Shift+B');
  // Re-evaluate readiness on every render; processless elevation prompts are not targets.
  const count = members.filter(id => terminalService.getProcessId(id)).length;
  if (!windowActive) return null;
  return <>
    <div className="broadcast-window-border" aria-hidden="true" />
    <div className="broadcast-banner" role="status">
      <span>Typing into all {count} open terminals across tabs · {shortcut} to stop</span>
      <button type="button" onClick={() => dispatch(stopBroadcast())}>Stop</button>
    </div>
  </>;
}
