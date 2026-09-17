import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { store, RootState } from '../../store';
import { detachTabToNewWindow } from '../Panes/dnd/detach';
import { openNewTabWithDefaultProfile, openNewWindow, splitTabPane } from '../../services/paneActions';
import { adminTabSupport, adminTabTooltip } from '../../services/adminTabActions';
import { AdminProfileList } from '../UI/AdminProfileList';
import { CopyableInfoRow } from '../UI/CopyableInfoRow';
import { Mnemonic } from '../UI/Mnemonic';
import { isTypingTarget } from '../UI/useDialogA11y';
import { computeAffectedTabs } from '../../services/closeTabs';
import type { CloseKind } from '../../services/closeTabs';
import { setTabColorSchema, setTabTitleColor, setTabMuted } from '../../store/slices/tabsSlice';
import { ColorSchemaGrid } from '../UI/ColorSchemaGrid';
import { BellIcon } from '../UI/BellIcon';
import { titleColorStyle } from '../../store/titleColor';
import { NewPaneRow } from '../UI/NewPaneRow';
import { SubmenuFlyoutHost } from '../UI/SubmenuFlyoutHost';
import { HOVER_CLOSE_DELAY_MS, SUBMENU_HOVER_OPEN_DELAY_MS } from '../Terminal/ContextMenu';
import './TabContextMenu.css';

/** The three items with a flyout submenu, single-slot like `ContextMenu`'s `openSubmenu`. */
type TabSubmenuKey = 'schema' | 'color' | 'admin';

// Fixed quick-pick colors for the tab name. NOT derived from the active color
// schema: the tab strip itself always renders on its own fixed dark
// background (TabManager.css .tab-item, independent of any terminal
// schema), so a schema-derived swatch (e.g. a light theme's dark text color)
// could be unreadable there. These are hand-picked for contrast against that
// fixed background, and chosen so that any two stay distinguishable as 13px
// TITLE TEXT (not just as swatches — thin glyphs wash out small hue steps,
// which is why there is one red, one blue, etc. and no near-neighbours like
// rose/red or indigo/violet). Deliberately no white (that is the default title
// color, reachable via "Reset to Default") and no greys: a grey title reads
// as a DISABLED tab, not a colored one.
const TAB_NAME_COLORS: { name: string; hex: string }[] = [
  { name: 'Red', hex: '#FF3B3B' },
  { name: 'Orange', hex: '#FF8C1A' },
  { name: 'Yellow', hex: '#FFE81A' },
  { name: 'Lime', hex: '#9CF52A' },
  { name: 'Green', hex: '#22C94E' },
  { name: 'Teal', hex: '#19B39B' },
  { name: 'Cyan', hex: '#22E5FF' },
  { name: 'Sky', hex: '#8FCBFF' },
  { name: 'Blue', hex: '#3F6DFF' },
  { name: 'Purple', hex: '#A85CFF' },
  { name: 'Magenta', hex: '#FF3DE0' },
  { name: 'Pink', hex: '#FFA0D2' },
  { name: 'Brown', hex: '#C9925A' },
  { name: 'Olive', hex: '#B8B84A' },
];

interface TabContextMenuProps {
  x: number;
  y: number;
  tabId: string;
  tabTitle: string;
  /** Backend process id per LIVE terminal leaf of this tab. A solo tab has one;
   *  a split tab has one per pane (re-review 111 finding 3 — the old single
   *  `processId` silently resolved to nothing for a split API-created tab). */
  processIds?: string[];
  /** Hide "Move to New Window" when this is the only tab in the window. */
  canDetach?: boolean;
  /** Route a close action (single/right/left/others) into the confirm flow. */
  onCloseKind: (tabId: string, kind: CloseKind) => void;
  onClose: () => void;
}

