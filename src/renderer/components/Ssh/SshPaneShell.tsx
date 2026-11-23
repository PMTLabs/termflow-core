import React from 'react';
import { clampSshBrowserWidth, SSH_BROWSER_DEFAULT_WIDTH, SSH_BROWSER_MIN_WIDTH,
  SSH_BROWSER_MAX_WIDTH, SSH_BROWSER_MAX_FRACTION } from '../../types/sshBrowserWidth';
import type { SshSessionView, SshPromptReceipt } from '../../types/ssh';
import { SshSecretPrompt } from './SshSecretPrompt';
import { SshHostKeyPrompt } from './SshHostKeyPrompt';
import { SshDisconnectedBanner } from './SshDisconnectedBanner';
import { SshEditWarning } from './SshEditWarning';
import type { EditOpen } from './sshFileTypes';
import './SshPaneShell.css';
import '../Settings/Automations/AutomationsPanel.css'; // house .au-btn styles for prompt and banner buttons
export const SSH_PANE_CHROME_H = 36;

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
  /** False while this presentation's surface is not the visible, active one (its tab is in the
   *  background, or Canvas is taking the terminal over). Its browser's menus and dialogs close
   *  then, and a dialog closing that way must not pull focus back here (068 F5). Defaults to true. */
  surfaceActive?: boolean;
  /** False where 066's `SshLaunchNotice` already renders this terminal's host-key and secret
   *  prompts and its Reconnect (the pane): the shell then shows no second copy of either, so a
   *  dropped session never offers two Reconnect buttons. Defaults to true. */
  sessionPrompts?: boolean;
  /** An explicit browser column allocation in CSS px. Canvas passes the frozen allocation so the
   *  terminal slot is the exact remainder of its envelope; panes omit it and keep the CSS sizing. */
  browserWidth?: number;
  preferredBrowserWidth?: number;
  onBrowserWidthChange?(width: number): void;
}
function SshPaneChrome({ interactive, summaries, children }: {
  interactive: boolean; summaries: string[]; children: React.ReactNode;
}) {
  const [requested, setRequested] = React.useState(false);
  const dialogId = React.useId();
  const row = React.useRef<HTMLDivElement>(null);
  const invoker = React.useRef<HTMLButtonElement>(null);
  const dialog = React.useRef<HTMLDivElement>(null);
  const open = interactive && requested;
  const hasItems = summaries.length > 0;
  // Escape and the Close button return focus to the invoker. An outside click does not: the
  // user just put focus where they clicked (the terminal, the path box) and it stays there.
  const close = React.useCallback((restoreFocus = true) => {
    setRequested(false);
    if (restoreFocus) (hasItems ? invoker.current : row.current)?.focus();
  }, [hasItems]);
  React.useEffect(() => {
    if (!interactive) setRequested(false);
  }, [interactive]);
  React.useEffect(() => {
    // Children's effects run first: a prompt that focused its own field keeps that focus.
    if (open && !dialog.current?.contains(document.activeElement)) dialog.current?.focus();
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const onClick = (event: MouseEvent) => {
      if (!dialog.current?.contains(event.target as Node) && !invoker.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [open, close]);

  // Always reserve this height, even before the initial snapshot and on the non-owning
  // presentation. Neither notice changes nor ownership transfers should trigger a fit.
  return <div className="ssh-pane-chrome" ref={row} tabIndex={interactive ? -1 : undefined}
    data-canvas-passthrough={interactive ? 'scroll' : undefined} data-ssh-keyboard-owner={interactive ? '' : undefined}>
    {interactive && hasItems && <span role="status" title={summaries[0]}>{summaries[0]}</span>}
    {interactive && (hasItems || open) && <button ref={invoker} type="button" className="au-btn"
      aria-label={summaries.length > 1 ? `SSH notice details (+${summaries.length - 1} more)` : "SSH notice details"} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? dialogId : undefined} onClick={() => open ? close() : setRequested(true)}>
      {summaries.length > 1 ? `+${summaries.length - 1} more` : 'Details'}
    </button>}
    {open && <div id={dialogId} ref={dialog} className="ssh-pane-popover" role="dialog" aria-label="SSH notices" tabIndex={-1}>
      <button type="button" className="au-btn" onClick={() => close()}>Close SSH notices</button>
      {!hasItems && <p>No SSH notices.</p>}
      {children}
    </div>}
  </div>;
}

export function SshPaneShell(props: SshPaneShellProps) {
  const { view } = props, connected = view.state === 'connected';
  // Truthful failure (plan 070 §4.1 C): live data only while the app channel is connected AND the
  // launch seam has not ended/blocked/cancelled/failed. Every other state dims the browser and
  // shows "—", in the pane and on Canvas alike, because both render this one shell.
  const live = connected && !props.launchDisconnected;
  const showDisconnected = (connected && props.launchDisconnected) || view.state === 'disconnected'
    || (view.state === 'error' && !view.hostKey?.changed);
  const interactive = props.interactive ?? true;
  // Read by `sshShellOwnsFocusRestore`: the tab switch into Canvas commits BEFORE Canvas takes the
  // host, so `interactive` alone is still true when the pane's dialog closes on deactivation.
  const owner = interactive && (props.surfaceActive ?? true);
  const prompts = props.sessionPrompts ?? true;
  const aside = React.useRef<HTMLElement>(null);
  const body = React.useRef<HTMLDivElement>(null);
  const host = React.useRef<HTMLDivElement>(null);
  const [preview, setPreview] = React.useState<{ width: number; terminalWidth: number }>();
  const drag = React.useRef<{
    id: number; scale: number; cap: number; terminalWidth: number;
    width?: number; commit(width: number): void;
  } | null>(null);
  React.useEffect(() => {
    const cancel = () => { drag.current = null; setPreview(undefined); };
    const move = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.id !== event.pointerId || !aside.current) return;
      if (event.buttons === 0) { cancel(); return; }
      const x = (event.clientX - aside.current.getBoundingClientRect().left) / current.scale;
      current.width = clampSshBrowserWidth(Math.floor(Math.min(x, current.cap)));
      setPreview({ width: current.width, terminalWidth: current.terminalWidth });
    };
    const end = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      cancel();
      if (current.width !== undefined) current.commit(current.width);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, []);
  const resizable = owner && !props.browserCollapsed && !!props.onBrowserWidthChange;
  React.useLayoutEffect(() => {
    if (!resizable) { drag.current = null; setPreview(undefined); }
  }, [resizable]);
  const preferred = props.preferredBrowserWidth ?? SSH_BROWSER_DEFAULT_WIDTH;
  const allocation = props.browserWidth;
  const width = preview?.width ?? allocation ?? (!props.browserCollapsed ? props.preferredBrowserWidth : undefined);
  const browserStyle: React.CSSProperties | undefined = width === undefined ? undefined
    : { flex: `${preview || allocation !== undefined ? '0 0' : '0 1'} ${width}px`, width, maxWidth: allocation !== undefined && !preview ? 'none' : undefined };
  const toggleLabel = props.browserCollapsed ? 'Expand file browser' : 'Collapse file browser';
  const secret = prompts && view.state === 'needs-secret';
  const hostKey = prompts && (view.state === 'needs-hostkey' || (view.state === 'error' && view.hostKey?.changed));
  const disconnected = prompts && showDisconnected;
  // Challenges and reconnect take priority over edit notices. The strip is text-only;
  // full prompts, reasons and controls live in the explicitly opened details dialog.
  const challenge = secret ? 'SSH credentials required' : hostKey
    ? view.hostKey?.changed ? 'SSH host key refused' : 'Verify SSH host key'
    : disconnected ? 'SSH disconnected' : undefined;
  const status = view.state === 'connecting' ? 'Connecting…' : connected ? view.reason : undefined;
  // The chrome follows `owner`, not `interactive`: an inactive surface closes its popover without
  // moving focus and drops its document Escape/click listeners, so they never act on the hidden pane.
  const renderChrome = (summaries: string[], details: React.ReactNode) => <SshPaneChrome
    interactive={owner} summaries={[challenge, status, ...summaries].filter((item): item is string => !!item)}>
    {secret && <SshSecretPrompt key={view.promptId} view={view} onSubmit={(secret, remember) => props.onSecret(secret, remember, { generation: view.generation, promptId: view.promptId })} onCancel={props.onCancel} />}
    {hostKey && <SshHostKeyPrompt key={view.promptId} view={view} onTrust={() => props.onTrust({ generation: view.generation, promptId: view.promptId })} onCancel={props.onCancel} />}
    {disconnected && <SshDisconnectedBanner reason={view.reason} onReconnect={props.onReconnect} />}
    {status && <div>{status}</div>}
    {details}
  </SshPaneChrome>;
  // Markers read by Canvas (`canvasGestures.ts`): `data-canvas-passthrough="scroll"` lets a wheel
  // scroll this content instead of the canvas, `data-ssh-keyboard-owner` keeps Canvas shortcuts
  // out of its controls, `data-ssh-interaction-owner` gates dialog focus restore (068 F5).
  // Inert in a pane, where nothing reads them.
  return <section className="ssh-pane-shell" aria-label="SSH session" data-ssh-interaction-owner={owner ? 'true' : 'false'}>
    {interactive && view.terminalId
      ? <SshEditWarning terminalId={view.terminalId} openResult={props.editOpenResult}>
          {(summaries, details) => renderChrome(summaries, details)}
        </SshEditWarning>
      : renderChrome([], null)}
    <div className="ssh-pane-body" ref={body} data-resizing={preview ? '' : undefined}>
      <aside ref={aside} className={`ssh-browser${props.browserCollapsed ? ' collapsed' : ''}${live ? '' : ' offline'}`} aria-label="Remote browser"
        style={browserStyle} data-canvas-passthrough="scroll" data-ssh-keyboard-owner="">
        <button type="button" className="au-btn ssh-browser-toggle" aria-label={toggleLabel} title={toggleLabel} onClick={() => props.onBrowserCollapsedChange(!props.browserCollapsed)} aria-expanded={!props.browserCollapsed}><span aria-hidden="true">{props.browserCollapsed ? '›' : '‹'}</span></button>
        {props.browserHandlesOffline ? <div hidden={props.browserCollapsed}>{props.browser}</div>
          : !props.browserCollapsed && (live ? props.browser : <div className="ssh-browser-unavailable">Remote files unavailable</div>)}
      </aside>
      {resizable && <div className="ssh-browser-grip" role="separator" tabIndex={0}
        aria-label="Resize file browser" aria-orientation="vertical"
        aria-valuemin={SSH_BROWSER_MIN_WIDTH} aria-valuemax={SSH_BROWSER_MAX_WIDTH}
        aria-valuenow={preview?.width ?? preferred}
        data-canvas-passthrough="scroll" data-ssh-keyboard-owner=""
        onPointerDown={event => {
          if (event.button !== 0 || drag.current || !body.current || !host.current) return;
          event.stopPropagation();
          const layoutWidth = body.current.clientWidth;
          const scale = layoutWidth ? body.current.getBoundingClientRect().width / layoutWidth || 1 : 1;
          drag.current = {
            id: event.pointerId, scale, cap: layoutWidth ? layoutWidth * SSH_BROWSER_MAX_FRACTION : Infinity,
            terminalWidth: host.current.getBoundingClientRect().width / scale,
            commit: props.onBrowserWidthChange!,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          // Same cap as the drag: never step the preference past what the body can show.
          const cap = body.current?.clientWidth ? body.current.clientWidth * SSH_BROWSER_MAX_FRACTION : Infinity;
          const shown = Math.min(preferred, cap);
          props.onBrowserWidthChange!(clampSshBrowserWidth(Math.floor(Math.min(shown + (event.key === 'ArrowRight' ? 16 : -16), cap))));
        }}
        onDoubleClick={() => props.onBrowserWidthChange!(SSH_BROWSER_DEFAULT_WIDTH)} />}
      {/* Keep the fit host's layout width stable throughout preview; releasing the lock lets its
          existing ResizeObserver fit the final width, without resizing the PTY on each move. */}
      <div className="ssh-terminal-host" ref={host}
        style={preview ? { flex: `0 0 ${preview.terminalWidth}px` } : undefined}>{props.terminal}</div>
    </div>
    {/* D66: the ONE bottom row. The shell's truthful marker on the left ("—" whenever not live),
        and the `status` slot (069's SshMetricsStatusBar, which owns its own unavailable/ended states,
        D57) on the right. The row height is fixed in CSS. The bar is focusable and has its own menu,
        so on the interactive presentation the row owns its keys like the chrome row (review 349 F6). */}
    <div className="ssh-status" aria-label="SSH status" data-ssh-keyboard-owner={owner ? '' : undefined}>
      {!live && <span className="ssh-status-text">—</span>}
      {props.status}
    </div>
  </section>;
}
