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

export function sshLaunchEndReason(error?: LaunchSnapshot['error']): string | undefined {
  switch (error?.code) {
    case 'SshExitedBeforeConnecting': return 'SSH exited before connecting. Check the terminal output above for the reason.';
    case 'TransportClosed': return 'The local terminal connection closed. Reconnect to try again.';
    // No reason code (an ordinary ssh exit carries no status yet, backlog 023): point at the terminal.
    case undefined: return 'The reason, if any, is in the terminal output above. Reconnect to try again.';
    default: return error?.message;
  }
}

export interface SshLaunchNoticeProps {
  snapshot?: LaunchSnapshot;
  view?: SshSessionView;
  /** A launch, cancel or reconnect call that failed; hidden when its code is the error already shown. */
  failure?: { code: string; message: string };
  retrying?: boolean;
  canCancel?: boolean;
  onCancel(attempt: LaunchAttemptRef): void;
  onReconnect(): void;
  onTrust(receipt: SshPromptReceipt): Promise<void>;
  onSecret(secret: string, remember: boolean, receipt: SshPromptReceipt): Promise<void>;
}

export function SshLaunchStrip({ status = stageCopy.preparing, children, overlay }: {
  status?: string;
  children?: React.ReactNode;
  overlay?: React.ReactNode;
}) {
  return <section className="ssh-launch-notice" data-ssh-keyboard-owner="" aria-label="SSH launch">
    <div className="ssh-launch-strip">
      <span role="status" title={status}>{status}</span>
      {children}
    </div>
    {overlay}
  </section>;
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
  const receiptSource = currentView?.reason === undefined ? snapshot?.attempt.attemptReceipt : undefined;
  const sessionReason = currentView?.reason ?? receiptSource?.reason;
  const sessionCode = currentView?.reason === undefined ? receiptSource?.errorCode : currentView.errorCode;
  const shown = stage === 'blocked' && snapshot?.error?.code === 'TrustBlocked'
    ? (sessionReason ? { message: sessionReason, code: sessionCode } : snapshot.error)
    : snapshot?.error?.message ? snapshot.error
      : stage === 'blocked' || stage === 'error' ? { message: sessionReason, code: sessionCode } : undefined;
  const reason = stage === 'ended' ? sshLaunchEndReason(snapshot?.error) : shown?.message;
  const cancel = () => { if (snapshot) props.onCancel(snapshot.attempt); };
  const reconnect = stage === 'ended' || ((stage === 'typed' || stage === 'running') && currentView?.state === 'disconnected');
  return <SshLaunchStrip status={stageCopy[stage]} overlay={<div className="ssh-launch-overlay">
      {snapshot?.error?.code === 'Timeout' && <div role="status">Return to the local shell prompt</div>}
      {reason && <div role="alert">{reason}</div>}
      {failure && !(reason && failure.code === shown?.code) && <div role="alert">{failure.message}</div>}
      {host && receipt && <SshHostKeyPrompt key={promptKey} view={currentView} onTrust={() => props.onTrust(receipt)} onCancel={cancel} />}
      {secret && receipt && <SshSecretPrompt key={promptKey} view={currentView} onSubmit={(value, remember) => props.onSecret(value, remember, receipt)} onCancel={cancel} />}
    </div>}>
      {waiting && snapshot && props.canCancel !== false && !host && !secret &&
        <button type="button" className="au-btn" onClick={cancel}>Cancel</button>}
      {(stage === 'blocked' || stage === 'error' || stage === 'cancelled' || reconnect) &&
        <button type="button" className="au-btn" disabled={props.retrying} onClick={props.onReconnect}>{reconnect ? 'Reconnect' : 'Retry'}</button>}
  </SshLaunchStrip>;
}
