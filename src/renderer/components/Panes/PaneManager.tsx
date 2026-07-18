import React, { useCallback, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState, AppDispatch } from '../../store';
import {
  closePane,
  resizePane,
  focusPane,
  toggleMaximizePane,
  PaneNode
} from '../../store/slices/panesSlice';
import { splitPaneById } from '../../services/paneActions';
import { SplitPane } from './SplitPane';
import { TerminalPane } from './TerminalPane';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import { terminalService } from '../../services/TerminalService';
import { clearCwdSnapshot } from '../../services/cwdSnapshot';
import { closePaneNonBlocking } from '../../services/paneClose';
import './PaneManager.css';

interface PaneManagerProps {
  className?: string;
  paneTree?: PaneNode | null;
  activePaneId?: string | null;
  isTabActive?: boolean;
  // This tab's id (needed to dispatch a maximize toggle at the right tab) and its
  // maximized leaf id, both supplied by TerminalContainer.
  tabId?: string;
  maximizedPaneId?: string | null;
}

// True if `node` is the leaf with `paneId`, or any descendant subtree contains it.
// Lets each split on the ancestor path collapse toward the maximized leaf.
function subtreeContainsLeaf(node: PaneNode, paneId: string): boolean {
  if (node.id === paneId) return true;
  if (node.type === 'split' && node.children) {
    return node.children.some(child => subtreeContainsLeaf(child, paneId));
  }
  return false;
}

