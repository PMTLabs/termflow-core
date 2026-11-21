/** @jest-environment jsdom */
import fs from 'fs';
import path from 'path';
import { backendReasons, renderCases } from './sshCopyParity.cases';

const fixture = path.join(__dirname, '__fixtures__', 'sshCopyParity.json');
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

test('reading errorCode renders exactly the copy the text-decoding renderer rendered', async () => {
  const now = await renderCases();
  if (process.env.SSH_COPY_PARITY_RECORD) fs.writeFileSync(fixture, JSON.stringify(now, null, 1) + '\n');
  const before = JSON.parse(fs.readFileSync(fixture, 'utf8')) as Record<string, string>;
  expect(backendReasons.length).toBeGreaterThanOrEqual(25);
  expect(Object.keys(before).length).toBe(2 * backendReasons.length + 11);
  expect(now).toEqual(before);
});
