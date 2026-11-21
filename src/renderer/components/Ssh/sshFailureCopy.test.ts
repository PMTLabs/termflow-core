import fs from 'fs';
import path from 'path';
import { readSource } from '../../utils/readSource';
import { failureCopy, testDialogCopy } from './SshTestConnectionDialog';
import { savedCredentialUnavailable } from './SshSecretPrompt';

// Snapshots carry the backend code as `errorCode` (backlog 017), so the renderer keys its copy by
// code and never reads the reason text. This pins the code sets on both sides, and a source scan
// flags the usual ways of decoding reason text (a line-level scan; it cannot see every spelling).
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
  expect(session).toContain(`pub(crate) const SAVED_CREDENTIAL_UNAVAILABLE: &str = "${savedCredentialUnavailable}";`);
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

// A comparison of `reason` against text, a text probe on it, or a lookup keyed by it means a reader
// is decoding the backend's English again instead of using `errorCode`.
const fieldRef = String.raw`(?:\w+\??\.)*reason\b`;
const textMatchers = [
  /\breason\??\.(?:startsWith|endsWith|includes|match|matchAll|test|replace|replaceAll|indexOf|lastIndexOf|search|localeCompare|split|slice|substring|trim)\(/,
  new RegExp(String.raw`\.(?:test|exec|get|has)\(\s*${fieldRef}`),
  /\breason\s*[!=]==?\s*(?!undefined\b|null\b)[\w'"`]/,
  new RegExp(String.raw`[\w'"\x60)\]]\s*[!=]==?\s*${fieldRef}`),
  new RegExp(String.raw`\bswitch\s*\(\s*${fieldRef}`),
  /\breasonCode\b/,
  /\bfailureCopy\b[^;\n]*\breason\b/,
];
const decodes = (line: string) => textMatchers.some(re => re.test(line));

test('the text-match detector catches each spelling and passes code checks', () => {
  for (const bad of [
    "view.reason === 'Authentication was not accepted.'",
    'reason?.startsWith("Saved credential")',
    'view.reason.includes(`known_hosts`)',
    "'text' === view?.reason",
    'for (const [key, message] of failureCopy) if (message === view.reason) return key;',
    'const code = reasonCode(view.reason);',
    // The spellings the deleted reasonCode() and its callers used:
    "const code = reason.replace(/^SSH operation failed: /, '');",
    'if (/^An entry in known_hosts could not be read at line \\d+\\./.test(reason)) return x;',
    'view.reason === savedCredentialWarning ? a : b',
    'switch (view.reason) {',
    "const code = byText.get(view?.reason ?? '');",
    'if (reason.indexOf(prefix) === 0) {',
  ]) expect([bad, decodes(bad)]).toEqual([bad, true]);
  for (const ok of [
    "view.errorCode === 'auth-rejected'",
    '{view.reason && <span role="status">{view.reason}</span>}',
    "reason: code === 'auth-rejected' ? authCopy(view.secretKind) : view.reason ? fallback : undefined,",
    "const reason = view.errorCode === 'auth-rejected'",
    'if (view.reason === undefined) return;',
  ]) expect([ok, decodes(ok)]).toEqual([ok, false]);
});

test('no renderer source that handles SSH session views matches on reason text', () => {
  const renderer = path.resolve(__dirname, '..', '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(full); }
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(renderer);
  const ssh = files.filter(f => /[\\/]Ssh/.test(path.relative(renderer, f)) || readSource(f).includes('SshSessionView'));
  const names = ssh.map(f => path.relative(renderer, f).replace(/\\/g, '/'));
  expect(names).toEqual(expect.arrayContaining(['components/Ssh/SshTestConnectionDialog.tsx', 'components/Ssh/SshSecretPrompt.tsx',
    'components/Ssh/SshPaneShell.tsx', 'store/slices/sshSessionSlice.ts', 'components/Settings/SshConnections/SshConnectionEditor.tsx']));
  const hits = ssh.flatMap(f => readSource(f).split('\n')
    .map((line, i) => ({ at: `${path.relative(renderer, f)}:${i + 1}`, line: line.trim() }))
    .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*') && decodes(line)));
  expect(hits).toEqual([]);
});
