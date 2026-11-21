import React, { useId, useRef, useState } from 'react';
import { useSshPromptFocus } from './useSshPromptFocus';
import type { SshSessionView } from '../../types/ssh';
/** Backend `SAVED_CREDENTIAL_UNAVAILABLE` (ssh/session.rs): a saved secret could not be read. */
export const savedCredentialUnavailable = 'saved-credential-unavailable';
export interface SecretPromptProps { view: SshSessionView; onSubmit(secret: string, remember: boolean): Promise<void>; onCancel(): void }
export function SshSecretPrompt({ view, onSubmit, onCancel }: SecretPromptProps) {
  const root = useRef<HTMLDivElement>(null), busy = useRef(false);
  const [secret, setSecret] = useState(''), [remember, setRemember] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState<string>();
  useSshPromptFocus(root, onCancel, 'input[type=password]');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy.current) return;
    busy.current = true; setPending(true); setError(undefined);
    try { await onSubmit(secret, remember); }
    catch { setError('Could not submit credential. Check the current prompt.'); }
    finally { setSecret(''); setPending(false); busy.current = false; }
  };
  const target = view.promptTarget;
  const errorId = useId();
  // Branch on the snapshot's code, never on the backend's reason text (backlog 017).
  const reason = view.errorCode === 'auth-rejected'
    ? view.secretKind === 'passphrase' ? "That passphrase didn't unlock the key. Check it and try again." : "That password wasn't accepted. Check it and try again."
    : view.reason;
  const warning = !!reason && view.errorCode === savedCredentialUnavailable;
  const fieldError = error ?? (warning ? undefined : reason);
  return <div ref={root} role="region" aria-label="SSH authentication" className="ssh-prompt">
    <form onSubmit={submit}>
      <div className="ssh-prompt-body">
        <h3>{view.secretKind === 'passphrase' ? 'Unlock SSH key' : 'SSH password'}</h3>
        <p>{target ? `${target.hop === 'jump' ? 'Jump host' : 'Target'}: ${target.user}@${target.host}:${target.port}` : 'SSH authentication'}</p>
        <p>{view.secretKind === 'passphrase' ? 'The app unlocks the key locally. The passphrase is not sent to the server or typed into the terminal.' : 'The app channel signs in separately. This credential is never typed into the terminal.'}</p>
        {warning && <p role="status">{reason}</p>}
        {fieldError && <p id={errorId} role="alert" className="ssh-prompt-error">{fieldError}</p>}
        <label>{view.secretKind === 'passphrase' ? 'Passphrase' : 'Password'}<input type="password" autoComplete="off" aria-invalid={fieldError ? true : undefined} aria-describedby={fieldError ? errorId : undefined} value={secret} readOnly={pending} onChange={e => setSecret(e.target.value)} /></label>
        <label className="ssh-prompt-check"><input type="checkbox" className="setting-checkbox" checked={remember} aria-disabled={pending} onChange={e => { if (!pending) setRemember(e.target.checked); }} />Remember for the app channel</label>
      </div>
      <div className="ssh-test-actions">
        <button type="button" className="au-btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="au-btn primary" aria-disabled={pending}>{pending ? 'Submitting…' : 'Continue'}</button>
      </div>
    </form>
  </div>;
}
