import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTooltipDwell } from '../../hooks/useTooltipDwell';
// Re-exported because the dwell is part of THIS menu's observable contract even though the hook
// that implements it is shared — the tests that tick it, and any caller reasoning about how long a
// tooltip takes, are talking about the menu, not about a hook in `hooks/`.
export { TOOLTIP_DWELL_MS } from '../../hooks/useTooltipDwell';
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
  /**
   * Tooltip for the DETAIL specifically, so a row can carry two.
   *
   * `detail` is ellipsed at a fraction of the row's width, which is right where a folder
   * plus a couple of tags lands — `📁 General #co…`. A single row-wide tooltip
   * cannot rescue that: it is already spoken for by `title`, which has to stay the
   * snippet's own text. A `title` on the detail SPAN wins over the button's whenever the
   * pointer is inside it, and that span is exactly the hit area the truncation is in.
   *
   * Defaults to `detail` itself when absent, so a row that only wants its truncated text
   * back gets it without having to say so.
   */
  detailTitle?: string;
  /** Native tooltip — the place for the full, untruncated text. */
  title?: string;
  /** Rows of a nested flyout. Present ⇒ this is a folder row. */
  children?: ContextMenuFlyoutRow[];
  /** Run on click / Enter. Ignored for folder rows. Runs BEFORE the dismissal a
   *  `closeMenuOnSelect` row asks for — see that field, which explains why that order is the
   *  correct one rather than the arbitrary one. */
  onSelect?: () => void;
  /**
   * Dismiss the WHOLE context menu, unconditionally, **after** `onSelect` has run.
   *
   * §4.5 is "**every** row closes the menu" — and every row this repo builds
   * (`snippetsHistoryMenu.ts`, `AutomationMenuSection.tsx`) says so explicitly. That is
   * deliberately a decision stated at each call site rather than a default here, for two
   * reasons: it is a product rule about the rows this app happens to build, not a property
   * of a generic flyout (a folder row opens a submenu and dismisses nothing); and stated as
   * data it is assertable straight off the builder's output, where a default cannot be.
   * Defaults to **false** so a row that never considered dismissal cannot tear down the
   * surface the user is mid-interaction with.
   *
   * **The action runs first, and the dismissal is unconditional — a `finally`, not an
   * ordering.** Both halves of that are load-bearing, and the first one was briefly the
   * other way round on the strength of an argument that does not survive being measured.
   *
   * *The argument that failed.* Several rows here open a surface of their own: a modal
   * editor (`AutomationMenuSection`'s rule and "New automation" rows) or a dialog
   * (`snippetsHistoryMenu`'s "Add New Snippet"). This menu does not close itself when
   * something is portalled on top of it, and while it is up it holds a document-level
   * `mousedown` trap and a document-level Escape handler. It is tempting to conclude that
   * the dismissal must therefore be asked for FIRST, so the modal never mounts under a live
   * menu. It does not follow: `onCloseMenu()` is a queued `setState`, and React does not
   * flush it until the end of the discrete event. Probing the real component — counting
   * live document listeners from inside a row's `onSelect` — shows the menu still mounted
   * with BOTH handlers installed at the moment the row opens its surface, **whichever order
   * the two calls are in**. Reordering bought nothing here, and the paragraph that used to
   * stand in this space claimed otherwise while conceding two lines later that React batches
   * the two commits into one.
   *
   * *What order genuinely decides* is a close callback that does synchronous non-React
   * work, and there the action-first order is the correct one rather than the arbitrary
   * one. `TerminalDisplay`'s `closeContextMenu` puts DOM focus back in the terminal, and
   * guards that with a ref which "Add New Snippet" sets as it opens its dialog. Run the
   * close first and that ref is still `false`, so the guard falls through and
   * `engine.focus()` fires on the terminal in the gap before the dialog mounts — which
   * under DECSET 1004 focus reporting is a spurious focus-in/focus-out pair written to the
   * PTY, on every click, visible to any TUI that redraws on focus. The row must be allowed
   * to state its intent before the host acts on the dismissal.
   *
   * *Which leaves the one real defect the reorder was reaching for*: a row whose action
   * RAISES — a store listener that throws inside a synchronous `emit()`, say — used to skip
   * the dismissal outright and strand the menu on screen over the surface it had just
   * opened. That is fixed by making the dismissal unconditional rather than by moving it:
   * the `finally` runs on both paths, and the queued close still commits because React
   * dispatches inside `batchedUpdates`, whose own `finally` flushes work already scheduled.
   * `contextMenuFlyout.test.tsx` pins it with a host that really unmounts, and asserts the
   * menu is gone from the DOM rather than that a mock was called.
   */
  closeMenuOnSelect?: boolean;
  /** Inert placeholder (an empty-state message). Rendered, never activated, and
   *  skipped by the arrow keys so it cannot swallow the selection. */
  disabled?: boolean;
}