export const PaneManager: React.FC<PaneManagerProps> = ({
  className,
  paneTree: propsPaneTree,
  activePaneId: propsActivePaneId,
  isTabActive = true,
  tabId,
  maximizedPaneId = null
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const reduxPanes = useSelector((state: RootState) => state.panes);

  const paneTree = propsPaneTree !== undefined ? propsPaneTree : reduxPanes.paneTree;
  const activePaneId = propsActivePaneId !== undefined ? propsActivePaneId : reduxPanes.activePaneId;

  // Pane pending close confirmation (mirrors the tab-close confirm flow).
  const [pendingClosePaneId, setPendingClosePaneId] = React.useState<string | null>(null);

  const handleSplit = useCallback((paneId: string, direction: 'horizontal' | 'vertical') => {
    // Centralised in paneActions so the split buttons and the right-click menu
    // behave identically — including backlog 004 cwd inheritance (resolved there,
    // using the user's configured default shell profile for the new pane).
    void splitPaneById(paneId, direction);
  }, []);

  // Request close: show the confirmation dialog instead of closing immediately.
  const handleClose = useCallback((paneId: string) => {
    setPendingClosePaneId(paneId);
  }, []);

  // Spec 045 §3.4: Ctrl+Shift+W asks for a close; the dialog below confirms it,
  // exactly as the pane's (x) button does. PaneManager is mounted per tab
  // (TerminalContainer.tsx:162), so every tab's listener fires — the tree guard
  // ensures only the owning tab responds.
  useEffect(() => {
    const onRequest = (e: Event) => {
      const paneId = (e as CustomEvent).detail?.paneId;
      if (!paneId || !paneTree) return;
      const inThisTree = (node: PaneNode): boolean =>
        node.id === paneId || (node.children?.some(inThisTree) ?? false);
      if (inThisTree(paneTree)) handleClose(paneId);
    };
    window.addEventListener('ui:requestPaneClose', onRequest);
    return () => window.removeEventListener('ui:requestPaneClose', onRequest);
  }, [handleClose, paneTree]);

  // Non-blocking close (P0 — Faster Pane Close): the pane must disappear from
  // the UI immediately on confirm, so the backend PTY teardown (a multi-second
  // await) must never gate it. Ordering is encoded in the pure helper —
  // performClose only resolves the terminalId and supplies real deps.
  const performClose = useCallback((paneId: string) => {
    // Find the terminal ID for this pane
    const findTerminalId = (node: PaneNode): string | null => {
      if (node.id === paneId && node.type === 'terminal') {
        return node.terminalId || null;
      }
      if (node.type === 'split' && node.children) {
        for (const child of node.children) {
          const terminalId = findTerminalId(child);
          if (terminalId) return terminalId;
        }
      }
      return null;
    };

    const terminalId = paneTree ? findTerminalId(paneTree) : null;

    closePaneNonBlocking({
      terminalId,
      removeFromUi: () => dispatch(closePane(paneId)),
      closeTerminal: (id) => terminalService.closeTerminal(id),
      clearCwdSnapshot,
    });
  }, [dispatch, paneTree]);

  const handleResize = useCallback((paneId: string, size: number) => {
    dispatch(resizePane({ paneId, size }));
  }, [dispatch]);

  const handleFocus = useCallback((paneId: string) => {
    dispatch(focusPane(paneId));
  }, [dispatch]);

  const handleToggleMaximize = useCallback((paneId: string) => {
    if (tabId) {
      dispatch(toggleMaximizePane({ tabId, paneId }));
    }
  }, [dispatch, tabId]);

  // `isRoot` is true only for the top-level node. A solo terminal (the tab has a
  // single pane) is exactly the case where that root node is itself a terminal —
  // splits always have 2 children, so any nested terminal has siblings. We pass
  // `solo` down so the pane can auto-hide its header (revealed on hover).
  const renderPane = useCallback((node: PaneNode, isRoot = false): React.ReactElement => {
    if (node.type === 'terminal') {
      return (
        <TerminalPane
          key={node.id}
          paneId={node.id}
          terminalId={node.terminalId}
          isActive={node.id === activePaneId}
          isTabActive={isTabActive}
          solo={isRoot}
          maximized={node.id === maximizedPaneId}
          onSplit={(direction) => handleSplit(node.id, direction)}
          onClose={() => handleClose(node.id)}
          onFocus={() => handleFocus(node.id)}
          onToggleMaximize={() => handleToggleMaximize(node.id)}
          name={node.name}
          shellType={node.shellType}
        />
      );
    }

    // Split pane - must have exactly 2 children
    if (!node.children || node.children.length !== 2) {
      return <div key={node.id}>Invalid split pane configuration</div>;
    }

    // Collapse this split toward the maximized leaf: 0 if it lives in child0's
    // subtree, 1 if in child1's, else null (normal split — also the defensive
    // self-heal path when the maximized id isn't in this tree at all).
    const maximizedChild: 0 | 1 | null = maximizedPaneId
      ? (subtreeContainsLeaf(node.children[0], maximizedPaneId)
          ? 0
          : subtreeContainsLeaf(node.children[1], maximizedPaneId)
            ? 1
            : null)
      : null;

    return (
      <SplitPane
        key={node.id}
        split={node.direction === 'horizontal' ? 'horizontal' : 'vertical'}
        size={node.size || 50}
        maximizedChild={maximizedChild}
        onDragFinished={(size) => handleResize(node.id, size)}
      >
        {[renderPane(node.children[0]), renderPane(node.children[1])]}
      </SplitPane>
    );
  }, [activePaneId, maximizedPaneId, handleSplit, handleClose, handleFocus, handleResize, handleToggleMaximize, isTabActive]);

  // Resolve a friendly name for the pane awaiting close confirmation.
  const findPaneName = (node: PaneNode | null, paneId: string): string | null => {
    if (!node) return null;
    if (node.id === paneId) return node.name || null;
    if (node.children) {
      for (const child of node.children) {
        const found = findPaneName(child, paneId);
        if (found) return found;
      }
    }
    return null;
  };

  const pendingPaneName = pendingClosePaneId ? findPaneName(paneTree, pendingClosePaneId) : null;

  return (
    <div className={`pane-manager ${className || ''}`}>
      {paneTree && renderPane(paneTree, true)}

      <ConfirmDialog
        isOpen={pendingClosePaneId !== null}
        title="Close Pane"
        message={`Are you sure you want to close "${pendingPaneName || 'this pane'}"? Any running process will be terminated.`}
        onConfirm={() => {
          if (pendingClosePaneId) performClose(pendingClosePaneId);
          setPendingClosePaneId(null);
        }}
        onCancel={() => setPendingClosePaneId(null)}
        destructive
        confirmText="Close Pane"
        confirmMnemonic="C"
        cancelText="Cancel"
        cancelMnemonic="A"
      />
    </div>
  );
};

// Helper functions for keyboard navigation
export function navigatePane(
  currentPaneId: string,
  direction: 'up' | 'down' | 'left' | 'right',
  paneTree: PaneNode
): string | null {
  const allPanes = collectAllPanes(paneTree);
  const currentPane = allPanes.find(p => p.id === currentPaneId);
  
  if (!currentPane) return null;

  // Find the best candidate pane in the given direction
  let bestCandidate: PaneNode | null = null;
  let bestDistance = Infinity;

  for (const pane of allPanes) {
    if (pane.id === currentPaneId || pane.type !== 'terminal') continue;

    const distance = calculateDistance(currentPane, pane, direction);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = pane;
    }
  }

  return bestCandidate?.id || null;
}

function collectAllPanes(node: PaneNode): PaneNode[] {
  if (node.type === 'terminal') {
    return [node];
  }
  
  const panes: PaneNode[] = [node];
  if (node.children) {
    for (const child of node.children) {
      panes.push(...collectAllPanes(child));
    }
  }
  
  return panes;
}

function calculateDistance(
  _from: PaneNode,
  _to: PaneNode,
  _direction: 'up' | 'down' | 'left' | 'right'
): number {
  // This is a simplified distance calculation
  // In a real implementation, you'd need to consider the actual positions
  // of panes based on their layout in the tree
  return 1; // Placeholder
}