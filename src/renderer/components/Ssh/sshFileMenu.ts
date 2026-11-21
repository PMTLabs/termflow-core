import type { ContextMenuItem } from '../Terminal/ContextMenu';
import type { RemoteEntry } from './sshFileTypes';
import { insertPathReason } from './remotePathInput';

export type FileAction = 'open' | 'openWith' | 'download' | 'copy' | 'insert'
  | 'rename' | 'delete' | 'properties' | 'permissions';

export function fileActionReason(action: FileAction, entry: RemoteEntry, live: boolean): string | undefined {
  if (!live) return 'The remote listing is not live.';
  if (!entry.path) return 'This entry has no usable remote path.';
  const regular = entry.kind === 'file';
  const folder = entry.kind === 'directory';
  if (action === 'open' || action === 'openWith') {
    if (!regular) return 'Only regular files can be opened in an editor.';
    if (entry.size === undefined || entry.mtime === undefined) return 'Editing requires file size and modified time.';
  }
  if (action === 'download' || action === 'permissions') {
    if (!regular && !folder) return 'Only regular files and folders support this action.';
  }
  if (action === 'insert') return insertPathReason(entry.path);
}

export function sshFileMenu(entry: RemoteEntry, live: boolean, run: (action: FileAction) => void): ContextMenuItem[] {
  const item = (action: FileAction, label: string, accelerator?: string): ContextMenuItem => {
    const title = fileActionReason(action, entry, live);
    return { label, accelerator, title, enabled: !title, danger: action === 'delete',
      click: () => { if (!title) run(action); } };
  };
  const separator: ContextMenuItem = { type: 'separator' };
  return [
    item('open', 'Open'), item('openWith', 'Open with…'), item('download', 'Download…'), separator,
    item('copy', 'Copy path'), item('insert', 'Insert path', 'Middle-click'), separator,
    item('rename', 'Rename', 'F2'), item('delete', 'Delete…', 'Del'), separator,
    item('properties', 'Properties'), item('permissions', 'Permissions…'),
  ];
}

export function validRemoteName(name: string): boolean {
  return !!name.trim() && name !== '.' && name !== '..' && !/[/\p{Cc}]/u.test(name);
}
