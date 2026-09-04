/**
 * @jest-environment jsdom
 *
 * plan/029 — Command History + Snippets in the terminal right-click menu (T6).
 *
 * `TerminalDisplay` cannot be mounted under the root Jest config (two
 * untransformed CSS imports, `@tauri-apps/api/event`, the store, and a real
 * `Terminal.open()` needing a 2D context jsdom lacks — see
 * terminalMuteMenu.test.ts / terminalDisplayRelocationWiring.test.ts for the
 * established precedent). Plan/029 §6 anticipates exactly this: "if mounting
 * TerminalDisplay whole is impractical, test getContextMenuItems' output shape
 * via extracted pure helper." That helper is `snippetsHistoryMenu.ts`
 * (`buildSnippetsMenuItem` / `buildCommandHistoryMenuItem`) — no React, no
 * Redux, no terminal engine — which this file exercises two ways:
 *
 *  1. Directly, calling the builders and their returned `rows`/`emptyRow`
 *     functions like the flyout would.
 *  2. Through a REAL mounted `ContextMenu`, so click/keyboard behaviour (row
 *     selection closing the menu, folder grouping, etc.) is proven against the
 *     actual flyout component, not just the data shape.
 *
 * `TerminalDisplay`'s own wiring (placement, and that the snippet list is a
 * live store read rather than a hard-coded literal — link 9) is pinned with
 * source-derived assertions, the same technique terminalMuteMenu.test.ts uses
 * for the same reason.
 */
import * as path from 'path';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { readSource } from '../../../utils/readSource';

jest.mock('../ContextMenu.css', () => ({}));

// eslint-disable-next-line import/first
import { ContextMenu, ContextMenuItem } from '../ContextMenu';
// eslint-disable-next-line import/first
import { buildCommandHistoryMenuItem, buildSnippetsMenuItem } from '../snippetsHistoryMenu';
// eslint-disable-next-line import/first
import { commandHistoryService } from '../../../services/commandHistoryService';
// eslint-disable-next-line import/first
import type { Snippet } from '../../../store/slices/settingsSlice';

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Block and line comments out, so a source-derived assertion reads CODE only. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/* ── fixtures ─────────────────────────────────────────────────────────────── */

function makeSnippet(overrides: Partial<Snippet> & { id: string; text: string }): Snippet {
  return { createdAt: 1000, ...overrides };
}

const gitStatus = makeSnippet({ id: 's1', label: 'git status', text: 'git status', folder: 'Git', createdAt: 1 });
const gitLog = makeSnippet({ id: 's2', text: 'git log --oneline -n 20', folder: 'Git', tags: ['git', 'log'], createdAt: 2 });
const dockerUp = makeSnippet({ id: 's3', label: 'docker up', text: 'docker compose up -d', folder: 'Docker', createdAt: 3 });
const multiline = makeSnippet({ id: 's4', text: 'echo one\necho two\necho three', createdAt: 4 }); // unfiled, multi-line

const ALL_SNIPPETS = [gitStatus, gitLog, dockerUp, multiline];

/**
 * `buildSnippetsMenuItem` with the boring arguments filled in.
 *
 * Every required prop is defaulted here rather than at ~10 call sites, so adding one to
 * the builder is a compile error in ONE place instead of a mechanical edit that is easy
 * to do wrongly in nine of them. `viewMode` defaults to 'folders' because most of the
 * cases below are about folder grouping; the flat cases pass it explicitly.
 */
const snippetsItem = (over: Partial<Parameters<typeof buildSnippetsMenuItem>[0]> = {}) =>
  buildSnippetsMenuItem({
    snippets: ALL_SNIPPETS,
    viewMode: 'folders',
    insert: jest.fn(),
    onAddNew: jest.fn(),
    onToggleViewMode: jest.fn(),
    ...over,
  });

/* ── part 1: pure builder tests (no mounting) ────────────────────────────── */

