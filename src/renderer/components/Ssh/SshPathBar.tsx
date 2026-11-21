import React from 'react';

interface Props {
  draft: string;
  setDraft(value: string): void;
  path?: string;
  navigate(path: string): void;
  followCd: boolean;
  onFollowChange(value: boolean): void;
  disabled: boolean;
  reason?: string;
}

export function SshPathBar({ draft, setDraft, path, navigate, followCd, onFollowChange, disabled, reason }: Props) {
  const parent = path && path !== '/' ? (path.slice(0, path.lastIndexOf('/')) || '/') : undefined;
  return <form className="ssh-path-bar" onSubmit={event => {
    event.preventDefault();
    if (!disabled) navigate(draft);
  }}>
    <button type="button" className="au-btn" disabled={disabled || !parent}
      title={reason ?? 'Up one folder'} onClick={() => parent && navigate(parent)}>Up</button>
    <input aria-label="Remote path" title={reason ?? 'Enter an absolute remote path and press Enter'}
      value={draft} onChange={event => setDraft(event.target.value)} disabled={disabled} spellCheck={false} />
    <label title={reason ?? 'Follow the remote shell’s reported directory'}>
      <input className="setting-checkbox" type="checkbox" checked={followCd} disabled={disabled}
        onChange={event => onFollowChange(event.target.checked)} /> Follow cd
    </label>
  </form>;
}
