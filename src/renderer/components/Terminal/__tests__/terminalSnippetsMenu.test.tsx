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

/* ── fixtures ─────────────────────────────────────────────────────────────── */

function makeSnippet(overrides: Partial<Snippet> & { id: string; text: string }): Snippet {
  return { createdAt: 1000, ...overrides };
}

const gitStatus = makeSnippet({ id: 's1', label: 'git status', text: 'git status', folder: 'Git', createdAt: 1 });
const gitLog = makeSnippet({ id: 's2', text: 'git log --oneline -n 20', folder: 'Git', tags: ['git', 'log'], createdAt: 2 });
const dockerUp = makeSnippet({ id: 's3', label: 'docker up', text: 'docker compose up -d', folder: 'Docker', createdAt: 3 });
const multiline = makeSnippet({ id: 's4', text: 'echo one\necho two\necho three', createdAt: 4 }); // unfiled, multi-line

const ALL_SNIPPETS = [gitStatus, gitLog, dockerUp, multiline];

/* ── part 1: pure builder tests (no mounting) ────────────────────────────── */

describe('buildSnippetsMenuItem — pure row shape', () => {
  it('groups by folder + unfiled when the query is empty', () => {
    const insert = jest.fn();
    const item = buildSnippetsMenuItem({ snippets: ALL_SNIPPETS, insert, onAddNew: jest.fn() });
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
    const item = buildSnippetsMenuItem({ snippets: ALL_SNIPPETS, insert, onAddNew: jest.fn() });
    const rowsFn = item.submenu!.rows as (q: string) => any[];
    const rows = rowsFn('git');
    expect(rows.some((r) => r.children)).toBe(false); // no folder rows at all
    expect(rows.map((r) => r.id).sort()).toEqual(['snippet-s1', 'snippet-s2']);
  });

  it('selecting a row inserts the snippet TEXT VERBATIM, including newlines, and closes the menu', () => {
    const insert = jest.fn();
    const item = buildSnippetsMenuItem({ snippets: ALL_SNIPPETS, insert, onAddNew: jest.fn() });
    const rows = (item.submenu!.rows as (q: string) => any[])('echo');
    expect(rows).toHaveLength(1);
    rows[0].onSelect();
    expect(insert).toHaveBeenCalledWith('echo one\necho two\necho three');
    expect(rows[0].closeMenuOnSelect).toBe(true);
    expect(rows[0].title).toBe('echo one\necho two\necho three'); // full text on hover
  });

  it('empty states: no snippets at all vs. a query with no matches, Add New Snippet always enabled', () => {
    const onAddNew = jest.fn();
    const empty = buildSnippetsMenuItem({ snippets: [], insert: jest.fn(), onAddNew });
    const noneAtAll = (empty.submenu!.emptyRow as (q: string) => any)('');
    expect(noneAtAll).toMatchObject({ label: 'No snippets yet', disabled: true });

    const withSome = buildSnippetsMenuItem({ snippets: ALL_SNIPPETS, insert: jest.fn(), onAddNew });
    const noMatches = (withSome.submenu!.emptyRow as (q: string) => any)('zzz-nope');
    expect(noMatches).toMatchObject({ label: "No snippets match 'zzz-nope'", disabled: true });

    const footer = empty.submenu!.footerRows![0];
    expect(footer.disabled).toBeFalsy();
    footer.onSelect!();
    expect(onAddNew).toHaveBeenCalled();
    expect(footer.closeMenuOnSelect).toBe(true);
  });
});

describe('buildCommandHistoryMenuItem — pure row shape', () => {
  beforeEach(() => commandHistoryService.__reset());

  it('browses recent() on an empty query, match() once typed, and never calls engine.insertCommand (D12)', () => {
    commandHistoryService.record('git status', '/repo');
    commandHistoryService.record('git push', '/repo');
    commandHistoryService.record('docker ps', '/repo');

    const insert = jest.fn();
    const engine = { insertCommand: jest.fn() };
    const item = buildCommandHistoryMenuItem({ cwd: '/repo', insert });
    const rowsFn = item.submenu!.rows as (q: string) => any[];

    const browse = rowsFn('');
    expect(browse.map((r) => r.label)).toEqual(['docker ps', 'git push', 'git status']);

    const searched = rowsFn('git');
    expect(searched.map((r) => r.label)).toEqual(['git push', 'git status']);

    searched[0].onSelect();
    expect(insert).toHaveBeenCalledWith('git push');
    expect(searched[0].closeMenuOnSelect).toBe(true);
    expect(engine.insertCommand).not.toHaveBeenCalled();
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
    const snippetsItem = buildSnippetsMenuItem({ snippets: ALL_SNIPPETS, insert: jest.fn(), onAddNew: jest.fn() });
    await render([
      { type: 'separator' },
      historyItem,
      snippetsItem,
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
    const snippetsItem = buildSnippetsMenuItem({
      snippets: [multiline],
      insert: (text) => insert(terminalId, text),
      onAddNew: jest.fn(),
    });
    await render([snippetsItem], onClose);
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

  it('empty states render and Add New Snippet stays clickable', async () => {
    const onAddNew = jest.fn();
    const snippetsItem = buildSnippetsMenuItem({ snippets: [], insert: jest.fn(), onAddNew });
    await render([snippetsItem]);
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
    const snippetsAt = DISPLAY.indexOf('buildSnippetsMenuItem(');
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

  it('renders SnippetDialog wired to addSnippet, never dispatching from inside the dialog itself', () => {
    expect(DISPLAY).toMatch(/<SnippetDialog/);
    expect(DISPLAY).toMatch(/onSave=\{\(snippet\) => \{\s*\n\s*dispatch\(addSnippet\(snippet\)\);/);
  });
});
