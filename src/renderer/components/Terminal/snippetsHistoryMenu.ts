// plan/029 §6 — pure builders for the "Command History" and "Snippets" flyout
// items in the terminal right-click menu. No React, no DOM, no Redux: everything
// the caller (TerminalDisplay) doesn't already own (the snippet list, the
// terminal's cwd, the insert callback) is passed in, so this is testable without
// mounting TerminalDisplay, which the repo's own tests document as unmountable
// under the root Jest config (see terminalMuteMenu.test.ts).

import type { ContextMenuFlyoutRow, ContextMenuItem } from './ContextMenu';
import type { Snippet } from '../../store/slices/settingsSlice';
import { filterSnippets, snippetDisplayLabel, snippetFolders } from '../../services/snippetSearch';
import { commandHistoryService } from '../../services/commandHistoryService';

/** One row's worth of secondary text: tags first, folder appended only when the
 *  caller says the folder isn't already implied by where the row sits (a row
 *  inside a folder's own `children` doesn't need to repeat its folder name). */
function leafDetail(s: Snippet, showFolder: boolean): string | undefined {
  const parts: string[] = [];
  if (showFolder && s.folder) parts.push(`📁 ${s.folder}`);
  if (s.tags && s.tags.length > 0) parts.push(s.tags.map((t) => `#${t}`).join(' '));
  return parts.length > 0 ? parts.join('  ') : undefined;
}

/** One snippet as a leaf flyout row. `title` carries the full, untruncated text
 *  (§4.3) so a long or multi-line snippet is inspectable on hover. Insert rows
 *  always close the menu (product decision, §4.5 revision) — the user's next
 *  move is to look at or run what was just inserted. */
function buildSnippetLeafRow(
  s: Snippet,
  insert: (text: string) => void,
  showFolder: boolean,
): ContextMenuFlyoutRow {
  return {
    id: `snippet-${s.id}`,
    label: snippetDisplayLabel(s),
    detail: leafDetail(s, showFolder),
    title: s.text,
    onSelect: () => insert(s.text),
    closeMenuOnSelect: true,
  };
}

/** Folder-grouped shape (empty query): one folder row per `snippetFolders`, its
 *  children the snippets in that folder, then the unfiled snippets flat. */
function buildGroupedRows(snippets: Snippet[], insert: (text: string) => void): ContextMenuFlyoutRow[] {
  const folders = snippetFolders(snippets);
  const rows: ContextMenuFlyoutRow[] = folders.map((folder) => ({
    id: `folder-${folder}`,
    label: folder,
    icon: '📁',
    children: snippets
      .filter((s) => (s.folder?.trim() || undefined) === folder)
      .map((s) => buildSnippetLeafRow(s, insert, false)),
  }));
  const unfiled = snippets.filter((s) => !s.folder?.trim());
  rows.push(...unfiled.map((s) => buildSnippetLeafRow(s, insert, false)));
  return rows;
}

/**
 * Build the "Snippets" context-menu item: search box + folder-grouped rows that
 * flatten the moment the query is non-empty (§4.3), an empty-state row that
 * distinguishes "no snippets at all" from "no matches", and an always-clickable
 * "Add New Snippet" footer (§4.5 — the submenu must never be a dead end).
 *
 * `snippets` MUST come from a live store read (`useSelector(s => s.settings.snippets)`)
 * in the caller — this function only renders whatever list it is handed (plan/029
 * link 9). `insert` and `onAddNew` are provided by the caller so this module never
 * has to know about terminal ids or dialog state.
 */
export function buildSnippetsMenuItem(opts: {
  snippets: Snippet[];
  insert: (text: string) => void;
  onAddNew: () => void;
}): ContextMenuItem {
  const { snippets, insert, onAddNew } = opts;

  return {
    label: 'Snippets',
    icon: '✂️',
    title: 'Insert a saved snippet of text into this terminal. Search by name, text, or #tag.',
    submenu: {
      searchPlaceholder: 'Search snippets…  (#tag to filter by tag)',
      // Function form (not an array) so #tag filtering and the flatten-on-search
      // rule (§4.3) both live in filterSnippets rather than ContextMenu's own
      // label/detail substring filter.
      rows: (query: string): ContextMenuFlyoutRow[] => {
        const q = query.trim();
        if (!q) return buildGroupedRows(snippets, insert);
        return filterSnippets(snippets, q).map((s) => buildSnippetLeafRow(s, insert, true));
      },
      emptyRow: (query: string): ContextMenuFlyoutRow =>
        snippets.length === 0
          ? { id: 'no-snippets', label: 'No snippets yet', disabled: true }
          : { id: 'no-snippet-matches', label: `No snippets match '${query.trim()}'`, disabled: true },
      footerRows: [
        {
          id: 'add-new-snippet',
          label: 'Add New Snippet',
          icon: '➕',
          onSelect: onAddNew,
          closeMenuOnSelect: true,
        },
      ],
    },
  };
}

// Browse-list size (no query typed). Large enough to scan the last several
// commands from any directory without feeling clipped, small enough that the
// flyout doesn't turn into a second scrollback.
const HISTORY_BROWSE_LIMIT = 25;

/**
 * Build the "Command History" context-menu item. Typing switches from
 * `recent()` (browse, §5) to `match()` (search); both are handed straight
 * through from `commandHistoryService` so ranking stays in one place. Insertion
 * goes through the same `insert` callback as Snippets (D12) — never
 * `engine.insertCommand()`, which deletes the whole typed input line first.
 */
export function buildCommandHistoryMenuItem(opts: {
  cwd: string | undefined;
  insert: (command: string) => void;
}): ContextMenuItem {
  const { cwd, insert } = opts;

  return {
    label: 'Command History',
    icon: '🕘',
    title: 'Browse and insert a command from history for this directory. Search or pick a recent one.',
    submenu: {
      searchPlaceholder: 'Search command history…',
      rows: (query: string): ContextMenuFlyoutRow[] => {
        const q = query.trim();
        const commands = q
          ? commandHistoryService.match(q, { cwd, limit: HISTORY_BROWSE_LIMIT })
          : commandHistoryService.recent({ cwd, limit: HISTORY_BROWSE_LIMIT });
        return commands.map((cmd, i) => ({
          id: `history-${i}`,
          label: cmd,
          title: cmd,
          onSelect: () => insert(cmd),
          closeMenuOnSelect: true,
        }));
      },
      emptyRow: { id: 'no-history', label: 'No command history yet', disabled: true },
      // Warms the directory-affinity cache so the first render already benefits
      // from it (§5 — "never worse", so a synchronous first render is correct).
      onOpen: () => {
        void commandHistoryService.ensureDirLoaded(cwd);
      },
    },
  };
}