describe('buildSnippetsMenuItem — pure row shape', () => {
  it('groups by folder + unfiled when the query is empty', () => {
    const insert = jest.fn();
    const item = snippetsItem({ insert });
    const rows = (item.submenu!.rows as (q: string) => ContextMenuItem[])('');
    // Two folder rows (Docker, Git — alphabetical, per snippetFolders) + one unfiled leaf.
    const folderLabels = rows.filter((r: any) => r.children).map((r: any) => r.label);
    expect(folderLabels).toEqual(['Docker', 'Git']);
    const gitFolder = rows.find((r: any) => r.label === 'Git') as any;
    expect(gitFolder.children.map((c: any) => c.id)).toEqual(['snippet-s1', 'snippet-s2']);
    const unfiled = rows.filter((r: any) => !r.children);
    expect(unfiled.map((r: any) => r.id)).toEqual(['snippet-s4']);
  });

  it('flattens across folders the instant the query is non-empty (§4.3)', () => {
    const insert = jest.fn();
    const item = snippetsItem({ insert });
    const rowsFn = item.submenu!.rows as (q: string) => any[];
    const rows = rowsFn('git');
    expect(rows.some((r) => r.children)).toBe(false); // no folder rows at all
    expect(rows.map((r) => r.id).sort()).toEqual(['snippet-s1', 'snippet-s2']);
  });

  it('selecting a row inserts the snippet TEXT VERBATIM, including newlines, and closes the menu', () => {
    const insert = jest.fn();
    const item = snippetsItem({ insert });
    const rows = (item.submenu!.rows as (q: string) => any[])('echo');
    expect(rows).toHaveLength(1);
    rows[0].onSelect();
    expect(insert).toHaveBeenCalledWith('echo one\necho two\necho three');
    expect(rows[0].closeMenuOnSelect).toBe(true);
    expect(rows[0].title).toBe('echo one\necho two\necho three'); // full text on hover

    // …and a snippet whose LABEL differs from its TEXT. The multi-line fixture above
    // has no label, so `insert(s.label ?? s.text)` is indistinguishable from
    // `insert(s.text)` there — it inserts what the row displays instead of what the
    // user saved (verified: that mutant survived until these three lines existed).
    const labelled = (item.submenu!.rows as (q: string) => any[])('docker');
    expect(labelled.map((r) => r.label)).toEqual(['docker up']);
    labelled[0].onSelect();
    expect(insert).toHaveBeenLastCalledWith('docker compose up -d');
  });

  it('empty states: no snippets at all vs. a query with no matches, Add New Snippet always enabled', () => {
    const onAddNew = jest.fn();
    const empty = snippetsItem({ snippets: [], onAddNew });
    const noneAtAll = (empty.submenu!.emptyRow as (q: string) => any)('');
    expect(noneAtAll).toMatchObject({ label: 'No snippets yet', disabled: true });

    const withSome = snippetsItem({ onAddNew });
    const noMatches = (withSome.submenu!.emptyRow as (q: string) => any)('zzz-nope');
    expect(noMatches).toMatchObject({ label: "No snippets match 'zzz-nope'", disabled: true });

    const footer = empty.submenu!.footerRows![0];
    expect(footer.disabled).toBeFalsy();
    footer.onSelect!();
    expect(onAddNew).toHaveBeenCalled();
    expect(footer.closeMenuOnSelect).toBe(true);
  });
});

