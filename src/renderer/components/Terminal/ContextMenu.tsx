import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ContextMenu.css';

/**
 * One row inside a flyout submenu (design 029 §4.3).
 *
 * A row is either a **leaf** (activating it runs `onSelect`) or a **folder**
 * (`children` is non-empty; activating it opens a second-level flyout). One row
 * cannot be both — `children` wins.
 */
export interface ContextMenuFlyoutRow {
  /** Stable identity: the React key, the DOM id used by `aria-activedescendant`,
   *  and how the open folder is remembered across a re-filter. */
  id: string;
  /** Primary text. Truncated with an ellipsis rather than wrapped. */
  label: string;
  icon?: string;
  /** Dimmed secondary text on the right of the row (folder name, timestamp, …). */
  detail?: string;
  /** Native tooltip — the place for the full, untruncated text. */
  title?: string;
  /** Rows of a nested flyout. Present ⇒ this is a folder row. */
  children?: ContextMenuFlyoutRow[];
  /** Run on click / Enter. Ignored for folder rows. */
  onSelect?: () => void;
  /**
   * Close the WHOLE context menu after `onSelect`. Defaults to **false**: per
   * §4.5, "Add New Snippet … is the only one that dismisses rather than staying
   * open", so inserting keeps the flyout up for a second insert.
   */
  closeMenuOnSelect?: boolean;
  /** Inert placeholder (an empty-state message). Rendered, never activated, and
   *  skipped by the arrow keys so it cannot swallow the selection. */
  disabled?: boolean;
}

/** The flyout attached to one `ContextMenuItem`. */
export interface ContextMenuFlyout {
  /** Placeholder for the search box at the top of the flyout. */
  searchPlaceholder?: string;
  /**
   * The rows to show.
   *
   * - **Array** — the flyout applies its own case-insensitive substring filter over
   *   `label` + `detail`, and (per §4.3) flattens folders away the moment the query
   *   is non-empty.
   * - **Function** — the caller owns filtering and ranking (`snippetSearch`,
   *   `commandHistoryService.match`). It is called during render on every keystroke,
   *   so memoize anything expensive.
   */
  rows: ContextMenuFlyoutRow[] | ((query: string) => ContextMenuFlyoutRow[]);
  /** Rendered in place of an empty row list (§4.5). Usually `disabled: true`. The
   *  function form receives the current query, for "No snippets match ‘foo’". */
  emptyRow?: ContextMenuFlyoutRow | ((query: string) => ContextMenuFlyoutRow);
  /** Always rendered at the bottom under a separator and never filtered — the home
   *  of "➕ Add New Snippet", which must stay reachable from every empty state. */
  footerRows?: ContextMenuFlyoutRow[];
  /** Fired each time the flyout opens (e.g. `ensureDirLoaded(cwd)`). */
  onOpen?: () => void;
}

export interface ContextMenuItem {
  label?: string;
  icon?: string;
  accelerator?: string;
  /** Hover tooltip explaining what the item does. */
  title?: string;
  type?: 'normal' | 'separator';
  enabled?: boolean;
  click?: () => void;
  /** Turns the item into a submenu parent: clicking it toggles a flyout instead of
   *  running `click` and closing the menu. `click` is never called for such an item. */
  submenu?: ContextMenuFlyout;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** Keep-on-screen margin, matching the menu's own 5px in the effect below. */
const EDGE_MARGIN = 5;

/**
 * Default filter for the array form of `flyout.rows`.
 *
 * §4.3: "the moment the search box is non-empty, folders disappear and results
 * flatten across every folder" — which is what keeps one folder level (D7) from
 * being a real constraint, so the flatten lives here rather than in each caller.
 */
function filterRows(rows: ContextMenuFlyoutRow[], query: string): ContextMenuFlyoutRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const out: ContextMenuFlyoutRow[] = [];
  const walk = (list: ContextMenuFlyoutRow[]) => {
    for (const r of list) {
      if (r.children && r.children.length > 0) {
        walk(r.children);
        continue;
      }
      if (`${r.label} ${r.detail ?? ''}`.toLowerCase().includes(q)) out.push(r);
    }
  };
  walk(rows);
  return out;
}

const isFolder = (r: ContextMenuFlyoutRow): boolean => !!r.children && r.children.length > 0;

interface FlyoutPanelProps {
  flyout: ContextMenuFlyout;
  /** 0 for the flyout hanging off a menu item, 1+ for a folder inside one. */
  depth: number;
  /** Escape / ArrowLeft / Tab — closes THIS panel and returns focus to its opener. */
  onCloseSelf: () => void;
  /** Dismiss the entire context menu (a row with `closeMenuOnSelect`). */
  onCloseMenu: () => void;
}