/**
 * A single toggle button sitting beside the flyout's search box.
 *
 * Deliberately ONE optional button rather than a list of header actions: the only caller
 * is the Snippets flyout's flat/folders switch, and an action bar would be a shape
 * invented for a second caller that does not exist. It is also why `pressed` is a plain
 * boolean — this models a two-state toggle, not a menu.
 */
export interface ContextMenuFlyoutToggle {
  /** Glyph on the button. Reflects the CURRENT state, so it changes when toggled. */
  icon: string;
  /** Native tooltip and accessible name — say what pressing it will DO. */
  title: string;
  /** `aria-pressed`, and the `.is-on` styling hook. */
  pressed: boolean;
  onToggle: () => void;
}

/** The flyout attached to one `ContextMenuItem`. */
export interface ContextMenuFlyout {
  /** Placeholder for the search box at the top of the flyout. */
  searchPlaceholder?: string;
  /**
   * Optional toggle rendered to the right of the search box, at DEPTH 0 ONLY.
   *
   * A nested (folder) panel is handed a derived flyout, and this field is stripped on the
   * way down: the toggle switches how the WHOLE list is grouped, so a copy of it inside a
   * folder would be a control whose own panel disappears the moment it is pressed.
   */
  headerToggle?: ContextMenuFlyoutToggle;
  /**
   * Render the DEPTH-0 panel narrow, at DEPTH 0 ONLY.
   *
   * A panel's width has to suit what its rows actually hold, and the same flyout holds
   * two different things depending on how it is arranged. A list of FOLDER NAMES is
   * short; a list of snippets with folder chips and tags is not. A width wide enough for
   * the second leaves the first as a column of short words in a lot of empty panel.
   *
   * Stripped on the way down for exactly that reason: the folder panel a narrow root
   * opens contains snippets, so it takes the full width — which is the arrangement the
   * user sees as "narrow menu, wide submenu".
   */
  narrow?: boolean;
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
  /**
   * Show every `title` at once, skipping the dwell.
   *
   * For a menu that is not a list of ACTIONS you sweep through but a list of CANDIDATES you have
   * to tell apart. `TerminalDisplay`'s path picker is the case: its labels deliberately strip the
   * shared base directory so the rows read `…\\file.cs` rather than three long absolute paths, and
   * the `title` holds the full path — which is to say the tooltip is the entire content of the
   * menu, not an explanation of it. Three seconds per candidate to answer the only question the
   * picker exists to answer is a regression, and there is no trail to suppress: nobody sweeps past
   * a two-line disambiguation prompt on the way to something else.
   */
  instantTitles?: boolean;
  /**
   * Render ONLY this item's flyout — open on the first paint, with no menu around it.
   *
   * The keyboard shortcut that opens the Snippets list is what this is for. Pressing a
   * shortcut and being shown the menu ROW you would have clicked, with the list beside
   * it, keeps the click you just skipped on screen: the row has nothing left to do, and
   * the panel is pushed a row's width away from where the shortcut was aimed. So the
   * items are not drawn at all, and the panel lands at the given point itself.
   *
   * The flyout's `onOpen` fires once on mount, exactly as it would have on a click, so a
   * flyout that warms a cache is not skipped. Escape and Tab dismiss the whole thing
   * rather than the panel alone — with no menu behind it, closing "just the flyout"
   * would leave nothing on screen and a live outside-click handler behind it.
   */
  standaloneSubmenu?: number;
}

