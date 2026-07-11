import React, { useEffect, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { store, RootState } from '../../store';
import { detachTabToNewWindow } from '../Panes/dnd/detach';
import { openNewTabWithDefaultProfile, openNewWindow, splitTabPane } from '../../services/paneActions';
import { CopyableInfoRow } from '../UI/CopyableInfoRow';
import { Mnemonic } from '../UI/Mnemonic';
import { isTypingTarget } from '../UI/useDialogA11y';
import { computeAffectedTabs } from '../../services/closeTabs';
import type { CloseKind } from '../../services/closeTabs';
import { setTabColorSchema, setTabTitleColor } from '../../store/slices/tabsSlice';
import { ColorSchemaGrid } from '../UI/ColorSchemaGrid';
import './TabContextMenu.css';

// Fixed quick-pick colors for the tab name. NOT derived from the active color
// schema: the tab strip itself always renders on its own fixed dark
// background (TabManager.css .tab-item, independent of any terminal
// schema), so a schema-derived swatch (e.g. a light theme's dark text color)
// could be unreadable there. These are hand-picked for contrast against that
// fixed background.
const TAB_NAME_COLORS: { name: string; hex: string }[] = [
  { name: 'Red', hex: '#F14C4C' },
  { name: 'Orange', hex: '#FF8C42' },
  { name: 'Yellow', hex: '#F5F543' },
  { name: 'Green', hex: '#23D18B' },
  { name: 'Teal', hex: '#29B8DB' },
  { name: 'Cyan', hex: '#61D6D6' },
  { name: 'Blue', hex: '#3B8EEA' },
  { name: 'Purple', hex: '#B48EAD' },
  { name: 'Magenta', hex: '#D670D6' },
  { name: 'Pink', hex: '#FF79C6' },
  { name: 'White', hex: '#E5E5E5' },
  { name: 'Gray', hex: '#969696' },
];

interface TabContextMenuProps {
  x: number;
  y: number;
  tabId: string;
  tabTitle: string;
  processId?: string;
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
  processId,
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
  const [expanded, setExpanded] = useState<'schema' | 'color' | null>(null);

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

    // Esc closes the menu; the bare-letter mnemonics (C/R/L/O) fire the matching
    // close action — recomputing the disabled state from the store at press time
    // so the listener never holds a stale edge case.
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
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
  }, [onClose, onCloseKind, tabId]);

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
    const info = `Tab: ${tabTitle}\nTab ID: ${tabId}${processId ? `\nProcess ID: ${processId}` : ''}`;
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
        <strong>{tabTitle}</strong>
      </div>
      <div className="context-menu-info">
        <CopyableInfoRow label="Tab ID:" value={tabId} />
        {processId && <CopyableInfoRow label="Process ID:" value={processId} />}
      </div>
      <div className="context-menu-divider" />
      <button
        className="context-menu-item"
        onClick={() => setExpanded(expanded === 'schema' ? null : 'schema')}
      >
        <span className="menu-icon">🎨</span>
        Color Schema
        <span className="context-menu-expand-arrow">{expanded === 'schema' ? '▾' : '▸'}</span>
      </button>
      {expanded === 'schema' && (
        <div className="context-menu-subpanel">
          <ColorSchemaGrid
            activeId={tab?.colorSchemaId}
            defaultSwatchSchemaId={globalSchemaId}
            onPick={(id) => dispatch(setTabColorSchema({ id: tabId, colorSchemaId: id }))}
          />
        </div>
      )}
      <button
        className="context-menu-item"
        onClick={() => setExpanded(expanded === 'color' ? null : 'color')}
      >
        <span className="menu-icon">🏷️</span>
        Tab Color
        <span className="context-menu-expand-arrow">{expanded === 'color' ? '▾' : '▸'}</span>
      </button>
      {expanded === 'color' && (
        <div className="context-menu-subpanel">
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
        </div>
      )}
      <div className="context-menu-divider" />
      <button className="context-menu-item" onClick={() => runAndClose(() => openNewTabWithDefaultProfile(tabId))}>
        <span className="menu-icon">➕</span>
        Open New Tab
      </button>
      <button className="context-menu-item" onClick={() => runAndClose(() => { void openNewWindow(); })}>
        <span className="menu-icon">🪟</span>
        Open New Window
      </button>
      {hasPanes && (
        <>
          <button className="context-menu-item" onClick={() => runAndClose(() => splitTabPane(tabId, 'vertical'))}>
            <span className="menu-icon">▥</span>
            Open New Pane Vertically
          </button>
          <button className="context-menu-item" onClick={() => runAndClose(() => splitTabPane(tabId, 'horizontal'))}>
            <span className="menu-icon">▤</span>
            Open New Pane Horizontally
          </button>
        </>
      )}
      {canDetach && (
        <>
          <div className="context-menu-divider" />
          <button className="context-menu-item" onClick={handleMoveToNewWindow}>
            <span className="menu-icon">⧉</span>
            Move to New Window
          </button>
        </>
      )}
      <div className="context-menu-divider" />
      <button className="context-menu-item close-item" onClick={() => closeWith('single')}>
        <span className="menu-icon">✕</span>
        <Mnemonic label="Close Tab" char="C" />
      </button>
      <button
        className="context-menu-item close-item"
        disabled={!canCloseRight}
        onClick={() => closeWith('right')}
      >
        <span className="menu-icon">▸</span>
        <Mnemonic label="Close Tabs to the Right" char="R" />
      </button>
      <button
        className="context-menu-item close-item"
        disabled={!canCloseLeft}
        onClick={() => closeWith('left')}
      >
        <span className="menu-icon">◂</span>
        <Mnemonic label="Close Tabs to the Left" char="L" />
      </button>
      <button
        className="context-menu-item close-item"
        disabled={!canCloseOthers}
        onClick={() => closeWith('others')}
      >
        <span className="menu-icon">⊗</span>
        <Mnemonic label="Close Other Tabs" char="O" />
      </button>
      <div className="context-menu-divider" />
      <button className="context-menu-item" onClick={handleCopyInfo}>
        <span className="menu-icon">📄</span>
        Copy All Info
      </button>
    </div>
  );
};