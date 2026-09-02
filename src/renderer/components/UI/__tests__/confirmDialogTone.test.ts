/**
 * `ConfirmDialog`'s confirm button must LOOK like what it does.
 *
 * It used to render `confirm-btn confirm` unconditionally, and that class is the
 * solid red. So every confirm button in the app was red whatever it did —
 * `Restore`, `Bring back`, `Activate` and `Update` arrived in the same alarm
 * colour as `Delete` and `Quit`. A signal that is always on is not a signal, and
 * the cost is paid by the genuinely dangerous dialogs, which stop standing out.
 *
 * The `destructive` prop already existed and already meant "this is dangerous"
 * (it defaults focus to Cancel). It now drives the colour too, so there is one
 * answer to the question rather than two that can disagree.
 *
 * Source-derived, like `layoutManagerWiring.test.ts`: these components pull the
 * real store and untransformed CSS through their module graphs and cannot be
 * mounted under the root Jest config.
 */
import * as path from 'path';
import { readSource } from '../../../utils/readSource';

const RENDERER = path.join(__dirname, '..', '..', '..');
const src = (...p: string[]) => readSource(path.join(RENDERER, ...p));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const DIALOG_TSX = strip(src('components', 'UI', 'ConfirmDialog.tsx'));
const DIALOG_CSS = strip(src('components', 'UI', 'ConfirmDialog.css'));

/**
 * The `<ConfirmDialog … />` element containing `anchor`.
 *
 * Ends on a `/>` at the SAME indentation as the opening tag, not on the first
 * `/>` found: several of these dialogs pass JSX in `message`, and a nested
 * `<input … />` closes on its own line too. Terminating on that would silently
 * truncate the block to something that trivially passes.
 */
function dialogAround(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  if (at === -1) throw new Error(`no dialog anchor "${anchor}"`);
  const openAt = source.lastIndexOf('<ConfirmDialog', at);
  if (openAt === -1) throw new Error(`anchor "${anchor}" is not inside a ConfirmDialog`);
  const lineStart = source.lastIndexOf('\n', openAt) + 1;
  const indent = source.slice(lineStart, openAt);
  const lines = source.slice(lineStart).split(/\r?\n/);
  const end = lines.findIndex((l, i) => i > 0 && l === `${indent}/>`);
  if (end === -1) throw new Error(`unterminated ConfirmDialog for "${anchor}"`);
  return lines.slice(0, end + 1).join('\n');
}

const hasDestructive = (block: string) => /^\s*destructive\b/m.test(block);

