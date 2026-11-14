import React from 'react';
import type { SshSessionView, SshPromptReceipt } from '../../types/ssh';
import { SshSecretPrompt } from './SshSecretPrompt';
import { SshHostKeyPrompt } from './SshHostKeyPrompt';
import { SshDisconnectedBanner } from './SshDisconnectedBanner';
import './SshPaneShell.css';
export interface SshPaneShellProps {
  view: SshSessionView; terminal: React.ReactNode; browser?: React.ReactNode; status?: React.ReactNode;
  browserCollapsed: boolean; onBrowserCollapsedChange(collapsed: boolean): void;
  onSecret(secret: string, remember: boolean, receipt: SshPromptReceipt): Promise<void>; onTrust(receipt: SshPromptReceipt): Promise<void>; onCancel(): void;
  // 066 owns the real end-old-login/relaunch coordinator, not a bare IPC retry.
  onReconnect?: () => Promise<unknown>;
}
export function SshPaneShell(props: SshPaneShellProps) {
  const { view } = props, connected = view.state === 'connected';
  return <section className="ssh-pane-shell" aria-label="SSH session">
    <div className="ssh-pane-chrome">
      {view.state === 'needs-secret' && <SshSecretPrompt key={view.promptId} view={view} onSubmit={(secret, remember) => props.onSecret(secret, remember, { generation: view.generation, promptId: view.promptId })} onCancel={props.onCancel} />}
      {(view.state === 'needs-hostkey' || (view.state === 'error' && view.hostKey?.changed)) && <SshHostKeyPrompt key={view.promptId} view={view} onTrust={() => props.onTrust({ generation: view.generation, promptId: view.promptId })} onCancel={props.onCancel} />}
      {(view.state === 'disconnected' || (view.state === 'error' && !view.hostKey?.changed)) && <SshDisconnectedBanner reason={view.reason} onReconnect={props.onReconnect} />}
      {view.state === 'connecting' && <span role="status">Connecting…</span>}
      {connected && view.reason && <span role="status">{view.reason}</span>}
    </div>
    <div className="ssh-pane-body">
      <aside className={props.browserCollapsed ? 'ssh-browser collapsed' : 'ssh-browser'} aria-label="Remote browser" aria-disabled={!connected}>
        <button onClick={() => props.onBrowserCollapsedChange(!props.browserCollapsed)} aria-expanded={!props.browserCollapsed}>{props.browserCollapsed ? 'Expand' : 'Collapse'}</button>
        {!props.browserCollapsed && (connected ? props.browser : <div className="ssh-browser-unavailable">Remote files unavailable</div>)}
      </aside>
      <div className="ssh-terminal-host">{props.terminal}</div>
    </div>
    <div className="ssh-status" aria-label="SSH status">{connected ? props.status : '—'}</div>
  </section>;
}
