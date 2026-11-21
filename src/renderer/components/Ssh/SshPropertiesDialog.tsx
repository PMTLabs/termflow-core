import React from 'react';
import { SshFileDialog } from './SshFileDialog';
import { copyRemotePath } from './sshFileFeedback';
import type { SshRowScope } from './useSshFileBrowser';
import { staleTarget, useSshTargetStat } from './useSshTargetStat';

const unavailable = 'Unavailable';
const date = (seconds?: number) => seconds === undefined ? unavailable : new Date(seconds * 1000).toLocaleString();
const kinds = { file: 'File', directory: 'Folder', symlink: 'Symbolic link', other: 'Special entry' };

function formatMode(mode: number, kind: RemoteStat['kind']): string {
  const type = { file: '-', directory: 'd', symlink: 'l', other: '?' }[kind];
  const groups = [6, 3, 0].map((shift, index) => {
    const bits = (mode >> shift) & 7;
    const special = mode & (0o4000 >> index);
    const execute = !!(bits & 1);
    const specialChar = index === 2 ? 't' : 's';
    return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${special
      ? (execute ? specialChar : specialChar.toUpperCase())
      : (execute ? 'x' : '-')}`;
  });
  return `${type}${groups.join('')} (${(mode & 0o7777).toString(8).padStart(4, '0')})`;
}

export function SshPropertiesDialog({ scope, connection, onClose }: {
  scope: SshRowScope; connection?: string; onClose(): void;
}) {
  const { stat, loadError } = useSshTargetStat(scope);
  const path = scope.request.path;
  const mode = stat?.mode;
  const live = scope.isLive();
  const fields = stat && [
    ['Name', stat.name], ['Type', kinds[stat.kind]], ['Size (bytes)', stat.size ?? unavailable],
    ['Owner (UID) : Group (GID)', `${stat.uid ?? unavailable} : ${stat.gid ?? unavailable}`],
    ['Mode (octal)', mode === undefined ? unavailable : formatMode(mode, stat.kind)],
    ['Modified', date(stat.mtime)], ['Accessed', date(stat.atime)],
    ...(stat.kind === 'symlink' ? [['Link target', stat.linkTarget ?? unavailable]] : []),
  ];
  return <SshFileDialog title="Properties" onCancel={onClose} footer={<>
    <button type="button" className="confirm-btn secondary" disabled={!live} onClick={() => {
      if (scope.isLive()) void copyRemotePath(path);
    }}>Copy path</button>
    <button type="button" className="confirm-btn cancel" data-dialog-cancel onClick={onClose}>Close</button>
  </>}>
    <dl>
      <dt>Path</dt><dd><code>{path}</code></dd>
      <dt>Connection</dt><dd>{connection || unavailable}</dd>
      {fields?.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}
    </dl>
    {!stat && !loadError && live && <p role="status">Loading properties…</p>}
    {(loadError || !live) && <p role="alert">{loadError || staleTarget}</p>}
  </SshFileDialog>;
}
