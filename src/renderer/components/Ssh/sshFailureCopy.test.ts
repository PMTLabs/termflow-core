import path from 'path';
import { readSource } from '../../utils/readSource';
import { failureCopy, reasonCode } from './SshTestConnectionDialog';

// Probe snapshots carry only the backend's human reason, not its code, so the Test dialog maps
// that text back to a code (backlog 017: the snapshot should carry the code). This pins both
// sides: every `SessionError::reason()` string in session.rs must match the renderer copy for its
// kebab-case code, and every renderer entry must have a backend variant.
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const session = readSource(path.resolve(ROOT, 'src-tauri', 'src', 'ssh', 'session.rs'));
const body = session.slice(session.indexOf('pub fn reason(&self) -> String {'));
const arms = [...body.slice(0, body.indexOf('\n    }\n}')).matchAll(/Self::(\w+)(?: \{[^}]*\})? => (?:"([^"]*)"\.into\(\)|format!\("([^"]*)"\))/g)]
  .map(([, variant, plain, formatted]) => ({
    code: variant.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(),
    text: plain ?? formatted,
  }));

test('session.rs reason() is parsed', () => {
  expect(arms.length).toBeGreaterThanOrEqual(25);
});

test('every backend reason matches the renderer copy for its code', () => {
  for (const { code, text } of arms) {
    // The malformed-known_hosts reason names a line; the renderer copy is the line-free base.
    const backend = code === 'known-hosts-malformed' ? text.replace(' at line {line}', '') : text;
    expect([code, failureCopy.get(code)]).toEqual([code, backend]);
  }
});

test('every renderer code has a backend variant', () => {
  expect([...failureCopy.keys()].sort()).toEqual(arms.map(arm => arm.code).sort());
});

test('backend reason text maps back to its code', () => {
  for (const { code, text } of arms) {
    expect([text, reasonCode(text.replace('{line}', '12'))]).toEqual([text, code]);
  }
});
