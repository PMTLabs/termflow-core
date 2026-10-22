import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSelector, useDispatch } from 'react-redux';
import { store, RootState } from '../../store';
import { findLeaf } from '../../store/slices/paneTreeOps';
import { setAgentColorScheme, removeAgentColorScheme } from '../../store/slices/settingsSlice';
import { toggleMaximizePane, setPaneTitleColor } from '../../store/slices/panesSlice';
import { BellIcon } from '../UI/BellIcon';
import { agentSchemeTracker } from '../../services/AgentSchemeTracker';
import { detachPaneToNewWindow } from './dnd/detach';
import { openNewTabWithDefaultProfile, openNewWindow, splitPaneById } from '../../services/paneActions';
import { adminTabSupport, adminTabTooltip } from '../../services/adminTabActions';
import { AdminProfileList } from '../UI/AdminProfileList';
import { CopyableInfoRow } from '../UI/CopyableInfoRow';
import { ColorSchemaGrid } from '../UI/ColorSchemaGrid';
import { SubmenuFlyoutHost } from '../UI/SubmenuFlyoutHost';
import { HOVER_CLOSE_DELAY_MS, SUBMENU_HOVER_OPEN_DELAY_MS } from '../Terminal/ContextMenu';
import { usePaneMuteState } from './usePaneMuteState';
import { getSurfaceChrome, useSurfaceChromeAvailable } from '../../services/surfaceChrome';
import { AutomationMenuSection } from '../Automation/AutomationMenuSection';
import { useTooltipDwell } from '../../hooks/useTooltipDwell';
import { useTerminalTitleColor, titleColorStyle, TAB_NAME_COLORS } from '../../store/titleColor';
import { NewPaneRow } from '../UI/NewPaneRow';
import { broadcastMenuItems } from './broadcastMenuItems';
import './PaneContextMenu.css';

type PaneSubmenuKey = 'schema' | 'color' | 'admin' | 'automation';

interface PaneContextMenuProps {
  x: number;
  y: number;
  paneId: string;
  paneName: string;
  terminalId?: string;
  /** The tab this pane CURRENTLY lives in (`tb-`). Shown as its own labelled
   *  row because it is a separate identity from `terminalId` — before design
   *  014 the two were the same string for a tab's root pane, which is what made
   *  a field labelled "Terminal ID" display a `tb-` value. */
  owningTabId?: string;
  processId?: string;
  onClose: () => void;
}

