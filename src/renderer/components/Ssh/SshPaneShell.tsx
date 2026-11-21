import React from 'react';
import type { SshSessionView, SshPromptReceipt } from '../../types/ssh';
import { SshSecretPrompt } from './SshSecretPrompt';
import { SshHostKeyPrompt } from './SshHostKeyPrompt';
import { SshDisconnectedBanner } from './SshDisconnectedBanner';
import { SshEditWarning } from './SshEditWarning';
import type { EditOpen } from './sshFileTypes';
import './SshPaneShell.css';
import '../Settings/Automations/AutomationsPanel.css'; // house .au-btn styles for prompt and banner buttons
export interface SshPaneShellProps {
  view: SshSessionView; terminal: React.ReactNode; browser?: React.ReactNode; status?: React.ReactNode;
  editOpenResult?: EditOpen;
  // Only slots that fence their own actions may render a stale listing.
  browserHandlesOffline?: boolean;
  launchDisconnected?: boolean;
  browserCollapsed: boolean; onBrowserCollapsedChange(collapsed: boolean): void;
  onSecret(secret: string, remember: boolean, receipt: SshPromptReceipt): Promise<void>; onTrust(receipt: SshPromptReceipt): Promise<void>; onCancel(): void;
  // 066 owns the real end-old-login/relaunch coordinator, not a bare IPC retry.
  onReconnect?: () => Promise<unknown>;
  /** False while another presentation of the same terminal owns interaction (plan 070 §4.1 A):
   *  this one stays laid out but renders no prompt, banner action or edit notice, so there is
   *  never a second visible or focusable challenge. Defaults to true. */
  interactive?: boolean;
  /** False where 066's `SshLaunchNotice` already renders this terminal's host-key and secret
   *  prompts (the pane): the shell then shows no second copy. Defaults to true. */
  sessionPrompts?: boolean;
  /** An explicit browser column allocation in CSS px. Canvas passes the frozen allocation so the
   *  terminal slot is the exact remainder of its envelope; panes omit it and keep the CSS sizing. */
  browserWidth?: number;
}
export function SshPaneShell(props: SshPaneShellProps) {
  const { view } = props, connected = view.state === 'connected';
  const showDisconnected = (connected && props.launchDisconnected) || view.state === 'disconnected'
    || (view.state === 'error' && !view.hostKey?.changed);
  const interactive = props.interactive ?? true;
  const prompts = props.sessionPrompts ?? true;
  const browserStyle: React.CSSProperties | undefined = props.browserWidth === undefined ? undefined
    : { flex: `0 0 ${props.browserWidth}px`, width: props.browserWidth, maxWidth: 'none' };
  return <section className="ssh-pane-shell" aria-label="SSH session">
    {interactive && <div className="ssh-pane-chrome">
      {prompts && view.state === 'needs-secret' && <SshSecretPrompt key={view.promptId} view={view} onSubmit={(secret, remember) => props.onSecret(secret, remember, { generation: view.generation, promptId: view.promptId })} onCancel={props.onCancel} />}
      {prompts && (view.state === 'needs-hostkey' || (view.state === 'error' && view.hostKey?.changed)) && <SshHostKeyPrompt key={view.promptId} view={view} onTrust={() => props.onTrust({ generation: view.generation, promptId: view.promptId })} onCancel={props.onCancel} />}
      {showDisconnected && <SshDisconnectedBanner reason={view.reason} onReconnect={props.onReconnect} />}
      {view.state === 'connecting' && <span role="status">Connecting…</span>}
      {connected && view.reason && <span role="status">{view.reason}</span>}
      {view.terminalId && <SshEditWarning terminalId={view.terminalId} openResult={props.editOpenResult} />}
    </div>}
    <div className="ssh-pane-body">
      <aside className={props.browserCollapsed ? 'ssh-browser collapsed' : 'ssh-browser'} aria-label="Remote browser" style={browserStyle}>
        <button type="button" className="au-btn ssh-browser-toggle" title={props.browserCollapsed ? 'Expand file browser' : 'Collapse file browser'} onClick={() => props.onBrowserCollapsedChange(!props.browserCollapsed)} aria-expanded={!props.browserCollapsed}>{props.browserCollapsed ? 'Expand' : 'Collapse'}</button>
        {props.browserHandlesOffline ? <div hidden={props.browserCollapsed}>{props.browser}</div>
          : !props.browserCollapsed && (connected ? props.browser : <div className="ssh-browser-unavailable">Remote files unavailable</div>)}
      </aside>
      <div className="ssh-terminal-host">{props.terminal}</div>
    </div>
    {/* 069-rebase: SshMetricsStatusBar plugs into the `status` slot; the row height is fixed in CSS. */}
    <div className="ssh-status" aria-label="SSH status">{connected ? props.status : '—'}</div>
  </section>;
}
