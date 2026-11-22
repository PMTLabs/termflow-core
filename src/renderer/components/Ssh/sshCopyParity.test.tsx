/** @jest-environment jsdom */
import React, { act } from 'react';
import fs from 'fs';
import { createRoot } from 'react-dom/client';
import path from 'path';
import { readSource } from '../../utils/readSource';
import { SshSecretPrompt } from './SshSecretPrompt';
import { SshTestConnectionDialog } from './SshTestConnectionDialog';
import type { SshAPI, SshSessionView } from '../../types/ssh';

// Snapshots as the backend sends them now: the real reason text from session.rs plus its code.
// The develop renderer ignored errorCode and decoded the text; this renderer reads the code. The
// recorded text in __fixtures__/sshCopyParity.json is what develop rendered (backlog 017).
const session = readSource(path.resolve(__dirname, '..', '..', '..', '..', 'src-tauri', 'src', 'ssh', 'session.rs'));
const body = session.slice(session.indexOf('pub fn reason(&self) -> String {'));
const backendReasons = [...body.slice(0, body.indexOf('\n    }\n')).matchAll(/Self::(\w+)(?: \{[^}]*\})? => (?:"([^"]*)"\.into\(\)|format!\("([^"]*)"\))/g)]
  .map(([, variant, plain, formatted]) => ({ code: variant.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(), text: (plain ?? formatted).replace('{line}', '7') }));
const saved = 'Saved credential unavailable. Enter it again; Remember may be unavailable.';
const base: SshSessionView = { probeId: 'probe-a', connectionId: 'c-a', state: 'error', generation: 1, revision: 1, gate: 'blocked',
  promptId: 'p-a', secretKind: 'password', promptTarget: { connectionId: 'c-a', host: 'target.test', port: 22, user: 'alice', hop: 'target' } };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

async function renderCases(): Promise<Record<string, string>> {
  const host = document.createElement('div'); document.body.append(host); let root = createRoot(host);
  const out: Record<string, string> = {};
  const dialog = async (name: string, snapshot: SshSessionView) => {
    const api = { onSshTestState: async () => () => {}, sshTestConnection: async () => ({ probeId: 'probe-a' }),
      sshTestState: async () => snapshot, sshTestClose: async () => {} } as unknown as SshAPI;
    await act(async () => { root.render(<SshTestConnectionDialog connectionId="c-a" api={api} onClose={() => {}} />); await flush(); });
    out[`dialog ${name}`] = document.querySelector('.ssh-test-dialog')!.textContent!;
    act(() => root.unmount()); root = createRoot(host);
  };
  const prompt = (name: string, view: SshSessionView) => {
    act(() => root.render(<SshSecretPrompt view={view} onSubmit={async () => {}} onCancel={() => {}} />));
    out[`pane prompt ${name}`] = host.textContent!;
    act(() => root.unmount()); root = createRoot(host);
  };
  for (const { code, text } of backendReasons) {
    const errorLine = code === 'known-hosts-malformed' ? 7 : undefined;
    await dialog(`error ${code}`, { ...base, state: 'error', reason: text, errorCode: code, errorLine, promptId: undefined, promptTarget: undefined, secretKind: undefined });
    await dialog(`disconnected ${code}`, { ...base, state: 'disconnected', reason: text, errorCode: code, errorLine, promptId: undefined, promptTarget: undefined, secretKind: undefined });
  }
  const malformed = { ...base, errorCode: 'known-hosts-malformed', promptId: undefined, promptTarget: undefined };
  await dialog('error known-hosts-malformed encoding', { ...malformed, errorLine: 0 });
  await dialog('error known-hosts-malformed no line', malformed);
  // No reason text: the line must come from errorLine, not from echoing the backend reason.
  await dialog('error known-hosts-malformed line without reason', { ...malformed, errorLine: 7 });
  await dialog('disconnected free text', { ...base, state: 'disconnected', reason: 'SSH transport closed', promptId: undefined, promptTarget: undefined });
  const rejected = backendReasons.find(r => r.code === 'auth-rejected')!.text, notSaved = backendReasons.find(r => r.code === 'remember-unavailable')!.text;
  for (const kind of ['password', 'passphrase'] as const) {
    await dialog(`needs-secret auth-rejected ${kind}`, { ...base, state: 'needs-secret', secretKind: kind, reason: rejected, errorCode: 'auth-rejected' });
    prompt(`auth-rejected ${kind}`, { ...base, state: 'needs-secret', secretKind: kind, reason: rejected, errorCode: 'auth-rejected' });
  }
  await dialog('needs-secret saved-credential-unavailable', { ...base, state: 'needs-secret', reason: saved, errorCode: 'saved-credential-unavailable' });
  prompt('saved-credential-unavailable', { ...base, state: 'needs-secret', reason: saved, errorCode: 'saved-credential-unavailable' });
  await dialog('needs-secret no reason', { ...base, state: 'needs-secret' });
  prompt('no reason', { ...base, state: 'needs-secret' });
  await dialog('connected remember-unavailable', { ...base, state: 'connected', reason: notSaved, errorCode: 'remember-unavailable', promptId: undefined, promptTarget: undefined });
  await dialog('connected no reason', { ...base, state: 'connected', promptId: undefined, promptTarget: undefined });
  host.remove();
  return out;
}

const fixture = path.join(__dirname, '__fixtures__', 'sshCopyParity.json');
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

test('structured errors preserve dialog copy and include known_hosts line details', async () => {
  const now = await renderCases();
  if (process.env.SSH_COPY_PARITY_RECORD) fs.writeFileSync(fixture, JSON.stringify(now, null, 1) + '\n');
  const before = JSON.parse(fs.readFileSync(fixture, 'utf8')) as Record<string, string>;
  expect(backendReasons.length).toBeGreaterThanOrEqual(25);
  expect(Object.keys(before).length).toBe(2 * backendReasons.length + 14);
  expect(now).toEqual(before);
});