/** Keep-on-screen margin, matching the menu's own 5px in the effect below. */
const EDGE_MARGIN = 5;

/**
 * Grace period before a flyout opened by hover closes again, in ms.
 *
 * A submenu panel is `left: 100%` of its item, so the pointer's natural path from the item
 * into the panel — right, then down to a row — leaves the item and crosses whatever items
 * sit BELOW it before re-entering the host. Closing the instant another item is hovered
 * would therefore tear the panel down mid-reach. This is the cheap, boring version of the
 * "safe triangle": short enough that moving deliberately to another item still closes the
 * panel, long enough to survive a diagonal.
 *
 * Re-entering the submenu host cancels the pending close outright (the panel is a CHILD of
 * that host, so entering the panel from outside fires the host's own mouseenter), which is
 * what makes the delay a backstop rather than the whole mechanism.
 */
const HOVER_CLOSE_DELAY_MS = 260;

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
  /** See `ContextMenuProps.instantTitles` — threaded down so a picker's rows are exempt too. */
  instantTitles?: boolean;
  /**
   * `true` when the panel this one hangs off is itself rendering to the LEFT of its
   * anchor. A cascade that has started leftward must keep going leftward: see the
   * placement effect.
   */
  parentFlippedLeft?: boolean;
  /** Escape / ArrowLeft / Tab — closes THIS panel and returns focus to its opener. */
  onCloseSelf: () => void;
  /** Dismiss the entire context menu — called for a `closeMenuOnSelect` row, before that
   *  row's own `onSelect` runs. */
  onCloseMenu: () => void;
}

/**
 * One flyout panel: a search box plus a keyboard-navigable row list.
 *
 * **Two opposing constraints fix where this thing is allowed to live in the DOM.**
 *
 * 1. *Inside `menuRef`.* `ContextMenu`'s outside-click handler closes on any
 *    mousedown that `menuRef` does not contain, so a panel portalled to
 *    `document.body` would be "outside" the menu and the first press on a row would
 *    close everything before the click landed (design 029 §4.2). **It therefore
 *    renders where it is mounted — never through a portal.**
 * 2. *Outside `.context-menu-flyout-list`.* That list is the `max-height` +
 *    `overflow-y: auto` scroller §4.3 requires, and an `overflow` other than
 *    `visible` clips positioned descendants at the list box. A nested panel rendered
 *    inside a row of the list is invisible in any real engine — and invisibly fine in
 *    jsdom, which implements neither layout nor clipping.
 *
 * The two are satisfied at once by hanging a nested panel off the **parent panel**
 * rather than off the folder row: a nested `FlyoutPanel` is rendered as a sibling of
 * the list, not inside it. `.context-menu-flyout` is `position: absolute` (so it is
 * already the containing block) and declares no `overflow` (so it clips nothing), and
 * it is still inside `menuRef`. That also generalises — depth 2+ would nest the same
 * way — and it makes `panel.parentElement` the correct measuring anchor at every
 * depth: the submenu host at depth 0, the parent panel at depth 1+, which is exactly
 * the box a `left: 100%` / `right: 100%` child is positioned against.
 *
 * The one visible consequence is that a folder's panel opens level with the TOP of
 * its parent panel rather than with the folder row. That reads well here rather than
 * badly: `buildGroupedRows` puts every folder row first, so the row is near the top
 * anyway, and search box lines up with search box, first row with first row. Aligning
 * to the row instead would mean measuring the row and re-deriving `shiftY` from a top
 * the panel does not yet have — real machinery bought for a few pixels.
 *
 * Being absolutely positioned also keeps it out of the menu's flow, so it contributes
 * nothing to the menu's intrinsic width and the edge-aware repositioning in
 * `ContextMenu` is unaffected.
 *
 * DOM focus stays in the search input the whole time; the "active" row is only
 * *styled* (`.is-active`) and announced via `aria-activedescendant`. That is what
 * keeps typing filtering rather than navigating, and it is why P1's "keyboard
 * navigation must not interfere with terminal input" holds by construction — an
 * editable non-terminal element owns the keyboard.
 */
