import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSelector, useDispatch } from 'react-redux';
import { store, RootState } from '../../store';
import { findLeaf, findTabIdByTerminalId } from '../../store/slices/paneTreeOps';
import { setAgentColorScheme, removeAgentColorScheme } from '../../store/slices/settingsSlice';
import { toggleMaximizePane, setPaneMuted } from '../../store/slices/panesSlice';
import { BellIcon } from '../UI/BellIcon';
import { agentSchemeTracker } from '../../services/AgentSchemeTracker';
import { detachPaneToNewWindow } from './dnd/detach';
import { openNewTabWithDefaultProfile, openNewWindow, splitPaneById } from '../../services/paneActions';
import { CopyableInfoRow } from '../UI/CopyableInfoRow';
import { ColorSchemaGrid } from '../UI/ColorSchemaGrid';
import './PaneContextMenu.css';

interface PaneContextMenuProps {
  x: number;
  y: number;
  paneId: string;
  paneName: string;
  terminalId?: string;
  processId?: string;
  onClose: () => void;
}

export const PaneContextMenu: React.FC<PaneContextMenuProps> = ({
  x,
  y,
  paneId,
  paneName,
  terminalId,
  processId,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const dispatch = useDispatch();
  const globalSchemaId = useSelector((s: RootState) => s.settings.colorSchemaId);
  const agentColorSchemes = useSelector((s: RootState) => s.settings.agentColorSchemes);
  const maximizedPaneByTabId = useSelector((s: RootState) => s.panes.maximizedPaneByTabId);
  // Pane ids are unique across tabs, so a value match tells us this pane is the
  // maximized one for its tab (drives the Maximize/Restore label).
  const isMaximized = Object.values(maximizedPaneByTabId).includes(paneId);
  // Mute state: this pane's own flag, plus its owning tab's flag (which
  // overrides). The item toggles the pane flag; the icon shows the effective
  // (tab-or-pane) muted state so it matches the header bell. Each selector is
  // self-contained (resolves the pane/tab itself) so it can't read a stale
  // owningTabId during an intermediate store-notification pass.
  const paneMuted = useSelector((s: RootState) => {
    for (const tid of Object.keys(s.panes.treesByTabId)) {
      const leaf = findLeaf(s.panes.treesByTabId[tid], paneId);
      if (leaf) return !!leaf.notifyMuted;
    }
    return false;
  });
  const tabMuted = useSelector((s: RootState) => {
    if (!terminalId) return false;
    const tid = findTabIdByTerminalId(s.panes.treesByTabId, terminalId);
    return !!(tid && s.tabs.tabs.find(t => t.id === tid)?.notifyMuted);
  });
  const [schemaExpanded, setSchemaExpanded] = useState(false);
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

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

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
    const info = `Pane: ${paneName}\nPane ID: ${paneId}${terminalId ? `\nTerminal ID: ${terminalId}` : ''}${processId ? `\nProcess ID: ${processId}` : ''}`;
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
        <strong>{paneName}</strong>
      </div>
      <div className="context-menu-info">
        <CopyableInfoRow label="Pane ID:" value={paneId} />
        {terminalId && <CopyableInfoRow label="Terminal ID:" value={terminalId} />}
        {processId && <CopyableInfoRow label="Process ID:" value={processId} />}
      </div>
      <div className="context-menu-divider" />
      {agent ? (
        <>
          <button className="context-menu-item" onClick={() => setSchemaExpanded((v) => !v)}>
            <span className="menu-icon">🎨</span>
            Color scheme for “{agent}”
            <span className="context-menu-expand-arrow">{schemaExpanded ? '▾' : '▸'}</span>
          </button>
          {schemaExpanded && (
            <div className="context-menu-subpanel">
              <ColorSchemaGrid
                activeId={agentColorSchemes[agent]}
                defaultSwatchSchemaId={globalSchemaId}
                defaultLabel="Use tab / default"
                onPick={(id) => (id
                  ? dispatch(setAgentColorScheme({ agent, colorSchemaId: id }))
                  : dispatch(removeAgentColorScheme({ agent })))}
              />
            </div>
          )}
        </>
      ) : (
        <button className="context-menu-item" disabled title="No coding agent detected in this pane">
          <span className="menu-icon">🎨</span>
          Color scheme for agent
        </button>
      )}
      <div className="context-menu-divider" />
      <button className="context-menu-item" onClick={() => runAndClose(openNewTabWithDefaultProfile)}>
        <span className="menu-icon">➕</span>
        Open New Tab
      </button>
      <button className="context-menu-item" onClick={() => runAndClose(() => { void openNewWindow(); })}>
        <span className="menu-icon">🪟</span>
        Open New Window
      </button>
      <button className="context-menu-item" onClick={() => runAndClose(() => splitPaneById(paneId, 'vertical', 'after'))}>
        <span className="menu-icon">➡️</span>
        Open New Pane Right
      </button>
      <button className="context-menu-item" onClick={() => runAndClose(() => splitPaneById(paneId, 'vertical', 'before'))}>
        <span className="menu-icon">⬅️</span>
        Open New Pane Left
      </button>
      <button className="context-menu-item" onClick={() => runAndClose(() => splitPaneById(paneId, 'horizontal', 'before'))}>
        <span className="menu-icon">⬆️</span>
        Open New Pane Up
      </button>
      <button className="context-menu-item" onClick={() => runAndClose(() => splitPaneById(paneId, 'horizontal', 'after'))}>
        <span className="menu-icon">⬇️</span>
        Open New Pane Down
      </button>
      <div className="context-menu-divider" />
      <button
        className="context-menu-item"
        onClick={() => runAndClose(() => dispatch(setPaneMuted({ paneId, muted: !paneMuted })))}
        title={tabMuted ? 'This pane is also muted by its tab' : undefined}
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