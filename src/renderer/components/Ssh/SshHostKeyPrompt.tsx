import React, { useRef, useState } from 'react';
import { useSshPromptFocus } from './useSshPromptFocus';
import type { SshSessionView } from '../../types/ssh';
export function SshHostKeyPrompt({ view, onTrust, onCancel }: { view: SshSessionView; onTrust(): Promise<void>; onCancel(): void }) {
  const root = useRef<HTMLDivElement>(null), busy = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState(false);
  const allowed = view.state === 'needs-hostkey' && !!view.hostKey && !view.hostKey.changed;
  useSshPromptFocus(root, onCancel, '[data-dialog-cancel]', allowed);
  const trust = async () => {
    // Defense in depth, including direct handler invocation for a changed key.
    if (!allowed || busy.current) return;
    busy.current = true; setPending(true);
    try { await onTrust(); } catch { setError(true); } finally { busy.current = false; setPending(false); }
  };
  const target = view.promptTarget;
  return <div ref={root} role="region" aria-label="SSH host key" className="ssh-prompt">
    <div className={allowed ? 'ssh-prompt-body' : 'ssh-prompt-error'} role={allowed ? undefined : 'alert'}>
      <h3>{allowed ? 'Unknown SSH host key' : 'SSH host key refused'}</h3>
      <p>{target && `${target.hop === 'jump' ? 'Jump host' : 'Target'}: ${target.user}@${target.host}:${target.port}`}</p>
      <p>Fingerprint the server presented now ({view.hostKey?.algorithm}): <code>{view.hostKey?.fingerprintSha256}</code></p>
      {allowed ? <>
        <p>Verify this fingerprint independently before trusting.</p>
        <p>Trust saves this host’s fingerprint and checks future connections against it.</p>
      </> : <p>Confirm this fingerprint with the server’s administrator before updating the saved key in <code>{(target?.hop === 'jump' ? view.knownHostsPaths?.jump : view.knownHostsPaths?.target) ?? '~/.ssh/known_hosts'}</code>. There is no override.</p>}
      {error && <p role="alert" className="ssh-prompt-error">Host trust could not be saved. Check access to known_hosts and try again.</p>}
    </div>
    {allowed && <div className="ssh-test-actions">
      <button className="au-btn" data-dialog-cancel data-action="cancel" onClick={onCancel}>Cancel</button>
      <button className="au-btn primary" aria-disabled={pending} onClick={trust}>{pending ? 'Saving…' : 'Trust'}</button>
    </div>}
  </div>;
}
