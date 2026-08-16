import fs from 'fs';
import path from 'path';
import { isVirtualTab, SETTINGS_SHELL_TYPE, CANVAS_SHELL_TYPE } from '../tabKinds';

describe('isVirtualTab', () => {
  it('covers both screen tabs and nothing else', () => {
    expect(isVirtualTab(SETTINGS_SHELL_TYPE)).toBe(true);
    expect(isVirtualTab(CANVAS_SHELL_TYPE)).toBe(true);
    expect(isVirtualTab('bash')).toBe(false);
    expect(isVirtualTab('powershell')).toBe(false);
  });

  // A tab restored from an old config, or one built by an API caller, can arrive without
  // a shellType at all. Answering `true` there would strand it: TerminalContainer would
  // never seed it a pane tree and it would render as a permanently blank tab.
  it('treats an absent shellType as a real terminal, not a screen', () => {
    expect(isVirtualTab(undefined)).toBe(false);
    expect(isVirtualTab(null)).toBe(false);
    expect(isVirtualTab('')).toBe(false);
  });
});

/**
 * The reason this module exists, asserted rather than asked for in a comment.
 *
 * Canvas Mode became a tab by joining a set that already had one member, and every place
 * that knew about Settings was a place that would mistake the canvas tab for a terminal —
 * seeding it a pane tree (which spawns a PTY named "Canvas"), offering to kill its
 * processes on close, drawing it a group frame on the canvas. Four such comparisons
 * existed and all four were `shellType === 'settings'` written out by hand.
 *
 * That class of bug is invisible from the canvas side: nothing in the canvas directory
 * mentions Settings, so no amount of reading the new code finds them. The check has to run
 * against the FILE SET — a new `shellType === '...'` literal anywhere in the renderer is
 * the same mistake being made a fifth time, and it fails here on the day it is written.
 */
describe('nothing compares shellType to a bare string literal', () => {
  const RENDERER = path.resolve(__dirname, '../..');
  const SELF = path.join(RENDERER, 'services/tabKinds.ts');

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') sourceFiles(p, out);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(p);
      }
    }
    return out;
  }

  /** Comparisons only: an OBJECT LITERAL (`shellType: 'bash'`) is a tab being BUILT, not
   *  a kind being decided, and is none of this suite's business. */
  const COMPARISON = /shellType\s*[!=]==\s*['"][a-z]+['"]/g;

  /** Comments are stripped first, and that is not a detail. The docs in `tabKinds.ts`,
   *  `openSettings.ts` and `canvasSlice.ts` all quote `shellType === 'settings'` while
   *  EXPLAINING this rule — scanning raw text makes the explanations themselves the
   *  offenders, and the only way to keep such a test green is to stop writing them down. */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const files = sourceFiles(RENDERER).filter((f) => f !== SELF);

  it('scanned a real file set', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(path.join(RENDERER, 'components/TerminalContainer.tsx'));
    expect(files).toContain(path.join(RENDERER, 'components/Tabs/TabManager.tsx'));
  });

  it('found the pattern it is looking for, so a clean result means something', () => {
    // Mutation check. Without it, a typo in COMPARISON would leave a test that scans the
    // whole renderer, matches nothing, and passes forever — which is exactly the failure
    // shape this suite is built to prevent elsewhere.
    expect("if (tab.shellType === 'settings')".match(COMPARISON)).not.toBeNull();
    expect("t.shellType !== 'canvas'".match(COMPARISON)).not.toBeNull();
    expect("{ shellType: 'bash' }".match(COMPARISON)).toBeNull();
    expect(stripComments("// see shellType === 'settings'\nconst a = 1;")).not.toMatch(COMPARISON);
    expect(stripComments("/* shellType === 'canvas' */\nconst a = 1;")).not.toMatch(COMPARISON);
    // ...and stripping must not swallow real code on the way.
    expect(stripComments("if (t.shellType === 'settings') {} // note")).toMatch(COMPARISON);
  });

  it('has no such comparison left anywhere in the renderer', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of src.matchAll(COMPARISON)) {
        offenders.push(`${path.relative(RENDERER, file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
