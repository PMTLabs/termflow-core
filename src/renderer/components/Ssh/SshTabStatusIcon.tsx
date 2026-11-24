import React from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { SshIcon } from './SshIcons';
import { sshConnectionPhase, tagConnectionId } from './sshStatusLiveness';

const labels = { connected: 'Connected', connecting: 'Connecting', disconnected: 'Disconnected' };

export function SshTabStatusIcon({ terminalId, exited, fallback }: {
  terminalId?: string;
  exited?: boolean;
  fallback: React.ReactNode;
}) {
  const connectionId = useSelector((state: RootState) => terminalId ? tagConnectionId(state, terminalId) : undefined);
  const phase = useSelector((state: RootState) => terminalId && connectionId
    ? sshConnectionPhase(state, terminalId) : null);
  const name = useSelector((state: RootState) => connectionId
    ? state.ssh.view.connections.find(row => row.id === connectionId)?.name : undefined);
  if (!phase) return <>{fallback}</>;
  const status = exited ? 'disconnected' : phase;
  const tooltip = `${name ?? 'SSH connection'} — ${labels[status]}${exited ? ' — process exited, kept open for review' : ''}`;
  return <span className="tab-icon tab-ssh-icon" title={tooltip} role="img" aria-label={tooltip}>
    <SshIcon name="server" size={14} />
    <span className={`tab-ssh-dot ${status}`} aria-hidden="true" />
  </span>;
}
