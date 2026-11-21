import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SshAPI, SshConnection, SshSessionView } from '../../types/ssh';
import { newerSshView } from '../../types/ssh';
import { useDialogA11y } from '../UI/useDialogA11y';
import { SshSecretPrompt } from './SshSecretPrompt';
import { SshHostKeyPrompt } from './SshHostKeyPrompt';
// Not `import { store }`: that module wires tauri-bridge listeners at load and breaks bare-root tests.
const reduxStore = () => (window as any).__REDUX_STORE__ as { getState(): any; dispatch(action: unknown): unknown } | undefined;
import { addToast } from '../../store/slices/uiSlice';
import './SshPaneShell.css';

/** Owns exactly one probe, including creation racing a dialog close/row change. */
export function startSshProbe(api: SshAPI, connectionId: string, observed: (view: SshSessionView) => void, failed: (error: unknown) => void): () => void {
  let disposed = false, creating = false, id: string | undefined, unlisten: (() => void) | undefined, latest: SshSessionView | undefined;
  const early = new Map<string, SshSessionView>();
  const accept = (view: SshSessionView) => {
    if (disposed || view.connectionId !== connectionId || !view.probeId) return;
    if (!id) { if ((early.has(view.probeId) || early.size < 32) && newerSshView(early.get(view.probeId), view)) early.set(view.probeId, view); return; }
    if (view.probeId === id && newerSshView(latest, view)) { latest = view; observed(view); }
  };
  // The one teardown: the backend close emits a final state event, so the bridge listener
  // stays registered until that close settles; removing it first leaves Tauri an orphaned callback id.
  const retire = (probe?: string) => {
    const stop = unlisten; unlisten = undefined;
    if (!probe) { stop?.(); return; }
    void api.sshTestClose(probe).catch(() => {}).finally(() => stop?.());
  };
  void (async () => {
    try {
      const stop = await api.onSshTestState(accept);
      if (disposed) { stop(); return; } unlisten = stop;
      creating = true;
      try { id = (await api.sshTestConnection(connectionId)).probeId; }
      finally { creating = false; if (disposed) retire(id); }
      if (disposed) return;
      const queued = early.get(id); early.clear(); if (queued) accept(queued);
      const snapshot = await api.sshTestState(id); accept(snapshot);
    } catch (error) { if (!disposed) failed(error); }
  })();
  return () => {
    if (disposed) return;
    disposed = true; // Fence queued events; the listener itself outlives the backend close.
    early.clear();
    if (!creating) retire(id); // While creating, the creation path retires the probe it gets back.
  };
}

