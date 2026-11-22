/**
 * Plan 070 T1: SSH contract inventory census (ledger: termflow-fabric docs/progress/123, section T1).
 *
 * Node environment on purpose: no jsdom, no store import. Everything here is read from source.
 *
 * A source census only catches omissions. It cannot prove that a link works; the named behavioural
 * tests in the ledger do that. The rules this file follows:
 *  - Every set is derived from SYNTAX (a `#[tauri::command]` attribute, a `generate_handler!` body, a
 *    call whose first argument is an `ssh_*` literal, a `listen*(` call, an interface body) and never
 *    from a hand-picked list of names.
 *  - Every census walks a whole tree (`src/renderer`, `src-tauri/src`) instead of naming the files
 *    that happen to hold the symbols today, so moving or splitting a file cannot empty a census.
 *  - Every derived set is asserted non-empty BEFORE it is compared (positive control), so a regex
 *    that silently stops matching fails loudly instead of comparing two empty sets.
 *  - Line endings are normalised by `readSource` (CRLF-safe on the Windows runner).
 */
import fs from 'fs';
import path from 'path';
import { readSource } from '../../../utils/readSource';

const ROOT = path.resolve(__dirname, '../../../../..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const RUST_SRC = path.join(ROOT, 'src-tauri', 'src');

// ---------------------------------------------------------------------------------------------
// Ledger pins (LANDED rows only, feature/ssh-canvas-integration @ adbd015).
// ---------------------------------------------------------------------------------------------

/**
 * Binding list: bridge member -> registered command (ssh_*) or app event (ssh-*:*). Written from the
 * approved contracts (plan 070 section 4.3), not derived. It is what makes the oracle row "all layers
 * agree on an omitted known command" fail: if one command disappeared from the Rust declaration, the
 * handler registry, the bridge and the types all at once, the derived sets would still agree with
 * each other, but no longer with this list.
 */
const BINDING: Readonly<Record<string, string>> = {
  // 065 saved-connection store: ElectronAPI.ssh (SshStoreApi).
  get: 'ssh_store_get',
  reload: 'ssh_store_reload',
  upsertFolder: 'ssh_folder_upsert',
  deleteFolder: 'ssh_folder_delete',
  upsertConnection: 'ssh_connection_upsert',
  deleteConnection: 'ssh_connection_delete',
  move: 'ssh_move',
  setBookmark: 'ssh_set_bookmark',
  onChanged: 'ssh-store:changed',
  // 067 sessions and the pane-less Test probe: flat ElectronAPI members (SshAPI).
  sshSessionOpen: 'ssh_session_open',
  sshSessionState: 'ssh_session_state',
  sshSessionClose: 'ssh_session_close',
  sshSessionReconnect: 'ssh_session_reconnect',
  sshSessionSubmitSecret: 'ssh_session_submit_secret',
  sshSessionTrustHost: 'ssh_session_trust_host',
  sshTestConnection: 'ssh_test_connection',
  sshTestState: 'ssh_test_state',
  sshTestClose: 'ssh_test_close',
  sshTestSubmitSecret: 'ssh_test_submit_secret',
  sshTestTrustHost: 'ssh_test_trust_host',
  onSshSessionState: 'ssh-session:state',
  onSshTestState: 'ssh-test:state',
  // 068 remote files: ElectronAPI.ssh (SshFileApi). Upload is Rust watcher-only: no ssh_fs_upload.
  fsList: 'ssh_fs_list',
  fsStat: 'ssh_fs_stat',
  fsMkdir: 'ssh_fs_mkdir',
  fsCreate: 'ssh_fs_create',
  fsRename: 'ssh_fs_rename',
  fsDelete: 'ssh_fs_delete',
  fsChmod: 'ssh_fs_chmod',
  fsChown: 'ssh_fs_chown',
  fsDownload: 'ssh_fs_download',
  fsOpen: 'ssh_fs_open',
  fsOpenWith: 'ssh_fs_open_with',
  fsInsertPath: 'ssh_fs_insert_path',
  fsEditStop: 'ssh_fs_edit_stop',
  fsEditList: 'ssh_fs_edit_list',
  // P068-7 (#189): dismiss a retained (ended) edit row.
  fsEditDismiss: 'ssh_fs_edit_dismiss',
  onFsEditState: 'ssh-fs:edit-state',
  onFsCwd: 'ssh-fs:cwd',
  // 066 launch coordinator and store additions (landed on develop with #182; moved from PENDING).
  previewConnection: 'ssh_connection_preview',
  markUsed: 'ssh_connection_mark_used',
  forgetSecret: 'ssh_forget_secret', // not in the 070 ledger; landed by 066, see ledger GAP list
  launchTerminal: 'ssh_terminal_launch',
  cancelTerminalLaunch: 'ssh_terminal_cancel_launch',
  terminalLaunchState: 'ssh_terminal_launch_state',
  onSshLaunchState: 'ssh-launch:state',
  sshMetricsWatch: 'ssh_metrics_watch',
  sshMetricsUnwatch: 'ssh_metrics_unwatch',
  sshMetricsResume: 'ssh_metrics_resume',
  onSshMetricsSample: 'ssh-metrics:sample',
  onSshMetricsControl: 'ssh-metrics:control',
};

// 070-rebase: PENDING-066 / PENDING-069 contracts (ledger 123). NOT asserted yet. After each sibling
// rebases onto this branch the derived sets grow by exactly these rows; move each one into BINDING
// (and its CSS/event into the pins below), then delete it from here. A row still listed here after
// its owner merged is itself a ledger defect.
const PENDING_AFTER_REBASE: ReadonlyArray<readonly [member: string, name: string, owner: string]> = [
];
void PENDING_AFTER_REBASE;

/**
 * EXCEPTIONS (documented, not orphans):
 * Bridge members with no production renderer caller on this branch. Each is a ledger row:
 *  - sshSessionOpen / sshSessionReconnect / sshSessionSubmitSecret / sshSessionTrustHost left this
 *    list when 066 landed: its launch coordinator (services/sshLaunchAttempt.ts) and launch notice
 *    (OwnedSshLaunchNotice.tsx, the single prompt owner on both surfaces under D51) call them.
 *  - sshSessionClose: GAP in every branch. Pane disposal closes the session in Rust through pane_op
 *    `ssh_retired` -> SessionRegistry::retire_owner; the bridge method has no renderer caller at all.
 * The comparison is two-way: when 066 lands a caller, this list must shrink with it.
 */
const CONSUMER_EXCEPTIONS: readonly string[] = [
  'sshSessionClose',
];

/** Events the Rust side emits and the renderer listens to (065 store, 067 session/probe, 068 files). */
const LANDED_EVENTS: readonly string[] = [
  'ssh-fs:cwd',
  'ssh-fs:edit-state',
  'ssh-launch:state',
  'ssh-metrics:sample',
  'ssh-metrics:control',
  'ssh-session:state',
  'ssh-store:changed',
  'ssh-test:state',
];

/** Custom properties defined in SSH-owned files (Settings folder colours, 065). */
const LEDGER_SSH_CSS_DEFINED: readonly string[] = [
  '--ssh-amber', '--ssh-green', '--ssh-grey', '--ssh-orange', '--ssh-sky', '--ssh-violet',
];
/** Every custom property read with var() from an SSH-owned file. */
const LEDGER_SSH_CSS_READ: readonly string[] = [
  '--accent-color', '--bg-hover', '--bg-primary', '--bg-secondary', '--border-color', '--error-color', '--focus-border',
  '--ssh-amber', '--ssh-green', '--ssh-grey', '--ssh-orange', '--ssh-sky', '--ssh-violet',
  '--tab-active-foreground', '--tab-foreground', '--text-primary', '--text-secondary',
];
/**
 * Theme fallbacks: read with an inline fallback value and defined nowhere in src/renderer. Allowed
 * only if every SSH read carries the fallback, so the property can never resolve to nothing.
 */
const THEME_FALLBACKS: readonly string[] = ['--error-color', '--focus-border'];
/** Existing Canvas properties the SSH node layout must keep (plan 070 section 4.3, last two rows). */
const CANVAS_AUDITED: readonly string[] = [
  '--canvas-raster-r', '--canvas-raster-inv', '--node-host-w', '--node-host-h', '--node-surface-scale', '--node-surface-shift',
];
// 070-rebase: CSS properties added by 066/069 (SSH bar, metrics) join both lists above.

// ---------------------------------------------------------------------------------------------
// Source walking and lexing.
// ---------------------------------------------------------------------------------------------

interface SourceFile { rel: string; text: string }

function walk(dir: string, extensions: readonly string[], out: SourceFile[]): SourceFile[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'target') walk(full, extensions, out);
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      out.push({ rel: path.relative(ROOT, full).split(path.sep).join('/'), text: readSource(full) });
    }
  }
  return out;
}

