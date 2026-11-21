import React, { useState } from 'react';
import { SshFileList, type SshFileListProps } from './SshFileList';
import { SshNameDialog } from './SshNameDialog';
import { SshPathBar } from './SshPathBar';
import { useSshFileBrowser, type CreateKind, type SshBrowserControllerProps } from './useSshFileBrowser';
import './SshFileBrowser.css';
import '../Settings/Automations/AutomationsPanel.css';

export type SshFileBrowserProps = SshBrowserControllerProps & Pick<SshFileListProps, 'onEntryContextMenu'>;

export function SshFileBrowser(props: SshFileBrowserProps) {
  return <Browser key={props.terminalId} {...props} />;
}

function Browser(props: SshFileBrowserProps) {
  const browser = useSshFileBrowser(props);
  const [dialog, setDialog] = useState<{ kind: CreateKind; path: string }>();
  const reason = !browser.online ? 'Remote files unavailable — SSH is not running on a connected session.'
    : browser.creating ? 'Creating remote entry…'
    : !browser.live && browser.loading ? 'Waiting for the remote listing.' : undefined;

  // Unmount dialog on loss of ownership; an old dialog must never reopen on reconnect.
  const dialogVisible = browser.live && dialog?.path === browser.path;
  React.useLayoutEffect(() => {
    if (!dialogVisible) setDialog(undefined);
  }, [dialogVisible]);

  const open = (kind: CreateKind) => {
    if (browser.isLiveNow() && browser.path) setDialog({ kind, path: browser.path });
  };
  return <div className="ssh-file-browser">
    <div className="ssh-file-toolbar" role="group" aria-label="Remote file actions">
      <button type="button" className="au-btn" title={reason ?? 'Refresh remote directory'} disabled={!!reason}
        onClick={browser.refresh}>Refresh</button>
      <button type="button" className="au-btn" title={reason ?? 'Create a remote folder'} disabled={!browser.canUseRows}
        onClick={() => open('folder')}>New folder</button>
      <button type="button" className="au-btn" title={reason ?? 'Create a remote file'} disabled={!browser.canUseRows}
        onClick={() => open('file')}>New file</button>
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
          if (browser.isLiveNow()) props.onEntryContextMenu?.(entry, event);
        }} />}
    </div>
    {dialogVisible && dialog && <SshNameDialog kind={dialog.kind} path={dialog.path}
      onClose={() => setDialog(undefined)} onSubmit={name => browser.create(dialog.kind, name)} />}
  </div>;
}