export const failureCopy = new Map([
  ["not-connected","The SSH connection is not open. Try again."],
  ["not-found","The saved SSH connection could not be found. It may have been deleted or changed."],
  ["cancelled","The SSH attempt was cancelled."],
  ["stale-attempt","This SSH attempt is no longer current. Try again."],
  ["owner-retired","The SSH attempt was closed. Try again."],
  ["admission-closed","TermFlow is not accepting new SSH attempts. Reopen the app and try again."],
  ["invalid-target","The SSH destination is not valid. Check the saved host, port, user and jump host settings."],
  ["host-key-changed","The host key changed. Confirm the new fingerprint with the server's administrator before updating ~/.ssh/known_hosts. There is no override."],
  ["host-key-revoked","The host key has been revoked. Contact the server's administrator before trying again."],
  ["host-certificate-unsupported","This app does not support host certificate trust. Ask the server's administrator about a supported host key."],
  ["known-hosts-malformed","An entry in known_hosts could not be read. Repair the file before connecting."],
  ["known-hosts-unreadable","Could not read known_hosts. Check that the file is accessible."],
  ["trust-write-failed","Could not save host trust safely. Check access to known_hosts before retrying."],
  ["trust-already-pinned","The host already has a saved key. Try again to verify it."],
  ["auth-rejected","Authentication was not accepted. Check the server's allowed methods and the saved sign-in settings."],
  ["agent-unavailable","The OpenSSH agent could not sign in. Check that it is running, unlocked and has the correct key loaded."],
  ["capability-unavailable","The server did not allow a required SSH operation. If using a jump host, check that it allows forwarding to the target."],
  ["timed-out","The SSH connection timed out. Check the network and that the SSH service is listening on the configured port."],
  ["transport-closed","Could not open or keep the SSH connection. Check the host, port and network access."],
  ["output-too-large","The SSH response was too large. Try an operation that returns less output."],
  ["missing-exit-status","The server did not report how the command ended. Check its SSH logs before retrying."],
  ["identity-unreadable","Could not read the selected key file. Check its location, permissions and format."],
  ["unsupported-authentication","This sign-in method is not supported. Check which methods the server allows and select a supported one."],
  ["remember-unavailable","The credential was not saved. Check access to the system keyring before using Remember again."],
  ["store-unavailable","The SSH connection store is unavailable. Check that saved connections can be opened."],
]);
// The backend reasons above are context-neutral because they also reach SSH panes, the file
// browser and metrics. In this dialog the next step is a specific action, so these codes say so.
export const testDialogCopy = new Map([
  ["not-connected","The SSH connection is not open. Run Test connection again."],
  ["not-found","The saved connection could not be found. Reopen SSH Connections and select a saved connection."],
  ["cancelled","The SSH attempt was cancelled. Run Test connection again when ready."],
  ["stale-attempt","This SSH attempt is no longer current. Run Test connection again."],
  ["owner-retired","The SSH attempt was closed. Run Test connection again."],
  ["trust-already-pinned","The host already has a saved key. Run Test connection again to verify it."],
]);
const fallback = 'The SSH test could not finish. Check the saved connection settings and try again.';
const savedCredentialWarning = 'Saved credential unavailable. Enter it again; Remember may be unavailable.';

export function reasonCode(reason?: string): string | undefined {
  if (!reason) return undefined;
  const code = reason.replace(/^SSH operation failed: /, '');
  if (failureCopy.has(code)) return code;
  // Probe snapshots carry only the human reason; IPC command errors carry a code.
  if (reason === 'Authentication rejected. Check the selected method and credential.') return 'auth-rejected';
  if (/^An entry in known_hosts could not be read at line \d+\./.test(reason)) return 'known-hosts-malformed';
  for (const [key, message] of failureCopy) if (message === reason) return key;
  return undefined;
}

function authCopy(kind?: string, auth?: SshConnection['auth'], final = false) {
  if (kind === 'password' || (!kind && auth === 'password')) return "That password wasn't accepted." +
    (final ? ' Check the account name and password before testing again.' : ' Check it and try again.');
  if (kind === 'passphrase') return "That passphrase didn't unlock the key." +
    (final ? ' Check that the selected key file and its passphrase match before testing again.' : ' Check it and try again.');
  if (auth === 'keyFile') return "The server didn't accept this key. Check that the matching public key is authorized for this account.";
  return failureCopy.get('auth-rejected')!;
}

function endpoint(row: Pick<SshConnection, 'user' | 'host' | 'port'>) {
  return `${row.user ? row.user + '@' : ''}${row.host.includes(':') && !row.host.startsWith('[') ? '[' + row.host + ']' : row.host}:${row.port}`;
}