describe('buildSnippetsMenuItem — flat view (the default arrangement)', () => {
  it('lists EVERY snippet as one row, in registry order, with no folder rows at all', () => {
    const rows = (snippetsItem({ viewMode: 'flat' }).submenu!.rows as (q: string) => any[])('');
    expect(rows.map((r) => r.id)).toEqual([
      'snippet-s1', 'snippet-s2', 'snippet-s3', 'snippet-s4',
    ]);
    expect(rows.some((r) => r.children)).toBe(false);
  });

  it('keeps each row\'s folder visible as a chip — the grouping becomes data, not structure', () => {
    const rows = (snippetsItem({ viewMode: 'flat' }).submenu!.rows as (q: string) => any[])('');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // The folder view can drop this, because the row SITS in its folder's panel. Flat has
    // nowhere else to put it, so losing it here loses the information entirely.
    expect(byId['snippet-s1'].detail).toContain('Git');
    expect(byId['snippet-s3'].detail).toContain('Docker');
    expect(byId['snippet-s2'].detail).toContain('#git');
    expect(byId['snippet-s4'].detail).toBeUndefined(); // unfiled, untagged
  });

  it('searches identically in both modes — a query flattens either way', () => {
    const ids = (mode: 'flat' | 'folders') =>
      (snippetsItem({ viewMode: mode }).submenu!.rows as (q: string) => any[])('git')
        .map((r) => r.id).sort();
    expect(ids('flat')).toEqual(ids('folders'));
    expect(ids('flat')).toEqual(['snippet-s1', 'snippet-s2']);
  });

  it('the header toggle reports the mode it is IN and hands the switch back to the caller', () => {
    const onToggleViewMode = jest.fn();
    const flat = snippetsItem({ viewMode: 'flat', onToggleViewMode }).submenu!.headerToggle!;
    const folders = snippetsItem({ viewMode: 'folders', onToggleViewMode }).submenu!.headerToggle!;

    expect(flat.pressed).toBe(true);
    expect(folders.pressed).toBe(false);
    // Distinguishable at a glance, and each title says what PRESSING it will do.
    expect(flat.icon).not.toBe(folders.icon);
    expect(flat.title).toMatch(/group .*by folder/i);
    expect(folders.title).toMatch(/flat list/i);

    // The builder never owns the setting — it cannot, it has no store.
    flat.onToggle();
    expect(onToggleViewMode).toHaveBeenCalledTimes(1);
  });

  it('gives a row a SECOND tooltip that expands the truncated folder/tag chip', () => {
    const rows = (snippetsItem({ viewMode: 'flat' }).submenu!.rows as (q: string) => any[])('');
    const tagged = rows.find((r) => r.id === 'snippet-s2')!;
    // The row-wide `title` stays the snippet's own text: the chip needs its own, or the
    // one place the text is truncated is the one place with no way to read it.
    expect(tagged.title).toBe('git log --oneline -n 20');
    expect(tagged.detailTitle).toBe('Folder: Git' + '\n' + 'Tags: git, log');
    // Nothing to expand, nothing claimed.
    expect(rows.find((r) => r.id === 'snippet-s4')!.detailTitle).toBeUndefined();
  });
});

