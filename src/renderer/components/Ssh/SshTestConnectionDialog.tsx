import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SshAPI, SshSessionView } from '../../types/ssh';
import { newerSshView } from '../../types/ssh';
import { useDialogA11y } from '../UI/useDialogA11y';
import { SshSecretPrompt } from './SshSecretPrompt';
import { SshHostKeyPrompt } from './SshHostKeyPrompt';
import './SshPaneShell.css';

/** Owns exactly one probe, including creation racing a dialog close/row change. */
export function startSshProbe(api: SshAPI, connectionId: string, observed: (view: SshSessionView) => void, failed: () => void): () => void {
  let disposed = false, id: string | undefined, unlisten: (() => void) | undefined, latest: SshSessionView | undefined;
  const early = new Map<string, SshSessionView>();
  const accept = (view: SshSessionView) => {
    if (disposed || view.connectionId !== connectionId || !view.probeId) return;
    if (!id) { if (early.size < 32) early.set(view.probeId, view); return; }
    if (view.probeId === id && newerSshView(latest, view)) { latest = view; observed(view); }
  };
  void (async () => {
    try {
      const stop = await api.onSshTestState(accept);
      if (disposed) { stop(); return; } unlisten = stop;
      const reply = await api.sshTestConnection(connectionId); id = reply.probeId;
      if (disposed) { await api.sshTestClose(id); return; }
      const queued = early.get(id); early.clear(); if (queued) accept(queued);
      const snapshot = await api.sshTestState(id); accept(snapshot);
    } catch { if (!disposed) failed(); }
  })();
  return () => { if (disposed) return; disposed = true; unlisten?.(); if (id) void api.sshTestClose(id).catch(() => {}); };
}
export function SshTestConnectionDialog({ connectionId, api, onClose }: { connectionId: string; api: SshAPI; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null), dispose = useRef<() => void>(() => {});
  const [view, setView] = useState<SshSessionView>(), [error, setError] = useState(false);
  const close = () => { dispose.current(); onClose(); };
  useDialogA11y(root, { isOpen: true, onCancel: close, initialFocus: 'first' });
  useEffect(() => {
    setView(undefined); setError(false);
    dispose.current = startSshProbe(api, connectionId, setView, () => setError(true));
    return dispose.current;
  }, [api, connectionId]);
  const receipt = { generation: view?.generation, promptId: view?.promptId };
  return createPortal(<div className="ssh-test-backdrop"><div className="ssh-test-dialog" ref={root} role="dialog" aria-modal="true" aria-label="Test SSH connection">
    <h2>Test SSH connection</h2><p>Tests the native app channel only; no terminal or recent-use record is created.</p>
    {error && <p role="alert">Unable to test this connection.</p>}
    {!error && (!view || view.state === 'connecting') && <p role="status">Connecting…</p>}
    {view?.state === 'needs-secret' && <SshSecretPrompt key={view.promptId} view={view} onCancel={close} onSubmit={(secret, remember) => api.sshTestSubmitSecret(view.probeId!, secret, remember, receipt)} />}
    {(view?.state === 'needs-hostkey' || (view?.state === 'error' && view.hostKey?.changed)) && <SshHostKeyPrompt key={view.promptId} view={view} onCancel={close} onTrust={() => api.sshTestTrustHost(view.probeId!, true, receipt)} />}
    {view?.state === 'connected' && <p role="status">Connected. File and metric capabilities have not been tested.{view.reason && ` ${view.reason}`}</p>}
    {((view?.state === 'error' && !view.hostKey?.changed) || view?.state === 'disconnected') && <p role="alert">{view.reason || 'Connection ended.'}</p>}
    <button onClick={close}>Close</button>
  </div></div>, document.body);
}
