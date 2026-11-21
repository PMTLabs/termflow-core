import fs from 'fs';
import path from 'path';
import { readSource } from '../../utils/readSource';
import { failureCopy, testDialogCopy } from './SshTestConnectionDialog';
import { savedCredentialUnavailable } from './SshSecretPrompt';

// Snapshots carry the backend code as `errorCode` (backlog 017), so the renderer keys its copy by
// code and never reads the reason text. This pins the code sets on both sides and keeps text
// matching from coming back.
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const session = readSource(path.resolve(ROOT, 'src-tauri', 'src', 'ssh', 'session.rs'));
const fnBody = (signature: string) => {
  const body = session.slice(session.indexOf(signature));
  return body.slice(0, body.indexOf('\n    }\n'));
};
const codes = [...fnBody("pub fn code(&self) -> &'static str {").matchAll(/Self::\w+(?: \{ \.\. \})? => "([a-z-]+)",/g)].map(m => m[1]);
const reasons = [...fnBody('pub fn reason(&self) -> String {').matchAll(/Self::(\w+)(?: \{[^}]*\})? => (?:"([^"]*)"\.into\(\)|format!\("([^"]*)"\))/g)]
  .map(([, variant, plain, formatted]) => ({ variant, text: plain ?? formatted }));

test('session.rs code() and reason() are parsed', () => {
  expect(codes.length).toBeGreaterThanOrEqual(25);
  expect(reasons.length).toBe(codes.length);
});

test('every backend code has renderer copy, and nothing else does', () => {
  expect([...failureCopy.keys()].sort()).toEqual([...codes].sort());
});

test('the saved-credential warning code matches the backend constant', () => {
  expect(session).toContain(`pub const SAVED_CREDENTIAL_UNAVAILABLE: &str = "${savedCredentialUnavailable}";`);
  expect(codes).not.toContain(savedCredentialUnavailable);
});

// The same reasons reach SSH panes, the file browser and metrics, so the backend text must not
// point at one surface. Test-dialog actions live in the renderer's testDialogCopy instead.
test('backend reasons are context-neutral', () => {
  for (const { variant, text } of reasons) {
    expect([variant, /Test connection|SSH Connections/.test(text)]).toEqual([variant, false]);
  }
});

test('Test dialog copy only overrides backend codes and names its next step', () => {
  for (const [code, copy] of testDialogCopy) {
    expect([code, codes.includes(code), /Test connection|SSH Connections/.test(copy)]).toEqual([code, true, true]);
  }
});

// A comparison of `reason` against text, or a text probe on it, means a reader is decoding the
// backend's English again instead of using `errorCode`.
const textMatch = /\breason\??\.(?:startsWith|endsWith|includes|match|test)\(|\breason\s*[!=]==?\s*['"`]|['"`]\s*[!=]==?\s*(?:\w+\??\.)*reason\b|\bfailureCopy\b[^;\n]*\breason\b|\breasonCode\b/;

test('the text-match detector catches each spelling and passes code checks', () => {
  for (const bad of [
    "view.reason === 'Authentication was not accepted.'",
    'reason?.startsWith("Saved credential")',
    'view.reason.includes(`known_hosts`)',
    "'text' === view?.reason",
    'for (const [key, message] of failureCopy) if (message === view.reason) return key;',
    'const code = reasonCode(view.reason);',
  ]) expect([bad, textMatch.test(bad)]).toEqual([bad, true]);
  for (const ok of [
    "view.errorCode === 'auth-rejected'",
    '{view.reason && <span role="status">{view.reason}</span>}',
    "reason: code === 'auth-rejected' ? authCopy(view.secretKind) : view.reason ? fallback : undefined,",
  ]) expect([ok, textMatch.test(ok)]).toEqual([ok, false]);
});

test('no SSH renderer source matches on reason text', () => {
  const dir = path.resolve(__dirname);
  const files = fs.readdirSync(dir).filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  expect(files).toEqual(expect.arrayContaining(['SshTestConnectionDialog.tsx', 'SshSecretPrompt.tsx', 'SshPaneShell.tsx']));
  const hits = files.flatMap(f => readSource(path.join(dir, f)).split('\n')
    .map((line, i) => ({ at: `${f}:${i + 1}`, line: line.trim() }))
    .filter(({ line }) => !line.startsWith('//') && textMatch.test(line)));
  expect(hits).toEqual([]);
});