const FlyoutPanel: React.FC<FlyoutPanelProps> = ({
  flyout,
  depth,
  instantTitles = false,
  parentFlippedLeft = false,
  onCloseSelf,
  onCloseMenu,
}) => {
  const uid = useId();
  // One per PANEL, not one shared down the cascade: each panel owns the rows it draws, and a
  // nested panel opening is itself a move off the folder row that opened it.
  const tip = useTooltipDwell();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRowRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  /**
   * Was the active row reached by the KEYBOARD?
   *
   * `onMouseEnter` also sets `activeIdx`, so "is the active row" cannot stand in for "was arrowed
   * to" — using it directly would hand the hovered row its title instantly and delete the feature.
   * Set by the arrow keys, cleared by the pointer, so the two navigation modes are distinguishable
   * at the one place that has to tell them apart.
   */
  const [keyboardNav, setKeyboardNav] = useState(false);
  // Starts on the parent's side of the cascade, so the direction is already right on
  // the very first paint and stays right if nothing can ever be measured.
  const [flip, setFlip] = useState<{ left: boolean; shiftY: number }>({
    left: parentFlippedLeft,
    shiftY: 0,
  });

  const { rows, emptyRow, footerRows, searchPlaceholder, headerToggle, narrow } = flyout;

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
    /**
     * **And the dwell, which is the one with teeth.** The search box is focused when the panel
     * opens, so re-filtering needs no pointer event at all — and `useTooltipDwell` is cleared only
     * by pointer events. Without this, a dwelt key outlives the row that earned it and whatever
     * lands on that key next inherits an armed tooltip: with Command History's rows, which were
     * `history-${i}` until this same round, resting on the top row for three seconds and then
     * typing popped a native tooltip for a DIFFERENT command with no delay, once per keystroke.
     * The ids are content-derived now; this is the other half, and it is the half that also covers
     * a row surviving the filter while nobody is resting on it.
     */
    tip.reset();
  }, [query]);

  // Keep the active row in view as the arrows move past the `max-height` (§4.4).
  useEffect(() => {
    activeRowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  // Edge-aware placement: flip to the left of the anchor when the panel would leave
  // the viewport on the right, and lift it when it would run off the bottom.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    // The anchor this panel is absolutely positioned against — `.context-menu-submenu-host`
    // at depth 0, the PARENT PANEL at depth 1+ (see the render, and the note on this
    // component about why a nested panel may not hang off its folder row).
    const host = panel?.parentElement;
    if (!panel || !host) return;
    const p = panel.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    // Nothing to measure — jsdom, and the very first paint. Leave the state alone:
    // it already starts on the parent's side of the cascade (see `useState` above),
    // which is the only defensible direction when measurement is unavailable. Setting
    // it here as well would be a second guard covering the same case, and one that
    // no test could then distinguish from the first.
    if (p.width === 0 && p.height === 0) return;
    const overflowsRight = h.right + p.width > window.innerWidth - EDGE_MARGIN;
    const fitsLeft = h.left - p.width > EDGE_MARGIN;
    const overflowY = h.top + p.height - (window.innerHeight - EDGE_MARGIN);
    const next = {
      // `parentFlippedLeft ||` is the cascade rule, and it is not cosmetic. A child
      // measures against its parent's box, so once the parent has flipped left there
      // is by definition room to the *right* of it — room occupied by the menu the
      // parent just flipped away from. Deciding locally sends the child straight back
      // on top of the root menu and hides it. Standard cascading-menu behaviour: keep
      // going the way the ancestor went, and `&& fitsLeft` is what stops the cascade
      // when the left viewport edge finally forbids it.
      left: (parentFlippedLeft || overflowsRight) && fitsLeft,
      shiftY: overflowY > 0 ? -Math.min(overflowY, Math.max(0, h.top - EDGE_MARGIN)) : 0,
    };
    setFlip((prev) => (prev.left === next.left && prev.shiftY === next.shiftY ? prev : next));
  }, [visible, parentFlippedLeft]);

  const activate = useCallback(
    (row: ContextMenuFlyoutRow) => {
      if (row.disabled) return;
      if (isFolder(row)) {
        setOpenFolderId(row.id);
        return;
      }
      // The action runs first and the dismissal is in a `finally` — see `closeMenuOnSelect`
      // for why that is the right way round, and why asking for the dismissal first is not.
      try {
        row.onSelect?.();
      } finally {
        if (row.closeMenuOnSelect) onCloseMenu();
      }
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
      setKeyboardNav(true);
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
    /**
     * Both of this row's tooltips, gated on the dwell — with three exemptions, each documented on
     * `useTooltipDwell` itself: a picker whose titles ARE its content, a disabled row that
     * dispatches no mouse events, and the row a KEYBOARD user has arrowed to, for whom no mouse
     * dwell will ever happen and whose `title` is the only copy of a truncated label's full text.
     */
    const tipFor = (t: string | undefined) =>
      (instantTitles || row.disabled || (keyboardNav && active) ? t : tip.titleFor(row.id, t));
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
          title={tipFor(row.title)}
          tabIndex={-1}
          // Keep the caret in the search box: without this the press blurs the input,
          // and the keyboard would be dead the moment the mouse was used once.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => {
            const i = navigable.indexOf(row);
            if (i >= 0) setActiveIdx(i);
            setKeyboardNav(false);
            tip.onEnter(row.id);
          }}
          onMouseLeave={tip.onLeave}
          onClick={() => activate(row)}
        >
          {row.icon && <span className="context-menu-flyout-icon">{row.icon}</span>}
          <span className="context-menu-flyout-label">{row.label}</span>
          {row.detail && (
            <span
              className="context-menu-flyout-detail"
              title={tipFor(row.detailTitle ?? row.detail)}
            >
              {row.detail}
            </span>
          )}
          {folder && <span className="context-menu-submenu-arrow">▸</span>}
        </button>
      </div>
    );
  };

  // Resolved from the rows currently on screen rather than kept as a node: a filter
  // can take the open folder away (they are flattened while searching), and looking
  // it up here means a stale id simply resolves to nothing.
  const openFolder =
    openFolderId === null
      ? null
      : ([...visible.head, ...visible.footer].find((r) => r.id === openFolderId && isFolder(r)) ??
        null);

  return (
    <div
      ref={panelRef}
      className={`context-menu-flyout${flip.left ? ' flip-left' : ''}${narrow ? ' is-narrow' : ''}`}
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
      <div className="context-menu-flyout-header">
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
        {headerToggle && (
          <button
            type="button"
            className={`context-menu-flyout-toggle${headerToggle.pressed ? ' is-on' : ''}`}
            title={headerToggle.title}
            aria-label={headerToggle.title}
            aria-pressed={headerToggle.pressed}
            tabIndex={-1}
            // Same reason the rows do it: pressing this must not blur the search box, or
            // one use of the mouse leaves the keyboard dead for the rest of the session.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              headerToggle.onToggle();
              inputRef.current?.focus();
            }}
          >
            {headerToggle.icon}
          </button>
        )}
      </div>
      <div className="context-menu-flyout-list" id={`${uid}-list`} role="listbox">
        {visible.head.map(renderRow)}
        {visible.footer.length > 0 && visible.head.length > 0 && (
          <div className="context-menu-separator" />
        )}
        {visible.footer.map(renderRow)}
      </div>
      {/* A SIBLING of the scrolling list, not a descendant of it: see the note on this
          component. It is still inside `menuRef`, so the outside-click trap is not
          reintroduced, and it is no longer inside anything that clips. */}
      {openFolder && (
        <FlyoutPanel
          instantTitles={instantTitles}
          flyout={{
            ...flyout,
            rows: openFolder.children!,
            footerRows: undefined,
            // Both stripped, not inherited — see each field's own note. The spread would
            // otherwise carry a grouping control into a panel that exists only BECAUSE of
            // the grouping it switches off, and squeeze that panel's snippets into a width
            // chosen for folder names.
            headerToggle: undefined,
            narrow: undefined,
          }}
          depth={depth + 1}
          parentFlippedLeft={flip.left}
          onCloseSelf={closeFolder}
          onCloseMenu={onCloseMenu}
        />
      )}
    </div>
  );
};

