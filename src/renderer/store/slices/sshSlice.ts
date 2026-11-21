import { createSelector, createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { SshConnection, SshFolder, SshView, SshReply } from '../../types/ssh';
export interface SshState { view: SshView; revision: number; status: 'loading' | 'ready' | 'desktop-only' | 'error'; error: string | null }
const initialState: SshState = { view: { revision: 0, folders: [], connections: [], loadError: null }, revision: -1, status: 'loading', error: null };
const slice = createSlice({ name: 'ssh', initialState, reducers: {
  applyView(state, { payload }: PayloadAction<SshReply>) {
    if (payload.revision <= state.revision) return;
    state.revision = payload.revision; state.view = payload.view; state.status = 'ready'; state.error = null;
  },
  loadFailed(state, { payload }: PayloadAction<{ code?: string; message?: string }>) {
    state.status = payload.code === 'desktop-only' ? 'desktop-only' : 'error'; state.error = payload.message ?? 'Unable to load SSH connections';
  },
} });
export const { applyView, loadFailed } = slice.actions;
export default slice.reducer;
export type SshTreeNode = { kind: 'folder'; row: SshFolder; children: SshTreeNode[] } | { kind: 'connection'; row: SshConnection };
export function buildSshTree(view: SshView): SshTreeNode[] {
  const { folders, connections } = view;
  const children = (parent: string | null): SshTreeNode[] => [
    ...folders.filter(f => f.parentId === parent).map(row => ({ kind: 'folder' as const, row, children: children(row.id) })),
    ...connections.filter(c => c.folderId === parent).map(row => ({ kind: 'connection' as const, row })),
  ].sort((a, b) => a.row.order - b.row.order);
  return children(null);
}
export const selectTree = createSelector([(state: { ssh: SshState }) => state.ssh.view], buildSshTree);
/** Unique descendant connection ids of one folder (its direct children included), in tree order; unfiltered. */
export function selectFolderConnectionIds(view: SshView, folderId: string): string[] {
  const find = (nodes: SshTreeNode[]): SshTreeNode | undefined => {
    for (const node of nodes) {
      if (node.kind !== 'folder') continue;
      if (node.row.id === folderId) return node;
      const inner = find(node.children);
      if (inner) return inner;
    }
    return undefined;
  };
  const ids: string[] = [];
  const walk = (nodes: SshTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'folder') walk(node.children);
      else if (!ids.includes(node.row.id)) ids.push(node.row.id);
    }
  };
  const folder = find(buildSshTree(view));
  if (folder?.kind === 'folder') walk(folder.children);
  return ids;
}
export const selectBookmarked = createSelector([selectTree], (tree): SshConnection[] => {
  const flatten = (tree: SshTreeNode[]): SshConnection[] => tree.flatMap(node => node.kind === 'folder' ? flatten(node.children) : node.row.bookmarked ? [node.row] : []);
  return flatten(tree);
});

export type SshConnectionFilter = 'All' | 'Bookmarked' | 'Recent';
export type SshSearchRow = { connection: SshConnection; breadcrumb: string; host: string };

export const selectSshSearchRows = createSelector(
  [(state: { ssh: SshState }) => state.ssh.view, selectTree],
  (view, tree): SshSearchRow[] => {
    const rows: SshSearchRow[] = [];
    const walk = (nodes: SshTreeNode[], path: string[]) => {
      for (const node of nodes) {
        if (node.kind === 'folder') walk(node.children, [...path, node.row.name]);
        else {
          const { host, user, port } = node.row;
          const address = port !== 22 && host.includes(':') ? `[${host}]` : host;
          rows.push({
            connection: node.row, breadcrumb: path.join(' / '),
            host: `${user ? `${user}@` : ''}${address}${port === 22 ? '' : `:${port}`}`,
          });
        }
      }
    };
    if (!view.loadError) walk(tree, []);
    return rows;
  },
);

export function filterSshConnections(rows: SshSearchRow[], filter: SshConnectionFilter, search: string): SshSearchRow[] {
  const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = rows.filter(({ connection, host, breadcrumb }) => {
    if (filter === 'Bookmarked' && !connection.bookmarked) return false;
    if (filter === 'Recent' && connection.lastUsedAt == null) return false;
    const text = `${connection.name} ${host} ${breadcrumb}`.toLowerCase();
    return terms.every(term => text.includes(term));
  });
  if (filter === 'Recent') matches.sort((a, b) => b.connection.lastUsedAt! - a.connection.lastUsedAt!);
  return matches;
}
