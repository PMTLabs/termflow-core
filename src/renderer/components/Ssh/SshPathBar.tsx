import React from 'react';
import { AuCheck } from '../Automation/panels/AuFields';
import { SshIcon } from './SshIcons';

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
      aria-label="Up one folder" title={reason ?? 'Up one folder'} onClick={() => parent && navigate(parent)}><SshIcon name="up" /></button>
    <input aria-label="Remote path" title={reason ?? 'Enter an absolute remote path and press Enter'}
      value={draft} onChange={event => setDraft(event.target.value)} disabled={disabled} spellCheck={false} />
    <span className="ssh-follow-cd" title={reason ?? 'Follow the remote shell’s reported directory'}>
      <AuCheck label="Follow cd" on={followCd} onToggle={() => onFollowChange(!followCd)} disabled={disabled} />
    </span>
  </form>;
}
