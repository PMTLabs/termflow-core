import React from 'react';
import type { LaunchAttemptRef, LaunchSnapshot, SshPromptReceipt, SshSessionView } from '../../types/ssh';
import { isWaitingForSshLaunch } from '../../services/sshLaunchAttempt';
import { SshHostKeyPrompt } from './SshHostKeyPrompt';
import { SshSecretPrompt } from './SshSecretPrompt';
import './SshPaneShell.css';
import './SshLaunchNotice.css';
import '../Settings/Automations/AutomationsPanel.css';

const stageCopy: Record<LaunchSnapshot['stage'], string> = {
  preparing: 'Preparing SSH…',
  'waiting-ready': 'Waiting for the local shell prompt…',
  'waiting-trust': 'Waiting for host verification…',
  typed: 'SSH command queued for the terminal.',
  running: 'SSH is running in the terminal.',
  ended: 'SSH has ended.',
  blocked: 'SSH launch blocked.',
  cancelled: 'SSH launch cancelled.',
  error: 'SSH launch failed.',
};

export interface SshLaunchNoticeProps {
  snapshot?: LaunchSnapshot;
  view?: SshSessionView;
  failure?: string;
  retrying?: boolean;
  canCancel?: boolean;
  onCancel(attempt: LaunchAttemptRef): void;
  onReconnect(): void;
  onTrust(receipt: SshPromptReceipt): Promise<void>;
  onSecret(secret: string, remember: boolean, receipt: SshPromptReceipt): Promise<void>;
}

export function SshLaunchNotice(props: SshLaunchNoticeProps) {
  const { snapshot, view, failure } = props;
  const stage = snapshot?.stage ?? (failure ? 'error' : 'preparing');
  const waiting = isWaitingForSshLaunch(stage);
  const currentView = snapshot && view?.generation === snapshot.attempt.sessionGeneration ? view : undefined;
  const receipt = currentView?.promptId && currentView.generation !== undefined
    ? { generation: currentView.generation, promptId: currentView.promptId } : undefined;
  const promptKey = receipt && `${receipt.generation}:${receipt.promptId}`;
  const promptWindow = waiting || stage === 'typed' || stage === 'running';
  const host = promptWindow && !!receipt && currentView?.state === 'needs-hostkey' && !!currentView.hostKey;
  const secret = promptWindow && !!receipt && currentView?.state === 'needs-secret';
  const sessionReason = currentView?.reason ?? snapshot?.attempt.attemptReceipt.reason;
  const reason = stage === 'blocked' && snapshot?.error?.code === 'TrustBlocked'
    ? sessionReason || snapshot.error.message
    : snapshot?.error?.message || (stage === 'blocked' || stage === 'error' ? sessionReason : undefined);
  const cancel = () => { if (snapshot) props.onCancel(snapshot.attempt); };
  const reconnect = stage === 'ended' || ((stage === 'typed' || stage === 'running') && currentView?.state === 'disconnected');
  return <section className="ssh-launch-notice" aria-label="SSH launch">
    <div className="ssh-launch-strip">
      <span role="status">{stageCopy[stage]}</span>
      {waiting && snapshot && props.canCancel !== false && !host && !secret &&
        <button type="button" className="au-btn" onClick={cancel}>Cancel</button>}
      {(stage === 'blocked' || stage === 'error' || stage === 'cancelled' || reconnect) &&
        <button type="button" className="au-btn" disabled={props.retrying} onClick={props.onReconnect}>{reconnect ? 'Reconnect' : 'Retry'}</button>}
    </div>
    {snapshot?.error?.code === 'Timeout' && <div role="status">Return to the local shell prompt</div>}
    {reason && <div role="alert">{reason}</div>}
    {failure && failure !== reason && <div role="alert">{failure}</div>}
    {host && receipt && <SshHostKeyPrompt key={promptKey} view={currentView} onTrust={() => props.onTrust(receipt)} onCancel={cancel} />}
    {secret && receipt && <SshSecretPrompt key={promptKey} view={currentView} onSubmit={(value, remember) => props.onSecret(value, remember, receipt)} onCancel={cancel} />}
  </section>;
}
