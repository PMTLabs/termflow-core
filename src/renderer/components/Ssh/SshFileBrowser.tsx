import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { ContextMenu } from '../Terminal/ContextMenu';
import { SshDeleteDialog } from './SshDeleteDialog';
import { SshPermissionsDialog } from './SshPermissionsDialog';
import { SshPropertiesDialog } from './SshPropertiesDialog';
import { insertRemotePath } from './remotePathInput';
import { copyRemotePath, operationError, sshFileToast } from './sshFileFeedback';
import { fileActionReason, sshFileMenu, type FileAction } from './sshFileMenu';
import type { EditOpen, RemoteEntry } from './sshFileTypes';
import { staleTarget } from './useSshTargetStat';
import { SshFileList, type SshFileListProps } from './SshFileList';
import { SshNameDialog } from './SshNameDialog';
import { SshPathBar } from './SshPathBar';
import { useSshFileBrowser, type CreateKind, type SshBrowserControllerProps, type SshRowScope } from './useSshFileBrowser';
import './SshFileBrowser.css';
import '../Settings/Automations/AutomationsPanel.css';

export type SshFileBrowserProps = SshBrowserControllerProps & Pick<SshFileListProps, 'onEntryContextMenu'> & {
  onEditOpen?(result: EditOpen): void;
};

type DialogAction = 'rename' | 'delete' | 'properties' | 'permissions';
interface RowTarget { entry: RemoteEntry; scope?: SshRowScope; trigger: HTMLElement }
interface FileMenu extends RowTarget { x: number; y: number }

/** The one file controller of a terminal: listing, epoch, Follow-cd subscription and requests. */
export type SshBrowserController = ReturnType<typeof useSshFileBrowser>;

/** Owns a controller and renders it. The pane composition owns one per SSH terminal. */
export function SshFileBrowser(props: SshFileBrowserProps) {
  return <OwnedBrowser key={props.terminalId} {...props} />;
}

function OwnedBrowser(props: SshFileBrowserProps) {
  const browser = useSshFileBrowser(props);
  return <Browser {...props} browser={browser} />;
}

/**
 * A second presentation of a controller owned elsewhere (plan 070 §4.1 A). It never lists,
 * subscribes or follows cd itself; its own menus and dialogs are gated by `surfaceActive`.
 */
export function SshFileBrowserView(props: SshFileBrowserProps & { browser: SshBrowserController }) {
  return <Browser key={props.terminalId} {...props} />;
}