describe('buildCommandHistoryMenuItem — pure row shape', () => {
  beforeEach(() => commandHistoryService.__reset());

  it('browses recent() on an empty query and match() once typed', () => {
    commandHistoryService.record('git status', '/repo');
    commandHistoryService.record('git push', '/repo');
    commandHistoryService.record('docker ps', '/repo');

    const insert = jest.fn();
    const item = buildCommandHistoryMenuItem({ cwd: '/repo', insert });
    const rowsFn = item.submenu!.rows as (q: string) => any[];

    const browse = rowsFn('');
    expect(browse.map((r) => r.label)).toEqual(['docker ps', 'git push', 'git status']);

    const searched = rowsFn('git');
    expect(searched.map((r) => r.label)).toEqual(['git push', 'git status']);
  });

  /**
   * **Decision D12: history insertion must not go through `engine.insertCommand()`,
   * which deletes the whole typed input line before inserting.**
   *
   * The previous version of this test built `const engine = { insertCommand: jest.fn() }`
   * and asserted `not.toHaveBeenCalled()` — but `buildCommandHistoryMenuItem` takes
   * `{ cwd, insert }` and never saw that object, so the assertion passed for every
   * possible implementation, an `engine.insertCommand()` call included. Two oracles
   * that can actually fail replace it.
   */
  it('inserts through the injected callback ONLY — never engine.insertCommand (D12)', () => {
    commandHistoryService.record('git status', '/repo');
    commandHistoryService.record('git push', '/repo');

    const insert = jest.fn();
    const item = buildCommandHistoryMenuItem({ cwd: '/repo', insert });
    const searched = (item.submenu!.rows as (q: string) => any[])('git');
    expect(searched.map((r) => r.label)).toEqual(['git push', 'git status']);

    // The SECOND row deliberately: activating the first would let an implementation
    // that always inserts `commands[0]` pass (verified — that mutant survived until
    // this line moved off index 0).
    searched[1].onSelect();

    // Oracle 1 — the callback that actually ran is the INJECTED one, exactly once,
    // with the command belonging to the row that was activated. Kills an
    // implementation that reaches for a terminal engine instead of `insert`
    // (`insert` would never fire), one that inserts twice, and one that inserts a
    // different row's text.
    expect(insert.mock.calls).toEqual([['git status']]);
    expect(searched[1].closeMenuOnSelect).toBe(true);

    // Oracle 2 — source-derived, because an implementation that calls BOTH
    // (`insert(cmd); engine.insertCommand(cmd);`) satisfies oracle 1 and still
    // wipes the user's typed line. `insertCommand` must appear nowhere in the
    // history/snippets menu CODE. Comments are stripped first: the module's own
    // doc comment names the forbidden API in order to forbid it, and matching that
    // would make this assertion fail on a correct implementation.
    const MENU_SRC = stripComments(readSource(path.join(__dirname, '..', 'snippetsHistoryMenu.ts')));
    expect(MENU_SRC).toMatch(/insert\(/); // the load generator ran: this IS the right file
    expect(MENU_SRC).not.toMatch(/\binsertCommand\b/);
  });

  it('empty state when there is no history yet', () => {
    const item = buildCommandHistoryMenuItem({ cwd: '/repo', insert: jest.fn() });
    expect((item.submenu!.rows as (q: string) => any[])('')).toEqual([]);
    expect(item.submenu!.emptyRow).toMatchObject({ label: 'No command history yet', disabled: true });
  });

  it('fires ensureDirLoaded(cwd) on open', () => {
    const spy = jest.spyOn(commandHistoryService, 'ensureDirLoaded').mockResolvedValue();
    const item = buildCommandHistoryMenuItem({ cwd: '/repo', insert: jest.fn() });
    item.submenu!.onOpen!();
    expect(spy).toHaveBeenCalledWith('/repo');
    spy.mockRestore();
  });
});

/* ── part 2: mounted through the real ContextMenu/flyout ────────────────── */

describe('mounted through ContextMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    commandHistoryService.__reset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  async function render(items: ContextMenuItem[], onClose = jest.fn()) {
    await act(async () => {
      root.render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);
    });
    return onClose;
  }

  const menuItems = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-item'));
  const menuItemLabels = () => menuItems().map((b) => b.querySelector('.context-menu-label')?.textContent);
  const openFlyout = async (label: string) => {
    const btn = menuItems().find((b) => b.textContent?.includes(label))!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  const flyoutRows = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '.context-menu-flyout[data-flyout-depth="0"] .context-menu-flyout-row',
      ),
    );

  it('Command History sits above Snippets (relative order, not mere presence)', async () => {
    const historyItem = buildCommandHistoryMenuItem({ cwd: '/repo', insert: jest.fn() });
    await render([
      { type: 'separator' },
      historyItem,
      snippetsItem(),
      { type: 'separator' },
      { label: 'Clear', click: jest.fn() },
    ]);
    const labels = menuItemLabels();
    const historyIdx = labels.indexOf('Command History');
    const snippetsIdx = labels.indexOf('Snippets');
    const clearIdx = labels.indexOf('Clear');
    expect(historyIdx).toBeGreaterThan(-1);
    expect(snippetsIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(-1);
    expect(historyIdx).toBeLessThan(snippetsIdx);
    expect(snippetsIdx).toBeLessThan(clearIdx);
  });

  it('selecting a snippet row inserts THIS pane\'s terminalId + exact text and closes the whole menu', async () => {
    const insert = jest.fn();
    const onClose = jest.fn();
    const terminalId = 'term-42';
    await render([snippetsItem({
      snippets: [multiline],
      insert: (text) => insert(terminalId, text),
    })], onClose);
    await openFlyout('Snippets');
    const row = flyoutRows().find((r) => r.textContent?.includes('echo one'))!;
    expect(row).toBeTruthy();
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(insert).toHaveBeenCalledWith('term-42', 'echo one\necho two\necho three');
    expect(onClose).toHaveBeenCalled(); // closeMenuOnSelect
  });

  it('selecting a history row inserts THIS pane\'s terminalId + the command and closes the whole menu', async () => {
    commandHistoryService.record('npm run build', '/repo');
    const insert = jest.fn();
    const onClose = jest.fn();
    const terminalId = 'term-42';
    const historyItem = buildCommandHistoryMenuItem({
      cwd: '/repo',
      insert: (cmd) => insert(terminalId, cmd),
    });
    await render([historyItem], onClose);
    await openFlyout('Command History');
    const row = flyoutRows().find((r) => r.textContent?.includes('npm run build'))!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(insert).toHaveBeenCalledWith('term-42', 'npm run build');
    expect(onClose).toHaveBeenCalled();
  });

  it('renders the toggle in the header beside the search box, and typing still works after pressing it', async () => {
    const onToggleViewMode = jest.fn();
    await render([snippetsItem({ viewMode: 'flat', onToggleViewMode })]);
    await openFlyout('Snippets');

    const header = document.querySelector('.context-menu-flyout-header')!;
    const searchBox = header.querySelector('.context-menu-flyout-search')!;
    const toggle = header.querySelector<HTMLButtonElement>('.context-menu-flyout-toggle')!;
    expect(searchBox).toBeTruthy();
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    // mousedown is where a button steals focus; the row handlers prevent it for the same
    // reason, and a toggle that blurred the box would kill the keyboard mid-search.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => { toggle.dispatchEvent(down); });
    expect(down.defaultPrevented).toBe(true);

    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onToggleViewMode).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(searchBox);
  });

  it('does not repeat the toggle inside a FOLDER panel', async () => {
    await render([snippetsItem({ viewMode: 'folders' })]);
    await openFlyout('Snippets');
    const folderRow = flyoutRows().find((r) => r.textContent?.includes('Git'))!;
    await act(async () => { folderRow.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const nested = document.querySelector('.context-menu-flyout[data-flyout-depth="1"]')!;
    expect(nested).toBeTruthy();
    // Pressing it there would switch to flat, which deletes the panel it was pressed in.
    expect(nested.querySelector('.context-menu-flyout-toggle')).toBeNull();
    expect(document.querySelectorAll('.context-menu-flyout-toggle')).toHaveLength(1);
  });

  it('puts the folder/tag tooltip on the CHIP itself, so a row really does offer two', async () => {
    // The builder test above pins the row OBJECT. This pins the rendering: dropping
    // `title` from the detail span leaves that test green and the feature gone, because
    // the truncated chip is the one place with no other way to read its own text.
    await render([snippetsItem({ viewMode: 'flat', snippets: [gitLog] })]);
    await openFlyout('Snippets');
    const row = flyoutRows().find((r) => r.textContent?.includes('git log'))!;
    const detail = row.querySelector('.context-menu-flyout-detail')!;
    expect(row.getAttribute('title')).toBe('git log --oneline -n 20');
    expect(detail.getAttribute('title')).toBe('Folder: Git\nTags: git, log');
    // Two DIFFERENT tooltips - the point of the pair.
    expect(detail.getAttribute('title')).not.toBe(row.getAttribute('title'));
  });

  it('narrows the ROOT panel in folder mode and leaves the folder panel wide', async () => {
    await render([snippetsItem({ viewMode: 'folders' })]);
    await openFlyout('Snippets');
    const rootPanel = document.querySelector('.context-menu-flyout[data-flyout-depth="0"]')!;
    expect(rootPanel.classList.contains('is-narrow')).toBe(true);

    const folderRow = flyoutRows().find((r) => r.textContent?.includes('Git'))!;
    await act(async () => { folderRow.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // The panel the folder opens holds SNIPPETS, so it must not inherit a width picked
    // for folder names — that inheritance is what the spread would have done for free.
    const nested = document.querySelector('.context-menu-flyout[data-flyout-depth="1"]')!;
    expect(nested.classList.contains('is-narrow')).toBe(false);
  });

  it('keeps the root panel full width in flat mode, where the rows are snippets', async () => {
    await render([snippetsItem({ viewMode: 'flat' })]);
    await openFlyout('Snippets');
    const rootPanel = document.querySelector('.context-menu-flyout[data-flyout-depth="0"]')!;
    expect(rootPanel.classList.contains('is-narrow')).toBe(false);
  });

  it('the narrow class is actually narrower — jsdom computes no layout, so read the CSS', () => {
    // Without this the two tests above pass against a class that styles nothing.
    const css = readSource(path.join(__dirname, '..', 'ContextMenu.css'));
    const widths = (selector: string) => {
      const start = css.indexOf(selector + ' {');
      expect(start).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf('}', start));
      return {
        min: Number(/min-width:\s*(\d+)px/.exec(block)![1]),
        max: Number(/max-width:\s*(\d+)px/.exec(block)![1]),
      };
    };
    const base = widths('.context-menu-flyout');
    const narrow = widths('.context-menu-flyout.is-narrow');
    expect(narrow.min).toBeLessThan(base.min);
    expect(narrow.max).toBeLessThan(base.max);
  });

  it('empty states render and Add New Snippet stays clickable', async () => {
    const onAddNew = jest.fn();
    await render([snippetsItem({ snippets: [], onAddNew })]);
    await openFlyout('Snippets');
    const labels = flyoutRows().map((r) => r.textContent);
    expect(labels.some((l) => l?.includes('No snippets yet'))).toBe(true);
    const addRow = flyoutRows().find((r) => r.textContent?.includes('Add New Snippet'))!;
    expect(addRow.disabled).toBe(false);
    await act(async () => {
      addRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onAddNew).toHaveBeenCalled();
  });
});

/* ── part 3: TerminalDisplay wiring, source-derived ──────────────────────── */

const DISPLAY = readSource(path.join(__dirname, '..', 'TerminalDisplay.tsx'));

describe('TerminalDisplay wiring (source-derived — see file header for why)', () => {
  it('placement: existing separator, then Command History, then Snippets, then a NEW separator, then Clear', () => {
    const historyAt = DISPLAY.indexOf('buildCommandHistoryMenuItem(');
    // The ITEM in the menu array, not the builder call — the builder is now hoisted into
    // its own helper (shared with the keyboard-opened menu) and sits ABOVE this array, so
    // anchoring on `buildSnippetsMenuItem(` would compare a definition to a use and read
    // the order backwards.
    const snippetsAt = DISPLAY.indexOf('snippetsMenuItem(),');
    const clearAt = DISPLAY.indexOf("label: 'Clear',");
    expect(historyAt).toBeGreaterThan(-1);
    expect(snippetsAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(-1);
    expect(historyAt).toBeLessThan(snippetsAt);
    expect(snippetsAt).toBeLessThan(clearAt);

    // Exactly one separator between the two new items and Clear (the NEW one from §6).
    const between = DISPLAY.slice(snippetsAt, clearAt);
    expect((between.match(/type: 'separator'/g) ?? []).length).toBe(1);
  });

  it('targets this pane\'s own terminalId, not resolveKeyboardTerminalId', () => {
    expect(DISPLAY).not.toMatch(/resolveKeyboardTerminalId/);
    expect(DISPLAY).toMatch(/insert:\s*\(command\)\s*=>\s*insertTextIntoTerminal\(terminalId,\s*command\)/);
    expect(DISPLAY).toMatch(/insert:\s*\(text\)\s*=>\s*insertTextIntoTerminal\(terminalId,\s*text\)/);
  });

  it('never calls engine.insertCommand from either flyout (D12)', () => {
    expect(DISPLAY).not.toMatch(/insertCommand/);
  });

  it('does not touch useCommandSuggest / CommandSuggestPopup wiring', () => {
    expect(DISPLAY).toMatch(/useCommandSuggest\(engineRef, \(\) => getCwdSnapshot\(terminalId\)\)/);
    expect(DISPLAY).toMatch(/suggest\.open && \(/);
  });

  /**
   * Link-9 mutation guard (plan/029 §10 "Link 9"): the snippet list handed to
   * the flyout builder MUST come from a live store read, never a hard-coded
   * literal. `tsc` cannot catch this — a literal array of the right shape is a
   * perfectly legal argument — so this has to be a text assertion on the wiring
   * itself.
   *
   * Verified non-vacuous by hand during implementation: temporarily replacing
   * the `useSelector` line with `const snippets: Snippet[] = [];` (a
   * hard-coded literal) turned BOTH assertions below red, then the file was
   * restored. See the task's final report for the confirmation.
   */
  it('reads snippets from a live useSelector, and passes that identifier straight through', () => {
    expect(DISPLAY).toMatch(
      /const snippets = useSelector\(\(s: RootState\) => s\.settings\.snippets\);/,
    );
    // The call site must pass the bare `snippets` identifier — not an inline
    // literal — as the first thing inside the object literal.
    expect(DISPLAY).toMatch(/buildSnippetsMenuItem\(\{\s*\n\s*snippets,/);
  });

  it('reads the view mode from the store too, so the toggle survives closing the menu', () => {
    // The flyout is rebuilt on every open. A view mode held in component state would look
    // identical here and silently reset to the default each time the menu was dismissed.
    expect(DISPLAY).toMatch(
      /const snippetsViewMode = useSelector\(\(s: RootState\) => s\.settings\.snippetsViewMode\);/,
    );
    expect(DISPLAY).toMatch(/viewMode: snippetsViewMode,/);
    expect(DISPLAY).toMatch(/onToggleViewMode: \(\) => dispatch\(/);
    expect(DISPLAY).toMatch(/setSnippetsViewMode\(snippetsViewMode === 'flat' \? 'folders' : 'flat'\)/);
  });

  /**
   * Closing any of these menus leaves DOM focus on `document.body` — the menu button or
   * the flyout's search box held it, and both unmount — so the terminal goes deaf until
   * the user clicks it. That is a property of the MENU, not of the snippet row that
   * exposed it, which is why this asserts EVERY `onClose` rather than the one.
   */
  it('every menu returns the keyboard to the terminal when it closes', () => {
    const code = stripComments(DISPLAY);
    // Sliced to the helper's OWN body rather than matched with a lazy `[\s\S]*?`: this
    // file calls `engineRef.current?.focus()` in several other places, so an unbounded
    // pattern matches one of THOSE and stays green with the focus deleted from here
    // (verified - that mutant survived until this was bounded).
    const afterDecl = code.slice(code.indexOf('const refocusTerminal = useCallback('));
    expect(afterDecl).not.toBe('');
    const refocusBody = afterDecl.slice(0, afterDecl.indexOf('}, ['));
    expect(refocusBody).toContain('engineRef.current?.focus();');

    const onCloses = code.match(/onClose=\{[^}]*\}/g) ?? [];
    expect(onCloses.length).toBeGreaterThanOrEqual(4);
    // No `onClose={() => setX(null)}` survivors: an inline clear is exactly the shape
    // that drops the refocus, and it is the shape all four of these used to have.
    for (const handler of onCloses) {
      expect(handler).toMatch(/^onClose=\{close[A-Za-z]+\}$/);
    }
    // …and each named handler really does refocus.
    for (const name of ['closeContextMenu', 'closeSnippetsMenu', 'closePathPicker', 'closeSchemaPicker']) {
      const re = new RegExp(`const ${name} = useCallback\\(\\(\\) => \\{[^}]*?refocusTerminal\\(\\);`, 's');
      expect(code).toMatch(re);
    }
    // The dialog is the one deliberate exception, and it closes the loop itself.
    expect(code).toMatch(/snippetDialogOpenRef\.current\) return;/);
    expect(code).toMatch(/const closeSnippetDialog = useCallback\(\(\) => \{[\s\S]*?refocusTerminal\(\);/);
  });

  it('publishes the keyboard entry point and renders it with its flyout already open', () => {
    // Link 9 for the shortcut: InputHandler holds no engine, so only the TRIGGER travels
    // through surfaceChrome — and a published callback nothing renders is the classic
    // "event with no dispatcher".
    expect(DISPLAY).toMatch(/openSnippets: openSnippetsMenu,/);
    expect(DISPLAY).toMatch(/const openSnippetsMenu = useCallback\(/);
    expect(DISPLAY).toMatch(/standaloneSubmenu=\{0\}/);
    // Same item as the right-click menu's, not a second copy that can drift from it.
    expect(DISPLAY).toMatch(/items=\{\[snippetsMenuItem\(\)\]\}/);
  });

  it('renders SnippetDialog wired to addSnippet, never dispatching from inside the dialog itself', () => {
    expect(DISPLAY).toMatch(/<SnippetDialog/);
    expect(DISPLAY).toMatch(/onSave=\{\(snippet\) => \{\s*\n\s*dispatch\(addSnippet\(snippet\)\);/);
  });
});
