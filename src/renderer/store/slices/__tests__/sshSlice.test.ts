import reducer, { applyView, selectTree, selectBookmarked, SshState } from '../sshSlice';
import type { SshReply, SshConnection, SshFolder } from '../../../types/ssh';
const folder = (id: string, parentId: string | null, order: number): SshFolder => ({ id, parentId, order, name: id, icon: 'folder', color: 'sky' });
const connection = (id: string, folderId: string | null, order: number, bookmarked: boolean): SshConnection => ({ id, folderId, order, bookmarked, name: id, host: 'h', port: 22, user: '', auth: 'agent', identityFile: null, jumpConnectionId: null, extraOptions: [], lastUsedAt: null, hasSavedSecret: false });
export const reply = (revision: number): SshReply => ({ revision, view: { revision, folders: [folder('f-root', null, 1), folder('f-middle', 'f-root', 1), folder('f-leaf', 'f-middle', 0)], connections: [connection('c-root', null, 0, true), connection('c-parent', 'f-root', 0, false), connection('c-leaf', 'f-leaf', 0, true)], loadError: null } });
test('older/equal views cannot overwrite the mirror', () => {
  const newer = reducer(undefined, applyView(reply(9)));
  expect(reducer(newer, applyView(reply(2)))).toEqual(newer);
  expect(reducer(newer, applyView(reply(9)))).toEqual(newer);
});
test('selectTree nests three distinct levels in sibling order', () => {
  const ssh: SshState = reducer(undefined, applyView(reply(1))); const tree = selectTree({ ssh });
  expect(tree.map(n => n.row.id)).toEqual(['c-root', 'f-root']);
  expect(tree[1].kind).toBe('folder');
  if (tree[1].kind !== 'folder') throw Error('folder missing');
  expect(tree[1].children.map(n => n.row.id)).toEqual(['c-parent', 'f-middle']);
  const middle = tree[1].children[1]; if (middle.kind !== 'folder') throw Error('middle missing');
  expect(middle.children.map(n => n.row.id)).toEqual(['f-leaf']);
  const leaf = middle.children[0]; if (leaf.kind !== 'folder') throw Error('leaf missing');
  expect(leaf.children.map(n => n.row.id)).toEqual(['c-leaf']);
  expect(selectBookmarked({ ssh }).map(c => c.id)).toEqual(['c-root', 'c-leaf']);
});