/**
 * One flyout panel: a search box plus a keyboard-navigable row list.
 *
 * **It renders where it is mounted — never through a portal.** `ContextMenu`'s
 * outside-click handler closes on any mousedown that `menuRef` does not contain,
 * so a portalled panel would be "outside" the menu and the first press on a row
 * would close everything before the click landed (design 029 §4.2).
 *
 * The panel is `position: absolute` inside a `position: relative` row host, which
 * makes "top: the parent row's offset" automatic. Being absolutely positioned also
 * keeps it out of the menu's flow, so it contributes nothing to the menu's
 * intrinsic width and the edge-aware repositioning in `ContextMenu` is unaffected.
 *
 * DOM focus stays in the search input the whole time; the "active" row is only
 * *styled* (`.is-active`) and announced via `aria-activedescendant`. That is what
 * keeps typing filtering rather than navigating, and it is why P1's "keyboard
 * navigation must not interfere with terminal input" holds by construction — an
 * editable non-terminal element owns the keyboard.
 */
const FlyoutPanel: React.FC<FlyoutPanelProps> = ({ flyout, depth, onCloseSelf, onCloseMenu }) => {
  const uid = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRowRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [flip, setFlip] = useState<{ left: boolean; shiftY: number }>({ left: false, shiftY: 0 });

  const { rows, emptyRow, footerRows, searchPlaceholder } = flyout;

  // The visible list: matches (or the empty-state row) followed by the never-filtered footer.
  const visible = useMemo(() => {
    const matched = typeof rows === 'function' ? rows(query) : filterRows(rows, query);
    const head =
      matched.length > 0
        ? matched
        : emptyRow
          ? [typeof emptyRow === 'function' ? emptyRow(query) : emptyRow]
          : [];
    return { head, footer: footerRows ?? [] };
  }, [rows, query, emptyRow, footerRows]);

  // Arrow keys walk only the rows that can actually be activated.
  const navigable = useMemo(
    () => [...visible.head, ...visible.footer].filter((r) => !r.disabled),
    [visible],
  );
  const safeIdx = navigable.length === 0 ? -1 : Math.min(activeIdx, navigable.length - 1);
  const activeId = safeIdx >= 0 ? navigable[safeIdx].id : null;

  const rowDomId = (row: ContextMenuFlyoutRow) => `${uid}-${row.id}`;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A new query means a new result set; the selection restarts at the top match.
  useEffect(() => {
    setActiveIdx(0);
    // Folders are hidden while filtering, so an open one has no anchor left.
    setOpenFolderId(null);
  }, [query]);

  // Keep the active row in view as the arrows move past the `max-height` (§4.4).
  useEffect(() => {
    activeRowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  // Edge-aware placement: flip to the left of the row when the panel would leave the
  // viewport on the right, and lift it when it would run off the bottom. jsdom (and
  // the first paint) report a zero-sized rect, where the default placement is correct.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const host = panel?.parentElement;
    if (!panel || !host) return;
    const p = panel.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    if (p.width === 0 && p.height === 0) return;
    const overflowsRight = h.right + p.width > window.innerWidth - EDGE_MARGIN;
    const fitsLeft = h.left - p.width > EDGE_MARGIN;
    const overflowY = h.top + p.height - (window.innerHeight - EDGE_MARGIN);
    const next = {
      left: overflowsRight && fitsLeft,
      shiftY: overflowY > 0 ? -Math.min(overflowY, Math.max(0, h.top - EDGE_MARGIN)) : 0,
    };
    setFlip((prev) => (prev.left === next.left && prev.shiftY === next.shiftY ? prev : next));
  }, [visible]);

  const activate = useCallback(
    (row: ContextMenuFlyoutRow) => {
      if (row.disabled) return;
      if (isFolder(row)) {
        setOpenFolderId(row.id);
        return;
      }
      row.onSelect?.();
      if (row.closeMenuOnSelect) onCloseMenu();
    },
    [onCloseMenu],
  );

  /** Close the open folder and take the caret back — used by the child's Escape/ArrowLeft. */
  const closeFolder = useCallback(() => {
    setOpenFolderId(null);
    inputRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (navigable.length === 0) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIdx((safeIdx + step + navigable.length) % navigable.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (safeIdx >= 0) activate(navigable[safeIdx]);
      return;
    }
    if (e.key === 'ArrowRight') {
      // Only claimed when there is a folder to enter; otherwise it stays ordinary
      // caret movement. Folders are hidden while the query is non-empty, so the two
      // meanings never collide.
      const row = safeIdx >= 0 ? navigable[safeIdx] : null;
      if (row && isFolder(row)) {
        e.preventDefault();
        setOpenFolderId(row.id);
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      // Leaving a folder is only what ArrowLeft means at the very start of the box —
      // anywhere else it is caret movement, and stealing it would make the sub-search
      // box unusable.
      const el = e.currentTarget;
      if (depth > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
        e.preventDefault();
        onCloseSelf();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // stopPropagation, or the app-level Escape handler fires too and does a second,
      // unrelated thing (the CanvasGroupMenu precedent) — and `ContextMenu`'s own
      // document-level Escape would close the whole menu instead of just this flyout.
      // A second Escape, with no flyout left to eat it, then closes the menu.
      e.stopPropagation();
      if (openFolderId) closeFolder();
      else onCloseSelf();
      return;
    }
    if (e.key === 'Tab') {
      // Not a dialog: Tab leaves rather than cycling inside (§4.4). Deliberately not
      // prevented, so focus moves on exactly as it would with no flyout open.
      onCloseSelf();
    }
  };

  const renderRow = (row: ContextMenuFlyoutRow) => {
    const active = row.id === activeId;
    const folder = isFolder(row);
    return (
      <div className="context-menu-flyout-item" key={row.id}>
        <button
          ref={active ? activeRowRef : undefined}
          id={rowDomId(row)}
          type="button"
          role="option"
          aria-selected={active}
          className={`context-menu-flyout-row${active ? ' is-active' : ''}${row.disabled ? ' is-empty' : ''}`}
          disabled={row.disabled}
          title={row.title}
          tabIndex={-1}
          // Keep the caret in the search box: without this the press blurs the input,
          // and the keyboard would be dead the moment the mouse was used once.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => {
            const i = navigable.indexOf(row);
            if (i >= 0) setActiveIdx(i);
          }}
          onClick={() => activate(row)}
        >
          {row.icon && <span className="context-menu-flyout-icon">{row.icon}</span>}
          <span className="context-menu-flyout-label">{row.label}</span>
          {row.detail && <span className="context-menu-flyout-detail">{row.detail}</span>}
          {folder && <span className="context-menu-submenu-arrow">▸</span>}
        </button>
        {folder && openFolderId === row.id && (
          <FlyoutPanel
            flyout={{ ...flyout, rows: row.children!, footerRows: undefined }}
            depth={depth + 1}
            onCloseSelf={closeFolder}
            onCloseMenu={onCloseMenu}
          />
        )}
      </div>
    );
  };

  return (
    <div
      ref={panelRef}
      className={`context-menu-flyout${flip.left ? ' flip-left' : ''}`}
      data-flyout-depth={depth}
      style={flip.shiftY ? { top: flip.shiftY } : undefined}
      // Deliberate: a right-click anywhere in the flyout — the search box included —
      // is swallowed rather than raising WebView2's native menu on top of ours (the
      // CanvasMenu.tsx precedent). The native menu would otherwise appear over the
      // flyout, and dismissing it with a click would land outside `menuRef` and take
      // the whole context menu with it. Ctrl+V/Ctrl+A still edit the field normally.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <input
        ref={inputRef}
        className="context-menu-flyout-search"
        type="text"
        role="combobox"
        aria-expanded
        aria-controls={`${uid}-list`}
        aria-activedescendant={activeId ? `${uid}-${activeId}` : undefined}
        placeholder={searchPlaceholder ?? 'Search…'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="context-menu-flyout-list" id={`${uid}-list`} role="listbox">
        {visible.head.map(renderRow)}
        {visible.footer.length > 0 && visible.head.length > 0 && (
          <div className="context-menu-separator" />
        )}
        {visible.footer.map(renderRow)}
      </div>
    </div>
  );
};

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  /** Index of the item whose flyout is open — a single slot, so opening one closes any other. */
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position to keep menu on screen
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const adjustedX = Math.min(x, window.innerWidth - rect.width - 5);
      const adjustedY = Math.min(y, window.innerHeight - rect.height - 5);

      menuRef.current.style.left = `${Math.max(5, adjustedX)}px`;
      menuRef.current.style.top = `${Math.max(5, adjustedY)}px`;
    }
  }, [x, y]);

  // Portal to <body> so the menu floats above the terminal and is never clipped
  // by a pane ancestor's `overflow: hidden` / stacking context — and so
  // `position: fixed` is measured against the viewport (correct edge-aware math).
  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
    >
      {items.map((item, index) => {
        if (item.type === 'separator') {
          return <div key={index} className="context-menu-separator" />;
        }

        const disabled = item.enabled === false;
        const submenuOpen = openSubmenu === index;

        const button = (
          <button
            key={index}
            className={`context-menu-item${submenuOpen ? ' is-submenu-open' : ''}`}
            disabled={disabled}
            title={item.title}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? submenuOpen : undefined}
            onClick={() => {
              // A submenu parent toggles its flyout INSTEAD of running the item and
              // closing the menu — the branch has to come before `onClose()` or the
              // menu would be gone before the flyout could ever be seen (§4.2).
              if (item.submenu) {
                setOpenSubmenu(submenuOpen ? null : index);
                if (!submenuOpen) item.submenu.onOpen?.();
                return;
              }
              item.click?.();
              onClose();
            }}
          >
            <span className="context-menu-icon">{item.icon}</span>
            <span className="context-menu-label">{item.label}</span>
            {item.accelerator && (
              <span className="context-menu-accelerator">{item.accelerator}</span>
            )}
            {item.submenu && <span className="context-menu-submenu-arrow">▸</span>}
          </button>
        );

        if (!item.submenu) return button;

        // The flyout is a sibling of the button inside a positioned host, not a child
        // of it: a <button> may not contain an <input> or another <button>.
        return (
          <div className="context-menu-submenu-host" key={index}>
            {button}
            {submenuOpen && !disabled && (
              <FlyoutPanel
                flyout={item.submenu}
                depth={0}
                onCloseSelf={() => setOpenSubmenu(null)}
                onCloseMenu={onClose}
              />
            )}
          </div>
        );
      })}
    </div>,
    document.body
  );
};