export const PaneContextMenu: React.FC<PaneContextMenuProps> = ({
  x,
  y,
  paneId,
  paneName,
  terminalId,
  owningTabId,
  processId,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const broadcastState = useSelector((s: RootState) => s.broadcast);
  void broadcastState;
  const dispatch = useDispatch();
  const globalSchemaId = useSelector((s: RootState) => s.settings.colorSchemaId);
  const agentColorSchemes = useSelector((s: RootState) => s.settings.agentColorSchemes);
  const maximizedPaneByTabId = useSelector((s: RootState) => s.panes.maximizedPaneByTabId);
  // Pane ids are unique across tabs, so a value match tells us this pane is the
  // maximized one for its tab (drives the Maximize/Restore label).
  const isMaximized = Object.values(maximizedPaneByTabId).includes(paneId);
  // Mute state — see usePaneMuteState for why this pane/tab selector pair is
  // a shared hook rather than a local copy. The item toggles the pane's own
  // flag; the icon shows the effective (tab-or-pane) muted state so it
  // matches the header bell.
  const { paneMuted, tabMuted, toggle: toggleMute } = usePaneMuteState(paneId, terminalId);
  // The owning tab's colour, for the header that names this pane.
  const paneTitleColor = useTerminalTitleColor(terminalId);
  // Whether this pane's terminal can be searched RIGHT NOW — see the Find item below for why
  // this is a live subscription and why it is a boolean.
  const searchable = useSurfaceChromeAvailable(terminalId ?? null);
  // The three-second tooltip dwell, for the one ENABLED item in this menu that carries a title —
  // see Mute, below. The accordion between them owns its own; a section that renders its own rows
  // owns their tooltips.
  const tip = useTooltipDwell();
  // Flyout submenus (Color scheme / Pane Color / Open admin Tab / Automation), the same model as
  // `TabContextMenu`: a single-slot `openSubmenu`, a hover-open debounce and a hover-close grace,
  // with both delays imported so the menus can only ever agree.
  const [openSubmenu, setOpenSubmenu] = useState<PaneSubmenuKey | null>(null);
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
  const openSubmenuNow = useCallback((key: PaneSubmenuKey) => {
    cancelPendingOpen();
    cancelPendingClose();
    setOpenSubmenu(key);
  }, [cancelPendingClose, cancelPendingOpen]);
  /** Hover — debounced, and idempotent on an already-open parent. */
  const scheduleSubmenuOpen = useCallback((key: PaneSubmenuKey) => {
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

  const currentPaneLeaf = useSelector((s: RootState) =>
    owningTabId ? findLeaf(s.panes.treesByTabId[owningTabId] ?? null, paneId) : null
  );
  const currentPaneColor = currentPaneLeaf?.titleColor;
  const adminSupport = adminTabSupport();
  // The coding agent detected in this pane (codex/claude/…), or null. Seeded
  // synchronously from the tracker, then refreshed once on open so a just-started
  // agent is offered without waiting for the next poll tick.
  const [agent, setAgent] = useState<string | null>(
    terminalId ? agentSchemeTracker.getDetectedAgentForTerminal(terminalId) : null,
  );
  useEffect(() => {
    if (!terminalId) return;
    let cancelled = false;
    void agentSchemeTracker.refreshNow().then(() => {
      if (!cancelled) setAgent(agentSchemeTracker.getDetectedAgentForTerminal(terminalId));
    });
    return () => { cancelled = true; };
  }, [terminalId]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Esc closes an open flyout first, and only closes the whole menu once none is open.
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openSubmenu !== null) {
        e.stopPropagation();
        cancelPendingOpen();
        cancelPendingClose();
        setOpenSubmenu(null);
      } else {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, openSubmenu, cancelPendingOpen, cancelPendingClose]);

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
    const trees = store.getState().panes.treesByTabId;
    let sourceTabId: string | null = null;
    let node = null;
    for (const tid of Object.keys(trees)) {
      const found = findLeaf(trees[tid], paneId);
      if (found) {
        sourceTabId = tid;
        node = found;
        break;
      }
    }
    if (sourceTabId && node) {
      void detachPaneToNewWindow({ sourceTabId, paneNode: node });
    }
    onClose();
  };

  const handleToggleMaximize = () => {
    // Resolve the tab owning this pane so the toggle targets the right tab.
    const trees = store.getState().panes.treesByTabId;
    let owningTabId: string | null = null;
    for (const tid of Object.keys(trees)) {
      if (findLeaf(trees[tid], paneId)) {
        owningTabId = tid;
        break;
      }
    }
    if (owningTabId) {
      dispatch(toggleMaximizePane({ tabId: owningTabId, paneId }));
    }
    onClose();
  };

  const handleCopyInfo = () => {
    const info = [
      `Pane: ${paneName}`,
      `Pane ID: ${paneId}`,
      terminalId && `Terminal ID: ${terminalId}`,
      owningTabId && `Owning Tab ID: ${owningTabId}`,
      processId && `Process ID: ${processId}`,
    ].filter(Boolean).join('\n');
    navigator.clipboard.writeText(info).then(() => {
      console.log('Pane info copied to clipboard');
      onClose();
    }).catch(err => {
      console.error('Failed to copy pane info:', err);
    });
  };

  // Portal to <body> so the menu floats above the panes and isn't clipped by a
  // pane ancestor's `overflow: hidden` / stacking context (keeps it fully visible
  // near window edges).
  return createPortal(
    <div
      ref={menuRef}
      className="pane-context-menu"
      style={{
        left: x,
        top: y,
      }}
    >
      <div className="context-menu-header">
        {/* Names this pane's terminal, so it wears the owning tab's colour like the pane header
            it was opened from. */}
        <strong style={titleColorStyle(paneTitleColor)}>{paneName}</strong>
      </div>
      <div className="context-menu-info">
        <CopyableInfoRow label="Pane ID:" value={paneId} />
        {terminalId && <CopyableInfoRow label="Terminal ID:" value={terminalId} />}
        {owningTabId && <CopyableInfoRow label="Owning Tab ID:" value={owningTabId} />}
        {processId && <CopyableInfoRow label="Process ID:" value={processId} />}
      </div>
      <div className="context-menu-divider" />
      {agent ? (
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
              Color scheme for “{agent}”
              <span className="context-menu-expand-arrow">▸</span>
            </button>
          }
        >
          <ColorSchemaGrid
            activeId={agentColorSchemes[agent]}
            defaultSwatchSchemaId={globalSchemaId}
            defaultLabel="Use tab / default"
            onPick={(id) => (id
              ? dispatch(setAgentColorScheme({ agent, colorSchemaId: id }))
              : dispatch(removeAgentColorScheme({ agent })))}
          />
        </SubmenuFlyoutHost>
      ) : (
        <button
          className="context-menu-item"
          disabled
          title="No coding agent detected in this pane"
          onMouseEnter={scheduleSubmenuClose}
        >
          <span className="menu-icon">🎨</span>
          Color scheme for agent
        </button>
      )}
      <div className="context-menu-divider" />
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
            Pane Color
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
              className={`tab-color-dot${currentPaneColor === hex ? ' active' : ''}`}
              style={{ background: hex }}
              onClick={() => dispatch(setPaneTitleColor({ paneId, titleColor: hex }))}
            />
          ))}
        </div>
        <button
          type="button"
          className="tab-color-reset"
          onClick={() => dispatch(setPaneTitleColor({ paneId, titleColor: undefined }))}
        >
          Reset to Default
        </button>
      </SubmenuFlyoutHost>
      <div className="context-menu-divider" />
      <button
        className="context-menu-item"
        onMouseEnter={scheduleSubmenuClose}
        onClick={() => runAndClose(openNewTabWithDefaultProfile)}
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
        <AdminProfileList variant="menu" onPick={onClose} />
      </SubmenuFlyoutHost>
      <button
        className="context-menu-item"
        onMouseEnter={scheduleSubmenuClose}
        onClick={() => runAndClose(() => { void openNewWindow(); })}
      >
        <span className="menu-icon">🪟</span>
        Open New Window
      </button>
      {broadcastMenuItems(store.getState(), owningTabId, dispatch).map(item => (
        <button key={item.label} className="context-menu-item" disabled={!item.enabled}
          onClick={() => { item.click(); onClose(); }}>
          <span className="menu-icon">{item.icon}</span>
          <span>{item.label}</span>
          {item.accelerator && <span className="context-menu-shortcut">{item.accelerator}</span>}
        </button>
      ))}
      <NewPaneRow
        onSplit={(direction, position) => splitPaneById(paneId, direction, position)}
        onDone={onClose}
        title="Split this pane with a new terminal to its right."
      />
      <div className="context-menu-divider" />
      {/* Find… — `plan/027` R2, the pane-title half.
          This menu reaches nothing per-terminal on its own: every other action here is Redux, a
          store+tree walk, a service function or a poller singleton. It gets ONE new mechanism,
          the registry that already carries `openContextMenu` across the same boundary.

          Availability comes from `useSurfaceChromeAvailable`, which SUBSCRIBES. Reading
          `getSurfaceChrome` at render, as this first did, froze the answer for as long as the
          menu stayed open: still greyed out after the pane's terminal finished starting, still
          enabled after an MCP client closed it — and then silently doing nothing on click.
          Subscribing is affordable only because that hook's snapshot is a BOOLEAN: the chrome
          is republished on nearly every keystroke, and `useSyncExternalStore` re-renders only
          when the value actually flips. `getSurfaceChrome` still does the click, because the
          click needs the state OBJECT and the `?.` covers the gap between render and click.

          Rendered DISABLED rather than hidden when there is no terminal or nothing publishing
          chrome — `terminalId` is genuinely absent for a pane with no terminal — matching the
          “Color scheme for agent” fallback above. An item that looks live and calls nothing is
          worse than one that is visibly unavailable. Each reason gets its OWN title: the
          unpublished-chrome case is a pane still starting, or one whose shell failed
          (`TerminalPane` renders `TerminalDisplay` only when `terminalId && processId`), and it
          is the case that most needs explaining — a greyed item with no tooltip beside a
          disabled sibling that always carries one reads as a bug.

          Grouped with Mute rather than given a divider of its own: both are actions on THIS
          pane's terminal, unlike the tab/window/split items above them. No accelerator, because
          this menu shows none on any item. */}
      <button
        className="context-menu-item"
        disabled={!terminalId || !searchable}
        title={
          !terminalId
            ? 'This pane has no terminal to search'
            : (!searchable ? 'This terminal is not ready to search yet' : undefined)
        }
        onClick={() => runAndClose(() => {
          if (terminalId) getSurfaceChrome(terminalId)?.openSearch();
        })}
      >
        <span className="menu-icon">🔍</span>
        Find…
      </button>
      {/* This terminal's automations: the rules armed on it and the way into each one's editor
          (`plan/028` item D), plus — whether or not anything is armed — creating a new rule for it
          or adding it to an existing rule's targets. Grouped with Find and Mute rather than given
          a section of its own: all three act on this pane's terminal, unlike the tab/window/split
          items above them. Renders nothing only for a pane with no terminal.
          The component is shared verbatim with `CanvasNodeMenu` — see its header. */}
      <AutomationMenuSection
        terminalId={terminalId ?? null}
        onDismiss={onClose}
        flyout={{
          open: openSubmenu === 'automation',
          onTriggerEnter: () => scheduleSubmenuOpen('automation'),
          onTriggerClick: () => openSubmenuNow('automation'),
          onHostEnter: cancelPendingClose,
          onHostLeave: scheduleSubmenuClose,
          openDelayMs: SUBMENU_HOVER_OPEN_DELAY_MS,
          closeDelayMs: HOVER_CLOSE_DELAY_MS,
        }}
      />
      {/* Mute is the only ENABLED item here with a title, so it is the only one the dwell
          applies to. The two disabled items above keep theirs unconditionally and deliberately: a
          disabled button dispatches no mouse events, so a dwell over one could never be measured,
          and for those two the tooltip is the only thing saying why they are dimmed. See
          `useTooltipDwell`. */}
      <button
        className="context-menu-item"
        onClick={() => runAndClose(toggleMute)}
        title={tip.titleFor('mute', tabMuted ? 'This pane is also muted by its tab' : undefined)}
        onMouseEnter={() => tip.onEnter('mute')}
        onMouseLeave={tip.onLeave}
        onFocus={() => tip.onFocus('mute')}
        onBlur={() => tip.onBlur('mute')}
      >
        <span className="menu-icon"><BellIcon muted={tabMuted || paneMuted} /></span>
        {paneMuted ? 'Unmute Pane Notifications' : 'Mute Pane Notifications'}
      </button>
      <div className="context-menu-divider" />
      <button className="context-menu-item" onClick={handleToggleMaximize}>
        <span className="menu-icon">{isMaximized ? '⤡' : '⤢'}</span>
        {isMaximized ? 'Restore Pane' : 'Maximize Pane'}
      </button>
      <div className="context-menu-divider" />
      <button className="context-menu-item" onClick={handleMoveToNewWindow}>
        <span className="menu-icon">⧉</span>
        Move to New Window
      </button>
      <button className="context-menu-item" onClick={handleCopyInfo}>
        <span className="menu-icon">📄</span>
        Copy All Info
      </button>
    </div>,
    document.body
  );
};