export const TabContextMenu: React.FC<TabContextMenuProps> = ({
  x,
  y,
  tabId,
  tabTitle,
  processIds = [],
  canDetach = true,
  onCloseKind,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  // Settings tabs (and any tab without a pane tree) can't host split panes, so
  // the "Open New Pane" items are hidden for them.
  const hasPanes = !!store.getState().panes.treesByTabId[tabId];

  // Reactive (unlike the one-shot store.getState() reads above) so the
  // Color Schema / Tab Color panels' active-swatch highlight updates live as
  // the user clicks through options without closing the menu.
  const dispatch = useDispatch();
  const tab = useSelector((s: RootState) => s.tabs.tabs.find((t) => t.id === tabId));
  const globalSchemaId = useSelector((s: RootState) => s.settings.colorSchemaId);
  const adminSupport = adminTabSupport();

  // Flyout submenus (Color Schema / Tab Color / Open admin Tab), consistent with the
  // terminal's right-click menu: a single-slot `openSubmenu`, a hover-open debounce so a
  // quick sweep across the row does not pop its panel, and a hover-close grace so crossing
  // a neighbouring row on the way into the panel does not tear it down mid-reach. The two
  // delays are imported rather than restated so both menus can only ever agree.
  const [openSubmenu, setOpenSubmenu] = useState<TabSubmenuKey | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const cancelPendingOpen = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);
  const cancelPendingClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  /** Click — opens immediately, and never toggles shut (hover may already have opened it). */
  const openSubmenuNow = useCallback((key: TabSubmenuKey) => {
    cancelPendingOpen();
    cancelPendingClose();
    setOpenSubmenu(key);
  }, [cancelPendingClose, cancelPendingOpen]);
  /** Hover — debounced, and idempotent on an already-open parent. */
  const scheduleSubmenuOpen = useCallback((key: TabSubmenuKey) => {
    cancelPendingClose();
    cancelPendingOpen();
    if (openSubmenu === key) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      openSubmenuNow(key);
    }, SUBMENU_HOVER_OPEN_DELAY_MS);
  }, [cancelPendingClose, cancelPendingOpen, openSubmenu, openSubmenuNow]);
  /** Hovering a row that is not a submenu parent retires whatever flyout is open. */
  const scheduleSubmenuClose = useCallback(() => {
    cancelPendingOpen();
    cancelPendingClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpenSubmenu(null);
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelPendingClose, cancelPendingOpen]);

  useEffect(() => () => {
    cancelPendingOpen();
    cancelPendingClose();
  }, [cancelPendingOpen, cancelPendingClose]);

  // Disabled states for the browser-style close items, from the current tab order.
  const orderedTabIds = store.getState().tabs.tabs.map((t) => t.id);
  const canCloseRight = computeAffectedTabs(orderedTabIds, tabId, 'right').length > 0;
  const canCloseLeft = computeAffectedTabs(orderedTabIds, tabId, 'left').length > 0;
  const canCloseOthers = computeAffectedTabs(orderedTabIds, tabId, 'others').length > 0;

  const closeWith = (kind: CloseKind) => {
    onClose();
    onCloseKind(tabId, kind);
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Esc closes an open FLYOUT first (matching the terminal menu's own Escape, which
    // retires a submenu panel before it ever reaches the menu), and only closes the whole
    // menu once none is open; the bare-letter mnemonics (C/R/L/O) fire the matching close
    // action — recomputing the disabled state from the store at press time so the listener
    // never holds a stale edge case.
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (openSubmenu !== null) {
          cancelPendingOpen();
          cancelPendingClose();
          setOpenSubmenu(null);
        } else {
          onClose();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Don't hijack typed text: if a text field is focused (e.g. an inline tab
      // rename or the terminal search bar) the bare letters belong to it.
      if (isTypingTarget(document.activeElement)) return;
      const ordered = store.getState().tabs.tabs.map((t) => t.id);
      const fire = (kind: CloseKind) => {
        e.preventDefault();
        onClose();
        onCloseKind(tabId, kind);
      };
      switch (e.key.toLowerCase()) {
        case 'c':
          fire('single');
          break;
        case 'r':
          if (computeAffectedTabs(ordered, tabId, 'right').length) fire('right');
          break;
        case 'l':
          if (computeAffectedTabs(ordered, tabId, 'left').length) fire('left');
          break;
        case 'o':
          if (computeAffectedTabs(ordered, tabId, 'others').length) fire('others');
          break;
        default:
          break;
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeydown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [onClose, onCloseKind, tabId, openSubmenu, cancelPendingOpen, cancelPendingClose]);

  // Edge-aware: after mount, shift the menu left/up so it never spills past the
  // right/bottom edge when opened near a corner.
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const adjustedX = Math.min(x, window.innerWidth - rect.width - 5);
    const adjustedY = Math.min(y, window.innerHeight - rect.height - 5);
    el.style.left = `${Math.max(5, adjustedX)}px`;
    el.style.top = `${Math.max(5, adjustedY)}px`;
  }, [x, y]);

  const runAndClose = (fn: () => void) => { fn(); onClose(); };

  const handleMoveToNewWindow = () => {
    void detachTabToNewWindow({ tabId, tabTitle });
    onClose();
  };

  const handleCopyInfo = () => {
    // Solo tab keeps the exact single-value shape it always had; a split tab
    // lists every live pane process instead of dropping them.
    const processLines =
      processIds.length === 0
        ? ''
        : processIds.length === 1
          ? `\nProcess ID: ${processIds[0]}`
          : `\nProcess IDs: ${processIds.join(', ')}`;
    const info = `Tab: ${tabTitle}\nTab ID: ${tabId}${processLines}`;
    navigator.clipboard.writeText(info).then(() => {
      console.log('Tab info copied to clipboard');
      onClose();
    }).catch(err => {
      console.error('Failed to copy tab info:', err);
    });
  };

  return (
    <div
      ref={menuRef}
      className="tab-context-menu"
      style={{
        left: x,
        top: y,
      }}
    >
      <div className="context-menu-header">
        {/* Live from `tab`, not a prop: the Tab Color swatches are in THIS menu, so the header
            repaints as the user clicks through them — the preview is the header itself. */}
        <strong style={titleColorStyle(tab?.titleColor)}>{tabTitle}</strong>
      </div>
      <div className="context-menu-info">
        <CopyableInfoRow label="Tab ID:" value={tabId} />
        {processIds.map((pid, i) => (
          <CopyableInfoRow
            key={pid}
            label={processIds.length === 1 ? 'Process ID:' : `Process ID ${i + 1}:`}
            value={pid}
          />
        ))}
      </div>
      <div className="context-menu-divider" />
      <SubmenuFlyoutHost
        open={openSubmenu === 'schema'}
        panelClassName="submenu-flyout-panel--wide"
        onMouseEnter={cancelPendingClose}
        onMouseLeave={scheduleSubmenuClose}
        trigger={
          <button
            className={`context-menu-item${openSubmenu === 'schema' ? ' is-submenu-open' : ''}`}
            onMouseEnter={() => scheduleSubmenuOpen('schema')}
            onClick={() => openSubmenuNow('schema')}
          >
            <span className="menu-icon">🎨</span>
            Color Schema
            <span className="context-menu-expand-arrow">▸</span>
          </button>
        }
      >
        <ColorSchemaGrid
          activeId={tab?.colorSchemaId}
          defaultSwatchSchemaId={globalSchemaId}
          onPick={(id) => dispatch(setTabColorSchema({ id: tabId, colorSchemaId: id }))}
        />
      </SubmenuFlyoutHost>
      <SubmenuFlyoutHost
        open={openSubmenu === 'color'}
        onMouseEnter={cancelPendingClose}
        onMouseLeave={scheduleSubmenuClose}
        trigger={
          <button
            className={`context-menu-item${openSubmenu === 'color' ? ' is-submenu-open' : ''}`}
            onMouseEnter={() => scheduleSubmenuOpen('color')}
            onClick={() => openSubmenuNow('color')}
          >
            <span className="menu-icon">🏷️</span>
            Tab Color
            <span className="context-menu-expand-arrow">▸</span>
          </button>
        }
      >
        <div className="tab-color-swatches">
          {TAB_NAME_COLORS.map(({ name, hex }) => (
            <button
              key={hex}
              type="button"
              title={name}
              className={`tab-color-dot${tab?.titleColor === hex ? ' active' : ''}`}
              style={{ background: hex }}
              onClick={() => dispatch(setTabTitleColor({ id: tabId, titleColor: hex }))}
            />
          ))}
        </div>
        <button
          type="button"
          className="tab-color-reset"
          onClick={() => dispatch(setTabTitleColor({ id: tabId, titleColor: undefined }))}
        >
          Reset to Default
        </button>
      </SubmenuFlyoutHost>
      <button
        className="context-menu-item"
        onMouseEnter={scheduleSubmenuClose}
        onClick={() => runAndClose(() => dispatch(setTabMuted({ id: tabId, muted: !tab?.notifyMuted })))}
      >
        <span className="menu-icon"><BellIcon muted={!!tab?.notifyMuted} /></span>
        {tab?.notifyMuted ? 'Unmute Notifications' : 'Mute Notifications'}
      </button>
      <div className="context-menu-divider" />
      <button
        className="context-menu-item"
        onMouseEnter={scheduleSubmenuClose}
        onClick={() => runAndClose(() => openNewTabWithDefaultProfile(tabId))}
      >
        <span className="menu-icon">➕</span>
        Open New Tab
      </button>
      {/* Plan 045. Toggle itself always shown (O2) — disabled with a tooltip when
          unsupported, so unavailability is visible without opening the flyout. */}
      <SubmenuFlyoutHost
        open={openSubmenu === 'admin'}
        onMouseEnter={cancelPendingClose}
        onMouseLeave={scheduleSubmenuClose}
        trigger={
          <button
            className={`context-menu-item${openSubmenu === 'admin' ? ' is-submenu-open' : ''}`}
            disabled={!adminSupport.supported}
            title={adminSupport.supported ? undefined : adminTabTooltip(adminSupport.reason)}
            onMouseEnter={() => scheduleSubmenuOpen('admin')}
            onClick={() => openSubmenuNow('admin')}
          >
            <span className="menu-icon">🛡️</span>
            Open admin Tab
            <span className="context-menu-expand-arrow">▸</span>
          </button>
        }
      >
        <AdminProfileList variant="menu" afterTabId={tabId} onPick={onClose} />
      </SubmenuFlyoutHost>
      <button
        className="context-menu-item"
        onMouseEnter={scheduleSubmenuClose}
        onClick={() => runAndClose(() => { void openNewWindow(); })}
      >
        <span className="menu-icon">🪟</span>
        Open New Window
      </button>
      {hasPanes && (
        <NewPaneRow
          title="Split this tab's focused pane with a new terminal."
          onSplit={(direction, position) => splitTabPane(tabId, direction, position)}
          onDone={onClose}
          onMouseEnter={scheduleSubmenuClose}
        />
      )}
      {canDetach && (
        <>
          <div className="context-menu-divider" />
          <button className="context-menu-item" onMouseEnter={scheduleSubmenuClose} onClick={handleMoveToNewWindow}>
            <span className="menu-icon">⧉</span>
            Move to New Window
          </button>
        </>
      )}
      <div className="context-menu-divider" />
      <button className="context-menu-item close-item" onMouseEnter={scheduleSubmenuClose} onClick={() => closeWith('single')}>
        <span className="menu-icon">✕</span>
        <Mnemonic label="Close Tab" char="C" />
      </button>
      <button
        className="context-menu-item close-item"
        disabled={!canCloseRight}
        onMouseEnter={scheduleSubmenuClose}
        onClick={() => closeWith('right')}
      >
        <span className="menu-icon">▸</span>
        <Mnemonic label="Close Tabs to the Right" char="R" />
      </button>
      <button
        className="context-menu-item close-item"
        disabled={!canCloseLeft}
        onMouseEnter={scheduleSubmenuClose}
        onClick={() => closeWith('left')}
      >
        <span className="menu-icon">◂</span>
        <Mnemonic label="Close Tabs to the Left" char="L" />
      </button>
      <button
        className="context-menu-item close-item"
        disabled={!canCloseOthers}
        onMouseEnter={scheduleSubmenuClose}
        onClick={() => closeWith('others')}
      >
        <span className="menu-icon">⊗</span>
        <Mnemonic label="Close Other Tabs" char="O" />
      </button>
      <div className="context-menu-divider" />
      <button className="context-menu-item" onMouseEnter={scheduleSubmenuClose} onClick={handleCopyInfo}>
        <span className="menu-icon">📄</span>
        Copy All Info
      </button>
    </div>
  );
};