export function SshTestConnectionDialog({ connectionId, api, onClose }: { connectionId: string; api: SshAPI; onClose(): void }) {
  const root = useRef<HTMLDivElement>(null), dispose = useRef<() => void>(() => {});
  const [view, setView] = useState<SshSessionView>(), [failure, setFailure] = useState<{ code?: string }>();
  const lastCredential = useRef<Pick<SshSessionView, 'secretKind' | 'promptTarget'> | undefined>(undefined);
  const rows: SshConnection[] = reduxStore()?.getState().ssh?.view?.connections ?? [];
  const target = rows.find(row => row.id === connectionId);
  const jump = rows.find(row => row.id === target?.jumpConnectionId);
  const trustPrompt = view?.state === 'needs-hostkey' && !!view.hostKey && !view.hostKey.changed;
  const close = () => {
    dispose.current();
    // This dialog unmounts on close, so the outcome goes to the house toast.
    if (trustPrompt) reduxStore()?.dispatch(addToast({ type:'info', message:'Test cancelled. The host was not trusted.' }));
    onClose();
  };
  useDialogA11y(root, { isOpen: true, onCancel: close, initialFocus: 'first' });
  useLayoutEffect(() => {
    const node = root.current;
    if ((view || failure) && node && !node.contains(document.activeElement)) {
      (node.querySelector<HTMLElement>('[data-dialog-cancel], input[type=password]')
        ?? node.querySelector<HTMLElement>('.ssh-test-actions button'))?.focus();
    }
  }, [view, failure]);
  useEffect(() => {
    setView(undefined); setFailure(undefined); lastCredential.current = undefined;
    dispose.current = startSshProbe(api, connectionId, next => {
      if (next.state === 'needs-hostkey' || next.state === 'connected') lastCredential.current = undefined;
      if (next.state === 'needs-secret') lastCredential.current = { secretKind: next.secretKind, promptTarget: next.promptTarget };
      setView(next);
    }, error => setFailure({
      code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined,
    }));
    return dispose.current;
  }, [api, connectionId]);
  const receipt = { generation: view?.generation, promptId: view?.promptId };
  const changed = view?.state === 'error' && view.hostKey?.changed;
  const secretPrompt = !failure && view?.state === 'needs-secret';
  const finalFailure = !!failure || (view?.state === 'error' && !changed) || view?.state === 'disconnected';
  const code = failure ? failure.code : reasonCode(view?.reason);
  const credential = code === 'auth-rejected' ? lastCredential.current : undefined;
  const failedHop = view?.promptTarget ?? credential?.promptTarget;
  const destination = failedHop ? `${failedHop.hop === 'jump' ? 'jump host ' : ''}${endpoint(failedHop)}`
    : target ? `${endpoint(target)}${jump ? ' through jump host ' + endpoint(jump) : ''}` : undefined;
  const auth = failedHop?.hop === 'jump' ? jump?.auth : target?.auth;
  const message = code === 'auth-rejected' ? authCopy(credential?.secretKind, auth, true) : testDialogCopy.get(code ?? '') ?? failureCopy.get(code ?? '') ?? fallback;
  return createPortal(<div className="ssh-test-backdrop"><div className="ssh-test-dialog" ref={root} role="dialog" aria-modal="true" aria-label="Test SSH connection">
    <h2>Test SSH connection</h2>
    {secretPrompt && view ? <SshSecretPrompt key={view.promptId} view={{
      ...view, reason: code === 'auth-rejected' ? authCopy(view.secretKind) : view.reason === savedCredentialWarning ? savedCredentialWarning : view.reason ? fallback : undefined,
    }} onCancel={close} onSubmit={(secret, remember) => api.sshTestSubmitSecret(view.probeId!, secret, remember, receipt)} />
      : !failure && trustPrompt && view ? <SshHostKeyPrompt key={view.promptId} view={view} onCancel={close} onTrust={() => api.sshTestTrustHost(view.probeId!, true, receipt)} />
      : <>
        <div className="ssh-test-body">
          <p>Tests the native app channel only; no terminal or recent-use record is created.</p>
          {finalFailure && <p className="ssh-prompt-error" role="alert">{destination && `Couldn't complete the SSH test for ${destination}. `}{message}</p>}
          {!failure && (!view || view.state === 'connecting') && <p className="ssh-test-progress" role="status"><span className="ssh-spinner" aria-hidden="true" />Connecting…</p>}
          {!failure && changed && view && <SshHostKeyPrompt view={view} onCancel={close} onTrust={async () => {}} />}
          {!failure && view?.state === 'connected' && <p role="status">Connected. File and metric capabilities have not been tested.{view.reason && ` ${failureCopy.get('remember-unavailable')}`}</p>}
        </div>
        <div className="ssh-test-actions"><button type="button" className="au-btn" onClick={close}>Close</button></div>
      </>}
  </div></div>, document.body);
}
