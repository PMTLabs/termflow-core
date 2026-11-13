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
export const selectTree = createSelector([(state: { ssh: SshState }) => state.ssh.view], (view): SshTreeNode[] => {
  const { folders, connections } = view;
  const children = (parent: string | null): SshTreeNode[] => [
    ...folders.filter(f => f.parentId === parent).map(row => ({ kind: 'folder' as const, row, children: children(row.id) })),
    ...connections.filter(c => c.folderId === parent).map(row => ({ kind: 'connection' as const, row })),
  ].sort((a, b) => a.row.order - b.row.order);
  return children(null);
});
export const selectBookmarked = createSelector([selectTree], (tree): SshConnection[] => {
  const flatten = (tree: SshTreeNode[]): SshConnection[] => tree.flatMap(node => node.kind === 'folder' ? flatten(node.children) : node.row.bookmarked ? [node.row] : []);
  return flatten(tree);
});