function Browser(props: SshFileBrowserProps & { browser: SshBrowserController }) {
  const { browser } = props;
  const connection = useSelector((state: RootState) => state.ssh.view.connections.find(c => c.id === props.sshTag.connectionId)?.name);
  const [menu, setMenu] = useState<FileMenu>();
  const [rowDialog, setRowDialog] = useState<{ id: number; action: DialogAction; entry: RemoteEntry; scope: SshRowScope }>();
  const rowDialogSeq = React.useRef(0);
  const active = props.surfaceActive && !props.sshTag.browserCollapsed;
  React.useLayoutEffect(() => {
    if (!active) { setMenu(undefined); setRowDialog(undefined); }
  }, [active]);
  // A dialog's close only clears that dialog instance: a completion that outlives it (surface
  // hidden, then another dialog opened) must not close the replacement.
  const closeRowDialog = (id: number) => () => setRowDialog(current => current?.id === id ? undefined : current);

  const run = (action: FileAction, { entry, scope, trigger }: RowTarget) => {
    if (!scope || fileActionReason(action, entry, scope.isLive())) return;
    if (action === 'rename' || action === 'delete' || action === 'properties' || action === 'permissions') {
      trigger.focus(); // modal captures the row, not the menu item that is about to unmount
      setRowDialog({ id: ++rowDialogSeq.current, action, entry, scope });
      return;
    }
    const { api, request } = scope;
    void (async () => {
      try {
        if (action === 'insert') await insertRemotePath(scope);
        if (action === 'copy') await copyRemotePath(request.path);
        if (action === 'download') {
          const result = await api.fsDownload(request);
          if (result.status === 'done' && scope.isCurrent()) sshFileToast('success', 'Remote download complete.');
        }
        if (action === 'open' || action === 'openWith') {
          const result = await (action === 'open' ? api.fsOpen(request) : api.fsOpenWith(request));
          if (scope.isCurrent()) props.onEditOpen?.(result);
        }
      } catch (failure) {
        if (scope.isCurrent()) sshFileToast('error', operationError(failure, request.path));
      }
    })();
  };

  const [dialog, setDialog] = useState<{ kind: CreateKind; path: string }>();
  const reason = !browser.online ? 'Remote files unavailable — SSH is not running on a connected session.'
    : browser.creating ? 'Creating remote entry…'
    : !browser.live && browser.loading ? 'Waiting for the remote listing.' : undefined;

  // Unmount dialog on loss of ownership; an old dialog must never reopen on reconnect.
  const dialogVisible = browser.live && dialog?.path === browser.path;
  React.useLayoutEffect(() => {
    if (!dialogVisible) setDialog(undefined);
  }, [dialogVisible]);

  const open = (kind: CreateKind, trigger: HTMLButtonElement) => {
    if (browser.isLiveNow() && browser.path) {
      trigger.focus();
      setDialog({ kind, path: browser.path });
    }
  };
  return <div className="ssh-file-browser">
    <div className="ssh-file-toolbar" role="group" aria-label="Remote file actions">
      <button type="button" className="au-btn" title={reason ?? 'Refresh remote directory'} disabled={!!reason}
        onClick={browser.refresh}>Refresh</button>
      <button type="button" className="au-btn" title={reason ?? 'Create a remote folder'} disabled={!browser.canUseRows}
        onClick={event => open('folder', event.currentTarget)}>New folder</button>
      <button type="button" className="au-btn" title={reason ?? 'Create a remote file'} disabled={!browser.canUseRows}
        onClick={event => open('file', event.currentTarget)}>New file</button>
    </div>
    <SshPathBar draft={browser.draft} setDraft={browser.setDraft} path={browser.path} navigate={browser.navigate}
      followCd={props.sshTag.followCd} disabled={!!reason} reason={reason}
      onFollowChange={followCd => props.onPatchTag({ followCd })} />
    {browser.path && <div className="ssh-browser-detail" title={browser.path}>Current directory: {browser.path}</div>}
    {!browser.online && <div role="status">{reason}</div>}
    {browser.stale && browser.loadedAt && <div role="status">
      Stale — last listed <time dateTime={browser.loadedAt.toISOString()}>{browser.loadedAt.toLocaleString()}</time>
    </div>}
    {browser.loading && <div role="status">Loading remote directory…</div>}
    {browser.error && <div role="alert">{browser.error}</div>}
    {browser.online && props.sshTag.followCd && !browser.reported &&
      <div className="ssh-browser-detail">Remote cwd not reported — use the path box.</div>}
    <div className={browser.stale ? 'ssh-file-rows stale' : 'ssh-file-rows'}>
      {browser.live && !browser.loading && !browser.error && browser.entries?.length === 0 && <div>Empty directory</div>}
      {!!browser.entries?.length && <SshFileList entries={browser.entries} childrenByPath={browser.children}
        expanded={browser.expanded} selected={browser.selected} disabled={!browser.canUseRows}
        onSelect={browser.setSelected} onNavigate={browser.navigate} onToggle={browser.toggleFolder}
        onEntryContextMenu={(entry, event) => {
          const button = event.currentTarget.querySelector<HTMLButtonElement>('.ssh-file-name:not(:disabled)');
          const trigger = button ?? event.currentTarget;
          trigger.focus();
          setMenu({ entry: { ...entry }, scope: browser.captureRow(entry.path), trigger, x: event.clientX, y: event.clientY });
          if (browser.isLiveNow()) props.onEntryContextMenu?.(entry, event);
        }}
        onInsert={entry => {
          const scope = browser.captureRow(entry.path);
          if (!scope) return;
          void insertRemotePath(scope).catch(failure => {
            if (scope.isCurrent()) sshFileToast('error', operationError(failure, entry.path));
          });
        }}
        onShortcut={(entry, action, trigger) => {
          setMenu(undefined);
          run(action, { entry: { ...entry }, scope: browser.captureRow(entry.path), trigger });
        }} />}
    </div>
    {active && menu && <div onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
      <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(undefined)}
        items={sshFileMenu(menu.entry, !!menu.scope?.isLive(), action => run(action, menu))} />
    </div>}
    {active && rowDialog && (() => {
      const { id, action, scope, entry } = rowDialog;
      const onClose = closeRowDialog(id);
      if (action === 'properties') return <SshPropertiesDialog key={id} scope={scope} connection={connection} onClose={onClose} />;
      if (action === 'permissions') return <SshPermissionsDialog key={id} scope={scope} onClose={onClose} />;
      if (action === 'delete') return <SshDeleteDialog key={id} scope={scope} recursive={entry.kind === 'directory'} onClose={onClose} />;
      return <SshNameDialog key={id} kind="rename" path={entry.path} initialName={entry.name} disabled={!scope.isLive()}
        onClose={onClose} onSubmit={async name => {
          if (!scope.isLive()) return { error: staleTarget };
          if (name === entry.name) return {};
          const newPath = entry.path.slice(0, entry.path.lastIndexOf('/') + 1) + name;
          try {
            await scope.api.fsRename({ ...scope.request, newPath });
            if (!(await scope.refresh()) || !scope.isCurrent()) {
              return { acknowledged: true, error: 'Renamed on the server, but the directory could not be refreshed.' };
            }
            sshFileToast('success', 'Remote entry renamed.');
            return {};
          } catch (failure) {
            return { error: operationError(failure, entry.path) };
          }
        }} />;
    })()}
    {dialogVisible && dialog && <SshNameDialog kind={dialog.kind} path={dialog.path}
      onClose={() => setDialog(current => current === dialog ? undefined : current)}
      onSubmit={name => browser.create(dialog.kind, name)} />}
  </div>;
}
