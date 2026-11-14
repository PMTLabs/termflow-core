import path from 'path';
import { readSource } from '../../../utils/readSource';
import { SSH_FOLDER_ICONS, SSH_FOLDER_COLORS } from '../SshConnections/sshFolderIcons';
const rust = readSource(path.resolve(__dirname, '../../../../../src-tauri/src/ssh/store.rs'));
test.each([['ICONS', SSH_FOLDER_ICONS], ['COLORS', SSH_FOLDER_COLORS]] as const)('Rust/TS %s sets agree exactly', (name, expected) => {
  const block = new RegExp(`pub const ${name}: &[\\s\\S]+?= &\\[([\\s\\S]+?)\\];`).exec(rust);
  expect(block).not.toBeNull(); const actual = [...block![1].matchAll(/"([a-z]+)"/g)].map(m => m[1]);
  expect(actual.length).toBeGreaterThan(0); expect([...actual].sort()).toEqual([...expected].sort());
});
