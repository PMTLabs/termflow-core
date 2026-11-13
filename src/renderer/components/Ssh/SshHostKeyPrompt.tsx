import React, { useRef, useState } from 'react';
import { useDialogA11y } from '../UI/useDialogA11y';
import type { SshSessionView } from '../../types/ssh';
export function SshHostKeyPrompt({ view, onTrust, onCancel }: { view: SshSessionView; onTrust(): Promise<void>; onCancel(): void }) {
  const root = useRef<HTMLDivElement>(null), busy = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState(false);
  useDialogA11y(root, { isOpen: true, onCancel, initialFocus: 'cancel' });
  const allowed = view.state === 'needs-hostkey' && view.hostKey && !view.hostKey.changed;
  const trust = async () => {
    // Defense in depth, including direct handler invocation for a changed key.
    if (!allowed || busy.current) return;
    busy.current = true; setPending(true);
    try { await onTrust(); } catch { setError(true); } finally { busy.current = false; setPending(false); }
  };
  const target = view.promptTarget;
  return <div ref={root} role="dialog" aria-modal="true" aria-label="SSH host key" className="ssh-prompt">
    <h3>{allowed ? 'Unknown SSH host key' : 'SSH host key refused'}</h3>
    <p>{target && `${target.hop === 'jump' ? 'Jump host' : 'Target'}: ${target.user}@${target.host}:${target.port}`}</p>
    <p>{view.hostKey?.algorithm}</p><code>{view.hostKey?.fingerprintSha256}</code>
    <p>{allowed ? 'Verify this fingerprint independently before trusting.' : 'Update known_hosts with ssh-keygen. There is no override.'}</p>
    {error && <p role="alert">Host trust could not be saved.</p>}
    {allowed && <button disabled={pending} onClick={trust}>{pending ? 'Saving…' : 'Trust'}</button>}
    <button data-action="cancel" onClick={onCancel}>Cancel</button>
  </div>;
}
