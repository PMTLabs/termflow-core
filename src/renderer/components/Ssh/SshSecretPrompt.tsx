import React, { useRef, useState } from 'react';
import { useSshPromptFocus } from './useSshPromptFocus';
import type { SshSessionView } from '../../types/ssh';
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
  return <div ref={root} role="region" aria-label="SSH authentication" className="ssh-prompt">
    <h3>{view.secretKind === 'passphrase' ? 'Unlock SSH key' : 'SSH password'}</h3>
    <p>{target ? `${target.hop === 'jump' ? 'Jump host' : 'Target'}: ${target.user}@${target.host}:${target.port}` : 'SSH authentication'}</p>
    <p>The app channel signs in separately. This credential is never typed into the terminal.</p>
    {view.reason && <p role="status">{view.reason}</p>}{error && <p role="alert">{error}</p>}
    <form onSubmit={submit}>
      <label>{view.secretKind === 'passphrase' ? 'Passphrase' : 'Password'}<input type="password" autoComplete="off" value={secret} readOnly={pending} onChange={e => setSecret(e.target.value)} /></label>
      <label><input type="checkbox" checked={remember} disabled={pending} onChange={e => setRemember(e.target.checked)} />Remember for the app channel</label>
      <button type="submit" aria-disabled={pending}>{pending ? 'Submitting…' : 'Continue'}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  </div>;
}