export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  items,
  onClose,
  instantTitles = false,
  standaloneSubmenu,
}) => {
  /** No menu chrome, no items — one flyout, at the requested point. */
  const bare = standaloneSubmenu != null;
  const menuRef = useRef<HTMLDivElement>(null);
  /** Index of the item whose flyout is open — a single slot, so opening one closes any other. */
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(standaloneSubmenu ?? null);
  const closeTimer = useRef<number | null>(null);

  const cancelPendingClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  /**
   * Hovering a submenu parent opens it.
   *
   * Idempotent on purpose: the host's mouseenter fires again every time the pointer comes
   * back from a neighbouring item, and `onOpen` is a cache warm, not a render hook — so
   * the already-open check lives here rather than at the call sites, where a new caller
   * would have to remember it.
   */
  const openSubmenuAt = useCallback((index: number, item: ContextMenuItem) => {
    cancelPendingClose();
    setOpenSubmenu((prev) => {
      if (prev === index) return prev;
      item.submenu?.onOpen?.();
      return index;
    });
  }, [cancelPendingClose]);

  /** Hovering an item that is NOT a submenu parent retires the open flyout, after the
   *  grace period above. */
  const scheduleCloseSubmenu = useCallback(() => {
    cancelPendingClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpenSubmenu(null);
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelPendingClose]);

  // A timer that outlives the menu would set state on an unmounted component, and keep a
  // closure over `items` alive for a menu the user has already dismissed.
  useEffect(() => cancelPendingClose, [cancelPendingClose]);

  // The items' tooltips. The flyout panels hold their own — see `useTooltipDwell`.
  //
  // The cost, stated for THIS instance because it differs from the flyout's: one re-render of the
  // portalled menu three seconds after the pointer stops, and one more as the previous row's title
  // is taken away. That is new work — a host item's hover is otherwise pure CSS, unlike a flyout
  // row, whose `is-active` marker already re-renders on `mouseenter`. It touches only `title`
  // attributes, so it forces no layout and re-runs neither placement effect (theirs are keyed on
  // `[x, y]` and `[visible, parentFlippedLeft]`).
  //
  // A host item is an ordinary Tab-focusable button, so the KEYBOARD half of this is plain DOM
  // focus and the hook answers it — `tip.onFocus`/`tip.onBlur` below. It was a `useState` here for
  // one round; it moved the moment the accordion needed the same exemption.
  const tip = useTooltipDwell();

  // `standaloneSubmenu` bypasses `openSubmenuAt`, so its `onOpen` has to be fired here or
  // a shortcut-opened Command History would never warm its directory cache. Mount only:
  // re-firing it whenever `items` is rebuilt — which is every render of the owner — would
  // turn a once-per-open hook into a per-keystroke one.
  useEffect(() => {
    if (standaloneSubmenu != null) items[standaloneSubmenu]?.submenu?.onOpen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      className={`context-menu${bare ? ' is-bare' : ''}`}
      style={{ left: x, top: y }}
    >
      {items.map((item, index) => {
        // Everything except the one flyout is skipped — including the separators, which
        // would otherwise draw lines across an otherwise empty box.
        if (bare && index !== standaloneSubmenu) return null;
        if (item.type === 'separator') {
          return <div key={index} className="context-menu-separator" />;
        }

        const disabled = item.enabled === false;
        const submenuOpen = openSubmenu === index;
        /**
         * The dwell key: the item's own LABEL, and its index only as a fallback.
         *
         * `items` is rebuilt by the owner on every one of ITS renders, and this menu stays
         * mounted across them — `TerminalDisplay` re-renders while the menu is open whenever
         * agent detection settles, which inserts a *"Color scheme for …"* item above Copy and
         * shifts every index below it. A dwelt tooltip keyed on position would then be handed
         * to whichever item had slid into that slot: the wrong sentence, on the right-looking
         * row, for the rest of the dwell. A label is what the user is actually pointing at.
         *
         * Two items sharing a label would share a key, which merely puts the attribute on both
         * — only the one under the pointer can show a tooltip, so that is a non-event, unlike
         * the mismatch above. The index fallback is for a labelless item, which cannot be one
         * of a matching pair in any menu this repo builds.
         */
        const tipKey = item.label ?? `item-${index}`;

        const button = (
          <button
            key={index}
            className={`context-menu-item${submenuOpen ? ' is-submenu-open' : ''}`}
            disabled={disabled}
            // Two exemptions here, both documented on `useTooltipDwell`: a picker whose titles
            // ARE its content, and a disabled item (which dispatches no mouse events, and whose
            // tooltip is the only thing saying why it is dimmed). The third — an item reached by
            // the keyboard — is inside `titleFor`, fed by the focus handlers below.
            title={instantTitles || disabled ? item.title : tip.titleFor(tipKey, item.title)}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? submenuOpen : undefined}
            onMouseEnter={() => {
              if (disabled) return;
              tip.onEnter(tipKey);
              // A plain item retires whatever flyout is open; a submenu parent opens its
              // own. Both live on the ITEM rather than on the host below, so a menu with
              // no submenus at all is untouched by any of this.
              if (item.submenu) openSubmenuAt(index, item);
              else scheduleCloseSubmenu();
            }}
            onMouseLeave={tip.onLeave}
            onFocus={() => tip.onFocus(tipKey)}
            onBlur={() => tip.onBlur(tipKey)}
            onClick={() => {
              // A submenu parent OPENS its flyout instead of running the item and closing
              // the menu — the branch has to come before `onClose()` or the menu would be
              // gone before the flyout could ever be seen (§4.2).
              //
              // Open, not toggle. Hover has already opened it by the time any click can
              // land, so a toggle here would mean clicking the thing you are pointing at
              // closes it — making the one instinctive reaction to a surprising hover-open
              // the reaction that removes the panel.
              if (item.submenu) {
                openSubmenuAt(index, item);
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

        // A `standaloneSubmenu` pointing at an item with no flyout has nothing to show;
        // returning the button would put a lone menu row where a panel was asked for.
        if (!item.submenu) return bare ? null : button;

        // The flyout is a sibling of the button inside a positioned host, not a child
        // of it: a <button> may not contain an <input> or another <button>.
        return (
          <div
            className="context-menu-submenu-host"
            key={index}
            // The panel is a CHILD of this host, so coming back into it from a neighbouring
            // item fires this and cancels the pending close. Without it the grace period
            // would expire while the pointer sat on a row.
            onMouseEnter={cancelPendingClose}
          >
            {!bare && button}
            {submenuOpen && !disabled && (
              <FlyoutPanel
                flyout={item.submenu}
                depth={0}
                instantTitles={instantTitles}
                // With no menu behind it, retiring the panel alone would leave an empty
                // box on screen still swallowing the next outside click. Escape and Tab
                // therefore mean "dismiss", which is what they already meant to the user.
                onCloseSelf={bare ? onClose : () => setOpenSubmenu(null)}
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