describe('ConfirmDialog paints the confirm button from `destructive`', () => {
  it('chooses the class rather than hard-coding one', () => {
    expect(DIALOG_TSX).toMatch(/className=\{`confirm-btn \$\{destructive \? 'danger' : 'primary'\}`\}/);
    // The unconditional class is gone from both halves — a leftover rule would
    // still be reachable by anything that pasted the old className.
    expect(DIALOG_TSX).not.toContain('confirm-btn confirm');
    expect(DIALOG_CSS).not.toMatch(/\.confirm-btn\.confirm\b/);
  });

  it('the two tones are actually different colours, and danger is the red one', () => {
    const bg = (selector: string) => {
      const m = DIALOG_CSS.match(
        new RegExp(`(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\{([^}]*)\\}`, 'm'),
      );
      if (!m) throw new Error(`no rule ${selector}`);
      const d = m[1].match(/(?:^|;)\s*background\s*:([^;]*)/m);
      if (!d) throw new Error(`${selector} declares no background`);
      return d[1].trim().toLowerCase();
    };
    const danger = bg('.confirm-btn.danger');
    const primary = bg('.confirm-btn.primary');
    expect(danger).not.toBe(primary);
    // Asserted as a relation plus one anchor: `danger` must be a literal red,
    // and `primary` must NOT be, so swapping the two fails rather than merely
    // rearranging.
    expect(danger).toMatch(/^#e51400$/);
    expect(primary).not.toMatch(/^#e51400$/);
  });

  it('danger is SOLID, unlike the ghost `.destructive` used for a secondary option', () => {
    // `.confirm-btn.destructive` is UnsavedChangesDialog's "Switch anyway":
    // transparent with red text, deliberately lighter than the primary beside
    // it. Using it for a primary destructive confirm would turn Delete into an
    // outline button, which is why the two must not be conflated.
    expect(DIALOG_CSS).toMatch(/\.confirm-btn\.destructive\s*\{[^}]*background:\s*transparent/);
    expect(DIALOG_CSS).toMatch(/\.confirm-btn\.danger\s*\{[^}]*background:\s*#e51400/);
  });
});

/**
 * The census. The colour is only as meaningful as the flag behind it, so this
 * pins which dialogs claim to be dangerous — including the NEGATIVES, without
 * which "everything is destructive" would pass and restore the original defect
 * one layer down.
 */
describe('every ConfirmDialog declares its tone honestly', () => {
  const SOURCES = {
    app: strip(src('App.tsx')),
    layout: strip(src('components', 'LayoutManager.tsx')),
    pane: strip(src('components', 'Panes', 'PaneManager.tsx')),
    peers: strip(src('components', 'Settings', 'PeersPanel.tsx')),
    settings: strip(src('components', 'Settings', 'SettingsPage.tsx')),
    tabs: strip(src('components', 'Tabs', 'TabManager.tsx')),
    title: strip(src('components', 'TitleBar', 'TitleBar.tsx')),
  };

  const DESTRUCTIVE: Array<[keyof typeof SOURCES, string]> = [
    ['app', 'Quit Auto Terminal'],                 // closes the app
    ['settings', 'Offload & Close TermFlow?'],     // ...and so does this one
    ['layout', 'title="Delete Layout"'],
    ['layout', 'title="Reset Layout"'],
    ['pane', 'title="Close Pane"'],
    ['peers', 'title="Revoke peer?"'],
    ['settings', 'title="Rotate access token?"'],
    ['tabs', 'title={titleByKind[pendingClose.kind]}'],
  ];

  const SAFE: Array<[keyof typeof SOURCES, string]> = [
    ['layout', 'title="Update Layout"'],           // overwrites a layout, destroys nothing live
    ['title', "title=\"Receive API/MCP terminals here?\""],
    ['title', 'Bring back 1 running agent?'],      // only ADDS tabs
  ];

  it.each(DESTRUCTIVE)('%s: "%s" is marked destructive', (key, anchor) => {
    expect(hasDestructive(dialogAround(SOURCES[key], anchor))).toBe(true);
  });

  it.each(SAFE)('%s: "%s" is NOT marked destructive', (key, anchor) => {
    expect(hasDestructive(dialogAround(SOURCES[key], anchor))).toBe(false);
  });

  it('the census covers every ConfirmDialog that exists', () => {
    // Without this, a dialog added tomorrow is silently outside the table above
    // and inherits whichever tone its author happened to pick. Counts the
    // ELEMENTS, then requires the table to account for all of them.
    const total = Object.values(SOURCES)
      .reduce((n, s) => n + (s.match(/<ConfirmDialog\b/g) ?? []).length, 0);
    expect(DESTRUCTIVE.length + SAFE.length).toBe(total);
  });
});

describe('restoring hidden CLIs: confirm on the badge, not in the Layout Manager', () => {
  const LAYOUT = strip(src('components', 'LayoutManager.tsx'));
  const TITLE = strip(src('components', 'TitleBar', 'TitleBar.tsx'));

  it('the Layout Manager button restores immediately', () => {
    // Its own label carries the count and its tooltip lists the terminals, so a
    // dialog would only re-read the thing just clicked.
    expect(LAYOUT).toContain('onClick={handleRestoreRunning}');
    expect(LAYOUT).not.toContain('pendingRestore');
  });

  it('the title-bar badge still confirms', () => {
    // The badge is a glanceable icon; its dialog is where the list of stranded
    // terminals is shown for the first time.
    expect(TITLE).toContain('setShowRestoreConfirm(true)');
    expect(TITLE).toContain('isOpen={showRestoreConfirm');
  });
});
