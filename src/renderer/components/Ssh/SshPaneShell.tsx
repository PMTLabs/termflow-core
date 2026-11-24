import React from 'react';
import { clampSshBrowserWidth, SSH_BROWSER_DEFAULT_WIDTH, SSH_BROWSER_MIN_WIDTH,
  SSH_BROWSER_MAX_WIDTH, SSH_BROWSER_MAX_FRACTION } from '../../types/sshBrowserWidth';
import type { SshSessionView, SshPromptReceipt } from '../../types/ssh';
import { SshSecretPrompt } from './SshSecretPrompt';
import { SshHostKeyPrompt } from './SshHostKeyPrompt';
import { SshDisconnectedBanner } from './SshDisconnectedBanner';
import { SshEditWarning, sshEditSummary } from './SshEditWarning';
import { SshIcon } from './SshIcons';
import type { EditOpen, EditStatus } from './sshFileTypes';
import { sshStatusMarkerVisible } from './sshStatusLiveness';
import './SshPaneShell.css';
import '../Settings/Automations/AutomationsPanel.css'; // house .au-btn styles for prompt and banner buttons
export const SSH_PANE_CHROME_H = 36;

export interface SshPaneShellProps {
  view: SshSessionView; terminal: React.ReactNode; browser?: React.ReactNode; status?: React.ReactNode;
  editOpenResult?: EditOpen;
  // Only slots that fence their own actions may render a stale listing.
  browserHandlesOffline?: boolean;
  launchDisconnected?: boolean;
  /** The rendered status slot already signals that the session is not live. */
  statusShowsNotLive?: boolean;
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
function SshNoticeDisclosure({ interactive, summaries, edits, focusFallback, children }: {
  interactive: boolean; summaries: string[]; edits?: EditStatus[];
  /** Where focus goes when this disclosure unmounts while holding it (the pane's terminal). */
  focusFallback(): void;
  children: React.ReactNode;
}) {
  const [requested, setRequested] = React.useState(false);
  const dialogId = React.useId();
  const row = React.useRef<HTMLDivElement>(null);
  const invoker = React.useRef<HTMLButtonElement>(null);
  const dialog = React.useRef<HTMLDivElement>(null);
  const open = interactive && requested;
  const hasItems = (edits?.length ?? summaries.length) > 0;
  // Escape and the Close button return focus to the invoker. An outside click does not: the
  // user just put focus where they clicked (the terminal, the path box) and it stays there.
  // Without items the row unmounts on close, so focus goes to the terminal, never to <body>.
  const close = React.useCallback((restoreFocus = true) => {
    setRequested(false);
    if (restoreFocus) hasItems ? invoker.current?.focus() : focusFallback();
  }, [hasItems, focusFallback]);
  // Items drained while open (the last routine edit went to conflict or was stopped, the last
  // notice cleared): close before paint, so no "0 files" invoker or empty popover is ever shown.
  React.useLayoutEffect(() => {
    if (!open || hasItems) return;
    const held = !!row.current?.contains(document.activeElement);
    setRequested(false);
    if (held) focusFallback();
  }, [open, hasItems, focusFallback]);
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

  // Give idle space back to the terminal. A notice appearing or disappearing may refit it.
  if (!open && (!interactive || !hasItems)) return null;
  const count = edits?.length ?? 0;
  const file = count === 1 ? edits?.[0] : undefined;
  const basename = file?.path.split(/[\\/]/).filter(Boolean).pop() ?? file?.path;
  const label = edits ? 'Remote file edits' : 'SSH notices';
  return <div className={edits ? 'ssh-watch-item' : 'ssh-pane-chrome'} ref={row} tabIndex={interactive ? -1 : undefined}
    data-canvas-passthrough="scroll" data-ssh-keyboard-owner="">
    {!edits && hasItems && <span role="status" title={summaries[0]}>{summaries[0]}</span>}
    <button ref={invoker} type="button" className="au-btn"
      title={edits?.map(sshEditSummary).join('\n')}
      aria-label={edits ? `${count} remote ${file ? `file: ${basename} (${file.state})` : 'files'}`.replace(/[\r\n]+/g, ' ')
        : summaries.length > 1 ? `SSH notice details (+${summaries.length - 1} more)` : 'SSH notice details'}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined}
      onClick={() => open ? close() : setRequested(true)}>
      {edits ? <><SshIcon name="disk" size={12} /> {file ? <><span className="ssh-watch-name">{basename}</span><span> · {file.state}</span></> : `${count} files`}</>
        : summaries.length > 1 ? `+${summaries.length - 1} more` : 'Details'}
    </button>
    {open && <div id={dialogId} ref={dialog} className="ssh-pane-popover" role="dialog" aria-label={label} tabIndex={-1}>
      <button type="button" className="au-btn" onClick={() => close()}>Close {label}</button>
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
  const focusTerminal = React.useCallback(() => {
    host.current?.querySelector<HTMLElement>('textarea, [tabindex]')?.focus();
  }, []);
  const renderChrome = (summaries: string[], details: React.ReactNode) => <SshNoticeDisclosure
    interactive={owner} focusFallback={focusTerminal} summaries={[challenge, status, ...summaries].filter((item): item is string => !!item)}>
    {secret && <SshSecretPrompt key={view.promptId} view={view} onSubmit={(secret, remember) => props.onSecret(secret, remember, { generation: view.generation, promptId: view.promptId })} onCancel={props.onCancel} />}
    {hostKey && <SshHostKeyPrompt key={view.promptId} view={view} onTrust={() => props.onTrust({ generation: view.generation, promptId: view.promptId })} onCancel={props.onCancel} />}
    {disconnected && <SshDisconnectedBanner reason={view.reason} onReconnect={props.onReconnect} />}
    {status && <div>{status}</div>}
    {details}
  </SshNoticeDisclosure>;
  // Markers read by Canvas (`canvasGestures.ts`): `data-canvas-passthrough="scroll"` lets a wheel
  // scroll this content instead of the canvas, `data-ssh-keyboard-owner` keeps Canvas shortcuts
  // out of its controls, `data-ssh-interaction-owner` gates dialog focus restore (068 F5).
  // Inert in a pane, where nothing reads them.
  const renderShell = (summaries: string[], details: React.ReactNode, edits: EditStatus[]) => <section className="ssh-pane-shell" aria-label="SSH session" data-ssh-interaction-owner={owner ? 'true' : 'false'}>
    {renderChrome(summaries, details)}
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
    {/* D66: the ONE bottom row. The shell shows "—" when the terminal is not live unless
        the rendered metrics state already reports that the app session is not connected.
        The row height is fixed in CSS. The bar is focusable and has its own menu,
        so on the interactive presentation the row owns its keys like the chrome row (review 349 F6). */}
    <div className="ssh-status" aria-label="SSH status" data-ssh-keyboard-owner={owner ? '' : undefined}>
      {sshStatusMarkerVisible({ terminalLive: live, barShown: !!props.status, barConnected: !props.statusShowsNotLive })
        && <span className="ssh-status-text">—</span>}
      <SshNoticeDisclosure interactive={owner} focusFallback={focusTerminal} summaries={[]} edits={edits}>{details}</SshNoticeDisclosure>
      {props.status}
    </div>
  </section>;
  return <SshEditWarning terminalId={view.terminalId ?? ''} enabled={interactive && !!view.terminalId}
    openResult={view.terminalId ? props.editOpenResult : undefined}>{renderShell}</SshEditWarning>;
}
