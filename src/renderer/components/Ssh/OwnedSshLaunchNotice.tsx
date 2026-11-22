import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSurfaceHost } from '../../services/surfaceHosts';
import { useSelector } from 'react-redux';
import { store, type RootState } from '../../store';
import { newerSshLaunch, selectSshLaunch, sshLaunchObserved, sshLaunchState, sshSessionObserved } from '../../store/slices/sshSessionSlice';
import { paneIncarnations, type PaneCapture } from '../../services/paneIncarnations';
import { terminalService } from '../../services/TerminalService';
import { reconnectSshTerminal } from '../../services/sshLaunch';
import { sshLaunchFailure, staleSshLaunch } from '../../services/sshLaunchAttempt';
import { watchSshLaunch } from '../../services/sshLaunchGate';
import type { LaunchAttemptRef, LaunchSnapshot, SshPromptReceipt } from '../../types/ssh';
import { launchSshInTab } from '../../services/sshPicker';
import { addToast } from '../../store/slices/uiSlice';
import { SshLaunchNotice, SshLaunchStrip } from './SshLaunchNotice';

interface Props {
  terminalId: string;
  paneId: string;
  owner: PaneCapture;
  processId: string;
  connectionId: string;
}

export function OwnedSshLaunchNotice({ terminalId, paneId, owner, processId, connectionId }: Props) {
  const pane = useSelector((state: RootState) => state.sshSession.byTerminal[terminalId]);
  const view = pane?.session;
  const reattached = pane?.connectionId === connectionId && pane?.reattachedProcessId === processId;
  const summary = useSelector((state: RootState) => selectSshLaunch(state, terminalId));
  const surface = useSurfaceHost(terminalId);
  const [binding, setBinding] = useState<{ owner: PaneCapture; snapshot: LaunchSnapshot }>();
  const snapshot = binding?.owner === owner ? binding.snapshot : undefined;
  const [failure, setFailure] = useState<{ code: string; message: string }>();
  const [retrying, setRetrying] = useState(false);
  const flight = useRef(false);
  const watch = useRef<ReturnType<typeof watchSshLaunch> | undefined>(undefined);
  const live = useRef<() => boolean>(() => false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onSshLaunchState) return; // Browser / non-native bridge.
    let mounted = true;
    const current = () => mounted && paneIncarnations.isCurrent(terminalId, paneId, owner)
      && terminalService.getProcessId(terminalId) === processId;
    live.current = current;
    setFailure(undefined);
    setRetrying(false);
    flight.current = false;
    const observer = watchSshLaunch({
      terminalId,
      subscribe: listener => api.onSshLaunchState!(listener),
      query: () => terminalService.querySshLaunch(terminalId, paneId, owner, processId, connectionId, current),
      observed: result => {
        if (!current()) return;
        store.dispatch(sshSessionObserved(result.session));
        const next = result.snapshot;
        if (!next) return;
        store.dispatch(sshLaunchObserved(next));
        setBinding(old => !old || old.owner !== owner || newerSshLaunch(sshLaunchState(old.snapshot), sshLaunchState(next))
          ? { owner, snapshot: next } : old);
      },
      failed: error => { if (current()) setFailure(sshLaunchFailure(error)); },
    });
    watch.current = observer;
    return () => { mounted = false; observer.stop(); };
  }, [terminalId, paneId, owner, processId, connectionId]);

  // A session generation can reserve before its launch record is registered.
  // Refresh a settled pane too, including reconnects initiated outside this notice.
  useEffect(() => { watch.current?.refresh(); }, [summary?.sessionGeneration, view?.generation]);

  const cancel = async (attempt: LaunchAttemptRef) => {
    const current = live.current;
    if (!current()) return;
    try {
      await window.electronAPI.ssh?.cancelTerminalLaunch(terminalId, attempt);
      if (current()) watch.current?.refresh();
    } catch (error) {
      if (current()) setFailure(sshLaunchFailure(error));
    }
  };

  const reconnect = async () => {
    const current = live.current;
    if (!current() || flight.current) return;
    flight.current = true;
    setRetrying(true);
    setFailure(undefined);
    try {
      const result = await reconnectSshTerminal(terminalId);
      if (!current()) return;
      if (!result.ok) setFailure(result.error);
      watch.current?.refresh();
    } finally {
      if (current()) {
        flight.current = false;
        setRetrying(false);
      }
    }
  };

  const requireCurrentPrompt = (receipt: SshPromptReceipt) => {
    const latest = store.getState().sshSession.byTerminal[terminalId]?.session;
    if (!live.current() || !receipt.promptId || receipt.generation === undefined
        || latest?.generation !== receipt.generation || latest.promptId !== receipt.promptId) throw staleSshLaunch;
  };

  if (!window.electronAPI?.onSshLaunchState) return null;
  // Keep the strip while waiting for adoption, but never show stale controls.
  const current = snapshot?.attempt.processIncarnation === processId && (view?.generation ?? 0) <= snapshot.attempt.sessionGeneration
    ? snapshot : undefined;
  const notice = reattached && !current && !summary
    ? <SshLaunchStrip status="This SSH session continued from before TermFlow restarted. The terminal still works; files and status aren't available for it.">
      <button type="button" className="au-btn" onClick={() => {
        const error = launchSshInTab(connectionId);
        if (error) store.dispatch(addToast({ message: error, type: 'warning' }));
      }}>Open a new SSH tab</button>
    </SshLaunchStrip>
    : <SshLaunchNotice snapshot={current} view={view} failure={failure} retrying={retrying}
    onCancel={cancel} onReconnect={reconnect}
    onTrust={async receipt => {
      requireCurrentPrompt(receipt);
      await window.electronAPI.sshSessionTrustHost(terminalId, true, receipt);
    }}
    onSecret={async (secret, remember, receipt) => {
      requireCurrentPrompt(receipt);
      await window.electronAPI.sshSessionSubmitSecret(terminalId, secret, remember, receipt);
    }} />;
  return surface?.parentElement ? createPortal(notice, surface.parentElement) : notice;
}
