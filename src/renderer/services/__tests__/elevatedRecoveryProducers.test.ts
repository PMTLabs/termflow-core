import fs from 'fs';
import path from 'path';

it('the_only_producers_of_elevated_true_are_openAdminTabWithProfile_detach_and_session_recovery', () => {
  const root = path.resolve(__dirname, '../..');
  const producers: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(file)) {
        const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        if (/(?:elevated\s*:\s*true|\.elevated\s*=\s*true)/.test(source)) producers.push(path.relative(root, file).replace(/\\/g, '/'));
      }
    }
  }
  walk(root);
  expect(producers.sort()).toEqual(['services/adminTabActions.ts', 'services/apiCreatedTab.ts']);
  const recovery = fs.readFileSync(path.join(root, 'services/apiCreatedTab.ts'), 'utf8');
  expect(recovery).toContain('const elevatedRecovery = !!detail.sessionKey && detail.elevated === true;');
  expect(recovery).toContain('if (elevatedRecovery) newTab.elevated = true;');
  expect(recovery).toContain('if (elevatedRecovery) paneTree.elevated = true;');
  expect(recovery).not.toContain('beginUserElevatedAttempt(');
});