const isRendererTest = (rel: string): boolean =>
  /\/__tests__\//.test(rel) || /\/__testFixtures__\//.test(rel) || /\.(test|spec)\.[tj]sx?$/.test(rel) || rel.startsWith('src/renderer/test/');
const isRustTestFile = (rel: string): boolean => /(_tests|\/tests|test_server)\.rs$/.test(rel) || /\/tests\//.test(rel);
/** SSH-owned renderer files, by path rather than by a list: components/Ssh, Settings/SshConnections, ssh*.ts. */
const isSshOwned = (rel: string): boolean => /ssh/i.test(rel);

/** TS/JS: comments blanked (offsets kept), string and template literals kept verbatim. */
function stripTsComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      const nl = src.indexOf('\n', i);
      const stop = nl < 0 ? src.length : nl;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === '/' && n === '*') {
      const close = src.indexOf('*/', i + 2);
      const stop = close < 0 ? src.length : close + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && !(c !== '`' && src[j] === '\n')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Rust: comments blanked; strings (incl. raw and multi-line), char literals and lifetimes kept. */
function stripRustComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const stop = nl < 0 ? src.length : nl;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src.startsWith('/*', j)) { depth += 1; j += 2; } else if (src.startsWith('*/', j)) { depth -= 1; j += 2; } else j += 1;
      }
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
    } else if (c === '"') {
      const end = rustStringEnd(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (c === "'") {
      const end = rustCharEnd(src, i);
      out += src.slice(i, end);
      i = end;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function rustStringEnd(src: string, open: number): number {
  let hashes = 0;
  while (src[open - 1 - hashes] === '#') hashes += 1;
  if (src[open - 1 - hashes] === 'r') {
    const close = src.indexOf(`"${'#'.repeat(hashes)}`, open + 1);
    return close < 0 ? src.length : close + 1 + hashes;
  }
  let j = open + 1;
  while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, src.length);
}

/** `'x'`, `'\n'`, `'\''`, `'\u{..}'` are char literals; anything else (`'a`, `'static`) is a lifetime. */
function rustCharEnd(src: string, open: number): number {
  if (src[open + 1] === '\\') {
    const close = src.indexOf("'", open + 3);
    return close < 0 || close > open + 12 ? open + 1 : close + 1;
  }
  const width = src.codePointAt(open + 1)! > 0xffff ? 2 : 1;
  return src[open + 1 + width] === "'" ? open + 2 + width : open + 1;
}

/** Index of the bracket closing the one at `open`, skipping string and char literals. */
function closeOf(text: string, open: number, rust: boolean): number {
  const pair: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const opener = text[open];
  const closer = pair[opener];
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (rust && c === '"') { i = rustStringEnd(text, i); continue; }
    if (rust && c === "'") { i = rustCharEnd(text, i); continue; }
    if (!rust && (c === '"' || c === "'" || c === '`')) {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === opener) depth += 1;
    else if (c === closer && --depth === 0) return i;
    i += 1;
  }
  throw new Error(`unbalanced ${opener} at ${open}`);
}

/**
 * True only for a cfg that can hold in test builds alone: `test` or `all(.., test, ..)`.
 * `any(windows, test)` is production code on Windows and must stay in the census.
 */
const testOnlyCfg = (cfg: string): boolean => cfg.trim() === 'test' || (/^\s*all\(/.test(cfg) && /[(,]\s*test\s*[,)]/.test(cfg));

/** Production Rust text: comments blanked and test-only modules/functions cut out. */
function rustProduction(src: string): string {
  let text = stripRustComments(src);
  const item = /#\[cfg\(([^\]]*)\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(mod|(?:async\s+)?fn)\s+\w+/g;
  let m: RegExpExecArray | null;
  while ((m = item.exec(text))) {
    if (!testOnlyCfg(m[1])) continue;
    const after = m.index + m[0].length;
    const brace = text.indexOf('{', after);
    const semi = text.indexOf(';', after);
    const end = m[2] === 'mod' && semi >= 0 && (brace < 0 || semi < brace) ? semi + 1 : closeOf(text, brace, true) + 1;
    text = text.slice(0, m.index) + text.slice(end);
    item.lastIndex = m.index;
  }
  return text;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

// ---------------------------------------------------------------------------------------------
// The trees, read once.
// ---------------------------------------------------------------------------------------------

const rendererAll = walk(RENDERER, ['.ts', '.tsx'], []).filter(f => !isRendererTest(f.rel));
const renderer = rendererAll.map(f => ({ rel: f.rel, text: stripTsComments(f.text) }));
const rust = walk(RUST_SRC, ['.rs'], []).filter(f => !isRustTestFile(f.rel)).map(f => ({ rel: f.rel, text: rustProduction(f.text) }));

function rendererFile(rel: string): SourceFile {
  const file = renderer.find(f => f.rel === rel);
  if (!file) throw new Error(`missing ${rel}`);
  return file;
}

// --- TS interface/type members ---------------------------------------------------------------

/** Depth-0 text of a body; the contents of nested (), {} and [] are blanked. */
function depthZero(body: string): string {
  let depth = 0;
  let out = '';
  for (const c of body) {
    if (c === '(' || c === '{' || c === '[') { out += depth === 0 ? c : ' '; depth += 1; continue; }
    if (c === ')' || c === '}' || c === ']') { depth -= 1; out += depth === 0 ? c : ' '; continue; }
    out += depth === 0 || c === '\n' ? c : ' ';
  }
  return out;
}

interface Decl { rel: string; body: string; parents: string[] }

/** Every `interface NAME` or `type NAME = A & B` declaration in production renderer source. */
function declarations(name: string): Decl[] {
  const out: Decl[] = [];
  for (const file of renderer) {
    const iface = new RegExp(`\\binterface\\s+${name}\\b([^{]*)\\{`, 'g');
    let m: RegExpExecArray | null;
    while ((m = iface.exec(file.text))) {
      const open = m.index + m[0].length - 1;
      const ext = /\bextends\s+(.+)$/.exec(m[1].trim());
      out.push({
        rel: file.rel,
        body: file.text.slice(open + 1, closeOf(file.text, open, false)),
        parents: ext ? ext[1].split(',').map(p => p.trim().replace(/<.*$/, '')).filter(Boolean) : [],
      });
    }
    const alias = new RegExp(`\\btype\\s+${name}\\s*=\\s*([^;]+);`, 'g');
    while ((m = alias.exec(file.text))) {
      out.push({ rel: file.rel, body: '', parents: m[1].split('&').map(p => p.trim()).filter(Boolean) });
    }
  }
  return out;
}

function membersOfDecl(decl: Decl): Set<string> {
  const names = new Set<string>();
  const body = depthZero(decl.body);
  for (const m of body.matchAll(/(?:^|[;,\n{])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*[(:<]/g)) names.add(m[1]);
  for (const parent of decl.parents) for (const n of membersOf(parent)) names.add(n);
  return names;
}

function membersOf(name: string): Set<string> {
  const decls = declarations(name);
  if (decls.length === 0) throw new Error(`no declaration of ${name}`);
  const names = new Set<string>();
  for (const decl of decls) for (const n of membersOfDecl(decl)) names.add(n);
  return names;
}

/** The type(s) named by `ssh?: <type>` in an ElectronAPI declaration: every part of an
 * intersection (`import('./ssh').A & import('./ssh').B`), joined as `A & B`. */
function nestedSshType(decl: Decl): string {
  const m = /(?:^|[;,\n{])\s*ssh\s*\??\s*:\s*([^;\n]+)/.exec(depthZero(decl.body));
  if (!m) throw new Error(`ElectronAPI in ${decl.rel} has no ssh member`);
  return m[1].split('&').map(part => /([A-Za-z_$][\w$]*)\s*$/.exec(part.trim())![1]).join(' & ');
}

const FLAT_SSH_MEMBER = /^(ssh|onSsh)[A-Z]/;

// --- Object-literal keys and bridge bindings ---------------------------------------------------

function objectKeys(text: string, open: number): Map<string, string> {
  const body = text.slice(open + 1, closeOf(text, open, false));
  const keys = new Map<string, string>();
  for (const m of depthZero(body).matchAll(/(?:^|[,\n{])\s*([A-Za-z_$][\w$]*)\s*:\s*([^,\n]*)/g)) keys.set(m[1], m[2].trim());
  return keys;
}

/** `member: (args) => fn<T>('ssh_x' | 'ssh-x:y', ...)` -> member => name. Captures wrappers like invokeSshMetrics. */
function bindingsIn(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*[A-Za-z_$][\w$]*\s*(?:<[^()]*>)?\s*\(\s*(['"`])(ssh[-_][a-z0-9_:-]+)\2/g;
  for (const m of text.matchAll(re)) out.set(m[1], m[3]);
  return out;
}

// ---------------------------------------------------------------------------------------------

describe('sshContractInventory', () => {
  /*
   * Calibration (how this test dies on a planted violation; the final pass plants each one):
   *  - delete `$crate::commands::ssh_fs_stat` from the ssh_handlers! body -> REGISTERED != DECLARED;
   *  - register a name twice (macro plus lib.rs extras) -> the "registered exactly once" count;
   *  - add `#[tauri::command] pub fn ssh_x` without bridge/types -> DECLARED != BINDING commands;
   *  - drop `fsStat` from createSshBridge (or from browserSshBridge) -> tauri/browser key set != types;
   *  - make a browser stub resolve instead of throw -> the rejecting-stub EXCEPTION check;
   *  - remove the only caller of a member (e.g. api.fsStat in useSshTargetStat) -> consumer census;
   *  - delete ssh_fs_stat from declaration, registry, bridge AND types at once -> the derived sets
   *    still agree with each other, but not with BINDING (oracle: omitted known command).
   */
  test('sshContractInventory_matchesDeclarationsRegistrationBridgeAndConsumers', () => {
    // (b) #[tauri::command] declarations, anywhere under src-tauri/src.
    const declared = new Map<string, string>();
    const sshPathCommands: string[] = [];
    const command = /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g;
    for (const file of rust) {
      for (const m of file.text.matchAll(command)) {
        if (m[1].startsWith('ssh_')) {
          expect(declared.has(m[1])).toBe(false); // one declaration per command name
          declared.set(m[1], `${file.rel}:${lineOf(file.text, m.index!)}`);
        }
        if (/(^|\/)ssh/.test(file.rel)) sshPathCommands.push(m[1]);
      }
    }
    expect(declared.size).toBeGreaterThan(0);
    expect(sshPathCommands.length).toBeGreaterThan(0);
    // A command in an SSH module must carry the ssh_ prefix, or it would escape every census below.
    expect(sshPathCommands.filter(n => !n.startsWith('ssh_'))).toEqual([]);

    // (a) handler registration: every generate_handler!/ssh_handlers! body (the shared macro used by
    // lib.rs and by the invoke tests, plus any lib.rs extras), counted with multiplicity.
    const registered = new Map<string, number>();
    let libInvokesMacro = false;
    for (const file of rust) {
      for (const m of file.text.matchAll(/\b(generate_handler|ssh_handlers)!\s*\[/g)) {
        const open = m.index! + m[0].length - 1;
        const body = file.text.slice(open + 1, closeOf(file.text, open, true));
        if (file.rel === 'src-tauri/src/lib.rs' && m[1] === 'ssh_handlers') libInvokesMacro = true;
        for (const item of body.split(',')) {
          const pathItem = item.trim();
          if (!/^[\w$:]+$/.test(pathItem)) continue;
          const last = pathItem.split('::').pop()!;
          if (last.startsWith('ssh_')) registered.set(last, (registered.get(last) ?? 0) + 1);
        }
      }
    }
    expect(registered.size).toBeGreaterThan(0);
    expect(libInvokesMacro).toBe(true);
    expect([...registered].filter(([, count]) => count !== 1)).toEqual([]);
    expect(sorted(registered.keys())).toEqual(sorted(declared.keys()));

    // (c) invoke strings: any call whose first argument is an ssh_* literal, anywhere in the renderer.
    const invoked = new Map<string, string>();
    for (const file of renderer) {
      for (const m of file.text.matchAll(/\(\s*(['"`])(ssh_[a-z0-9_]+)\1/g)) invoked.set(m[2], `${file.rel}:${lineOf(file.text, m.index!)}`);
    }
    expect(invoked.size).toBeGreaterThan(0);
    // Components never invoke directly; only the bridge layer does.
    expect(sorted([...invoked.values()].map(at => at.replace(/:\d+$/, '')).filter(rel => !rel.startsWith('src/renderer/api/')))).toEqual([]);
    expect(sorted(invoked.keys())).toEqual(sorted(registered.keys()));

    // (d) ElectronAPI SSH members from the type contract: flat ssh*/onSsh* members (including those
    // inherited through `extends`) and the members of the `ssh?:` bridge type.
    const electron = declarations('ElectronAPI');
    expect(electron.length).toBeGreaterThan(0);
    const contract = electron.find(d => d.rel === 'src/renderer/types/electron.d.ts');
    expect(contract).toBeDefined();
    const flat = sorted([...membersOfDecl(contract!)].filter(n => FLAT_SSH_MEMBER.test(n)));
    const nestedType = nestedSshType(contract!);
    const nested = sorted(nestedType.split(' & ').flatMap(part => [...membersOf(part)]));
    expect(flat.length).toBeGreaterThan(0);
    expect(nested.length).toBeGreaterThan(0);
    // Every other ElectronAPI declaration (the tauri bridge keeps a local copy) agrees.
    for (const decl of electron) {
      expect(sorted([...membersOfDecl(decl)].filter(n => FLAT_SSH_MEMBER.test(n)))).toEqual(flat);
      expect(nestedSshType(decl)).toBe(nestedType);
    }

    // (e1) tauri bridge implementations.
    const tauri = rendererFile('src/renderer/api/tauri-bridge.ts');
    const tauriFlat = sorted([...tauri.text.matchAll(/(?:^|[,{\n;])\s*(?:async\s+)?((?:ssh|onSsh)[A-Z][\w$]*)\s*[:(=<]/g)].map(m => m[1]));
    expect(tauriFlat).toEqual(flat);
    const factory = /\bssh\s*:\s*([A-Za-z_$][\w$]*)\s*\(/.exec(tauri.text);
    expect(factory).not.toBeNull();
    const factoryFile = renderer.find(f => new RegExp(`\\bfunction\\s+${factory![1]}\\b`).test(f.text));
    expect(factoryFile).toBeDefined();
    const fnAt = new RegExp(`\\bfunction\\s+${factory![1]}\\b[^{]*\\{`).exec(factoryFile!.text)!;
    const returnAt = /\breturn\s*\{/.exec(factoryFile!.text.slice(fnAt.index))!;
    const tauriNested = objectKeys(factoryFile!.text, fnAt.index + returnAt.index + returnAt[0].length - 1);
    expect(sorted(tauriNested.keys())).toEqual(nested);

    // (e2) browser bridge implementations: present for every member, and every one REJECTS.
    // EXCEPTION (documented): browser stubs exist only to reject desktop-only actions; none may fake success.
    // EXCEPTION (066): `onSshLaunchState` is optional and ABSENT in the browser bridge on purpose;
    // its consumer feature-detects it and renders no launch notice. A rejecting stub would turn
    // "no notice" into a failed subscription. Pin both the absence and the feature check.
    const BROWSER_ABSENT = ['onSshLaunchState'];
    const browser = rendererFile('src/renderer/api/browser-bridge.ts');
    const flatHits = [...browser.text.matchAll(/(?:^|[,{\n;])\s*(?:async\s+)?((?:ssh|onSsh)[A-Z][\w$]*)\s*[:(=<]/g)];
    expect(BROWSER_ABSENT.every(name => flat.includes(name))).toBe(true);
    expect(sorted(flatHits.map(m => m[1]))).toEqual(flat.filter(name => !BROWSER_ABSENT.includes(name)));
    const notice = rendererFile('src/renderer/components/Ssh/OwnedSshLaunchNotice.tsx');
    for (const name of BROWSER_ABSENT) expect(notice.text).toContain(`if (!window.electronAPI?.${name}) return null;`);
    // Each flat stub is ONE line and must throw on its own line: a window reaching the next member
    // (or a fixed span) would let a neighbour's `throw` vouch for a stub that resolves (review 347 F5).
    for (const m of flatHits) {
      // From the member's own name: the match prefix may span blank lines before it.
      const start = m.index! + m[0].lastIndexOf(m[1]);
      const lineEnd = browser.text.indexOf('\n', start);
      const line = browser.text.slice(start, lineEnd < 0 ? undefined : lineEnd);
      if (['onSshMetricsSample', 'onSshMetricsControl'].includes(m[1])) {
        expect(line.trim()).toMatch(/= async \(\) => \(\) => \{\};$/);
        continue;
      }
      expect(`${m[1]}: ${/\bthrow\b/.test(line) ? 'rejects' : 'DOES NOT REJECT (one-line stub)'}`).toBe(`${m[1]}: rejects`);
    }
    const browserRef = /\bssh\s*=\s*([A-Za-z_$][\w$]*)/.exec(browser.text);
    expect(browserRef).not.toBeNull();
    const stubFile = renderer.find(f => new RegExp(`\\b(?:const|let)\\s+${browserRef![1]}\\b[^=]*=\\s*\\{`).test(f.text))!;
    expect(stubFile).toBeDefined();
    const stubAt = new RegExp(`\\b(?:const|let)\\s+${browserRef![1]}\\b[^=]*=\\s*\\{`).exec(stubFile.text)!;
    const browserNested = objectKeys(stubFile.text, stubAt.index + stubAt[0].length - 1);
    expect(sorted(browserNested.keys())).toEqual(nested);
    for (const [member, value] of browserNested) {
      const def = new RegExp(`\\bconst\\s+${value}\\b[^;]*?\\bthrow\\b`).exec(stubFile.text);
      expect(`${member}: ${def ? 'rejects' : `DOES NOT REJECT (${value})`}`).toBe(`${member}: rejects`);
    }

    // Binding: member -> command/event, derived from the tauri implementations, equals the ledger pin,
    // and covers every flat and nested member exactly once.
    const derived = new Map<string, string>([...bindingsIn(tauri.text), ...bindingsIn(factoryFile!.text)]);
    expect(derived.size).toBeGreaterThan(0);
    expect(Object.fromEntries(sorted(derived.keys()).map(k => [k, derived.get(k)]))).toEqual(
      Object.fromEntries(sorted(Object.keys(BINDING)).map(k => [k, BINDING[k]])),
    );
    expect(sorted([...flat, ...nested])).toEqual(sorted(Object.keys(BINDING)));
    expect(sorted(Object.values(BINDING).filter(n => n.startsWith('ssh_')))).toEqual(sorted(declared.keys()));

    // Consumers: a production renderer file outside the bridge/type layer that CALLS the member
    // (`.name(`) and references the SSH bridge (window.electronAPI or a type that carries it).
    // This is syntax, not dataflow: generic names (get, move) are proven by their behavioural tests.
    const carriesBridge = /\b(electronAPI|SshAPI|SshMetricsAPI|SshStoreApi|SshFileApi|SshBridgeApi|SshRowScope)\b/;
    const consumerFiles = renderer.filter(f =>
      !f.rel.startsWith('src/renderer/api/') && !f.rel.startsWith('src/renderer/types/') && carriesBridge.test(f.text)
      && !new RegExp(`\\binterface\\s+${nestedType}\\b`).test(f.text) && !/\binterface\s+Ssh(?:File|Store)Api\b/.test(f.text));
    expect(consumerFiles.length).toBeGreaterThan(0);
    // A call, including `api.member!(…)` and `api.member?.(…)` on an optional member.
    const callOf = (member: string, receiver = '') =>
      new RegExp(`${receiver}\\.\\s*${member}\\s*!?\\s*(?:\\?\\.)?\\s*\\(`);
    // A GENERIC name (`get`, `move`, `reload`, or any member also called in a file that never
    // touches the bridge) would be "consumed" by `map.get(` or `location.reload(`. Those must be
    // called on an SSH bridge receiver (review 347 F5): `api.get(`, `ssh.move(`, `electronAPI.ssh.get(`.
    const bridgeReceiver = String.raw`\b(?:api|ssh|sshApi|electronAPI\s*\??\.\s*ssh)\s*!?\s*\??`;
    const generic = new Set([...flat, ...nested].filter(member => ['get', 'move', 'reload'].includes(member)
      || renderer.some(f => !carriesBridge.test(f.text) && callOf(member).test(f.text))));
    expect([...generic]).toEqual(expect.arrayContaining(['get', 'move', 'reload']));
    const unconsumed = [...flat, ...nested].filter(member =>
      !consumerFiles.some(f => callOf(member, generic.has(member) ? bridgeReceiver : '').test(f.text)));
    expect(sorted(unconsumed)).toEqual(sorted(CONSUMER_EXCEPTIONS));
  });

  /*
   * Calibration:
   *  - add `--ssh-red:#f00` to SshConnections.css (undocumented token) -> SSH-defined set != pin;
   *  - add a pin entry that no SSH file defines (invented ledger symbol) -> same comparison, other side;
   *  - delete the only `var(--ssh-sky)` reader -> "every SSH definition has a reader";
   *  - read `var(--ssh-new)` from SshPaneShell.css with no definition -> read pin and "has a writer";
   *  - drop the inline fallback from `var(--error-color, #c63c3c)` -> theme-fallback rule;
   *  - remove the `--node-surface-shift` writer in CanvasNode.tsx -> Canvas audited writer/reader;
   *  - emit a new `"ssh-x:y"` from Rust, or delete the renderer listen for one -> event equality;
   *  - leave an `'ssh-x:y'` literal outside a listen*( call -> "every renderer event literal is a listen".
   */
  test('sshContractInventory_fieldsAndCssHaveAuditedOwners', () => {
    // --- events -------------------------------------------------------------------------------
    const emitted = new Map<string, string>();
    for (const file of rust) {
      for (const m of file.text.matchAll(/"(ssh-[a-z-]+:[a-z-]+)"/g)) {
        // Dynamic wrappers (EventSink::emit, StoreEmitter::changed, const CHANGED) are resolved by
        // taking the literal itself; the file must still be one that emits.
        expect(`${file.rel}: ${/\bemit(?:_to)?\s*\(/.test(file.text) ? 'emits' : 'no emit call'}`).toBe(`${file.rel}: emits`);
        emitted.set(m[1], `${file.rel}:${lineOf(file.text, m.index!)}`);
      }
    }
    const literals = new Set<string>();
    const listened = new Set<string>();
    for (const file of renderer) {
      for (const m of file.text.matchAll(/(['"`])(ssh-[a-z-]+:[a-z-]+)\1/g)) literals.add(m[2]);
      for (const m of file.text.matchAll(/\blisten\w*\s*(?:<[^()]*>)?\s*\(\s*(['"`])(ssh-[a-z-]+:[a-z-]+)\1/g)) listened.add(m[2]);
    }
    expect(emitted.size).toBeGreaterThan(0);
    expect(listened.size).toBeGreaterThan(0);
    expect(sorted(literals)).toEqual(sorted(listened));
    expect(sorted(emitted.keys())).toEqual(sorted(listened));
    expect(sorted(emitted.keys())).toEqual(sorted(LANDED_EVENTS));

    // --- CSS custom properties -------------------------------------------------------------------
    const defined = new Map<string, string[]>();
    const reads = new Map<string, Array<{ rel: string; fallback: boolean }>>();
    const add = <T>(map: Map<string, T[]>, key: string, value: T) => { map.set(key, [...(map.get(key) ?? []), value]); };
    const css = walk(RENDERER, ['.css'], []).filter(f => !isRendererTest(f.rel))
      .map(f => ({ rel: f.rel, text: f.text.replace(/\/\*[\s\S]*?\*\//g, ' '), isCss: true }));
    const scripts = renderer.map(f => ({ ...f, isCss: false }));
    for (const file of [...css, ...scripts]) {
      if (file.isCss) {
        for (const m of file.text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) add(defined, m[1], file.rel);
      } else {
        for (const m of file.text.matchAll(/(['"`])(--[A-Za-z0-9_-]+)\1\s*(?:as\s+[\w.]+\s*)?\]?\s*:/g)) add(defined, m[2], file.rel);
        for (const m of file.text.matchAll(/setProperty\(\s*(['"`])(--[A-Za-z0-9_-]+)\1/g)) add(defined, m[2], file.rel);
      }
      for (const m of file.text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/g)) add(reads, m[1], { rel: file.rel, fallback: m[2] === ',' });
    }
    expect(css.length).toBeGreaterThan(0);
    expect(defined.size).toBeGreaterThan(0);
    expect(reads.size).toBeGreaterThan(0);

    const sshDefined = sorted([...defined].filter(([, files]) => files.some(isSshOwned)).map(([p]) => p));
    const sshRead = sorted([...reads].filter(([, at]) => at.some(r => isSshOwned(r.rel))).map(([p]) => p));
    expect(sshDefined.length).toBeGreaterThan(0);
    expect(sshRead.length).toBeGreaterThan(0);
    expect(sshDefined).toEqual(sorted(LEDGER_SSH_CSS_DEFINED));
    expect(sshRead).toEqual(sorted(LEDGER_SSH_CSS_READ));

    // Every SSH definition has a reader; every SSH read has a writer, or is an audited theme fallback.
    expect(sshDefined.filter(p => !(reads.get(p)?.length))).toEqual([]);
    expect(sshRead.filter(p => !THEME_FALLBACKS.includes(p) && !(defined.get(p)?.length))).toEqual([]);
    for (const p of THEME_FALLBACKS) {
      expect(sshRead).toContain(p);
      expect((reads.get(p) ?? []).filter(r => isSshOwned(r.rel) && !r.fallback)).toEqual([]);
    }

    // Existing Canvas variables the SSH envelope relies on keep both a writer and a reader.
    for (const p of CANVAS_AUDITED) {
      expect(`${p}: writers=${(defined.get(p) ?? []).length > 0} readers=${(reads.get(p) ?? []).length > 0}`)
        .toBe(`${p}: writers=true readers=true`);
    }
  });
});
