import type { SshConnection, SshFolder } from '../../../types/ssh';
import { filterSshConnections, selectSshSearchRows, type SshState } from '../sshSlice';

const connection = (id: string, lastUsedAt: number | null, patch: Partial<SshConnection> = {}): SshConnection => ({
  id, name: id, host: 'gateway.example', port: 22, user: 'ops', auth: 'agent', identityFile: null,
  jumpConnectionId: null, extraOptions: [], folderId: null, order: 0, bookmarked: false,
  hasSavedSecret: false, lastUsedAt, ...patch,
});
const folder = (id: string, name: string, parentId: string | null = null): SshFolder =>
  ({ id, name, parentId, icon: '', color: '', order: 0 });
const rows = (connections: SshConnection[], folders: SshFolder[] = []) =>
  selectSshSearchRows({ ssh: { view: { connections, folders, revision: 1, loadError: null }, status: 'ready', revision: 1, error: null } satisfies SshState });
const ids = (matches: ReturnType<typeof rows>) => matches.map(row => row.connection.id);

test('recent_excludes_never_used_and_sorts_attempt_timestamps', () => {
  // sshSlice/filterSshConnections: drop the null guard or sort attempt timestamps in ascending order.
  expect(ids(filterSshConnections(rows([
    connection('older', 10), connection('unused', null), connection('newer', 40), connection('epoch', 0),
  ]), 'Recent', ''))).toEqual(['newer', 'older', 'epoch']);
});

test('search_intersects_bookmarked_recent_and_folder_path', () => {
  // sshSlice/filterSshConnections: remove the search AND condition or either filter predicate.
  const source = rows([
    connection('used-only', 200, { folderId: 'west' }),
    connection('both', 100, { folderId: 'west', bookmarked: true }),
    connection('star-only', null, { folderId: 'west', bookmarked: true }),
    connection('other-region', 300, { folderId: 'east', bookmarked: true }),
  ], [folder('fleet', 'Fleet'), folder('west', 'West', 'fleet'), folder('east', 'East', 'fleet')]);
  expect(ids(filterSshConnections(source, 'Bookmarked', 'FLEET WEST gateway'))).toEqual(['both', 'star-only']);
  expect(ids(filterSshConnections(source, 'Recent', 'FLEET WEST gateway'))).toEqual(['used-only', 'both']);
  expect(ids(filterSshConnections(source, 'All', 'east gateway'))).toEqual(['other-region']);
});
