import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit';
import { generateId } from '../../utils/id';
import { removeLeaf, insertByZone, swapLeaves, findLeaf, firstLeafId, EdgeZone } from './paneTreeOps';
import { setInitialCwd } from '../../services/initialCwd';

export interface PaneNode {
  id: string;
  type: 'terminal' | 'split';
  direction?: 'horizontal' | 'vertical';
  size?: number; // percentage
  children?: PaneNode[];
  terminalId?: string;
  name?: string; // Custom name for the pane
  shellType?: string; // Shell type for terminal panes
}

export type DropZone = EdgeZone | 'center';

interface PanesState {
  // Active-tab mirror (kept for backward compatibility with all existing readers).
  paneTree: PaneNode | null;
  activePaneId: string | null;
  // Authoritative per-tab store powering cross-tab / detach moves.
  treesByTabId: Record<string, PaneNode>;
  activeTabId: string | null;
  // Per-tab memory of the last active pane. Lets a tab switch restore focus to
  // the pane the cursor was on before leaving (falls back to the tab's first leaf).
  activePaneByTabId: Record<string, string>;
  // Per-tab maximized (zoomed) pane. A pure rendering overlay — the leaf whose id
  // is stored here fills the whole tab while its siblings stay MOUNTED but hidden.
  // Preserved across tab switches; each tab remembers its own maximize. No pane
  // size/geometry is ever snapshotted, so removing the entry restores the exact
  // prior split from the untouched `size` percentages.
  maximizedPaneByTabId: Record<string, string>;
}

const initialState: PanesState = {
  paneTree: null,
  activePaneId: null,
  treesByTabId: {},
  activeTabId: null,
  activePaneByTabId: {},
  maximizedPaneByTabId: {},
};

/**
 * Mirror the active-tab `paneTree` into `treesByTabId[activeTabId]` so the
 * authoritative store stays in sync after the legacy reducers mutate paneTree.
 */
function syncActive(state: PanesState): void {
  if (!state.activeTabId) return;
  if (state.paneTree) {
    state.treesByTabId[state.activeTabId] = state.paneTree;
  } else {
    delete state.treesByTabId[state.activeTabId];
  }
}

/**
 * Split the terminal leaf `paneId` inside `tree` (mutated in place) into a
 * [original, new] split. Returns the new pane's id, or null if `paneId` was
 * not found as a terminal leaf. Shared by `splitPane` (active tab) and
 * `splitPaneInTab` (any tab).
 */
function splitLeafInTree(
  tree: PaneNode,
  paneId: string,
  opts: { direction: 'horizontal' | 'vertical'; shellType?: string; name?: string; terminalId?: string },
): string | null {
  const { direction, shellType, name, terminalId } = opts;
  const recurse = (node: PaneNode): string | null => {
    if (node.id === paneId && node.type === 'terminal') {
      const newPaneId = generateId('pn');
      const newTerminalId = terminalId || generateId('tm');
      const newPane: PaneNode = {
        id: newPaneId,
        type: 'terminal',
        terminalId: newTerminalId,
        name: name || `Terminal ${direction === 'horizontal' ? 'Bottom' : 'Right'}`,
        shellType,
      };
      const originalPane: PaneNode = {
        id: generateId('pn'),
        type: 'terminal',
        terminalId: node.terminalId,
        name: node.name || `Terminal ${direction === 'horizontal' ? 'Top' : 'Left'}`,
        shellType: node.shellType,
      };
      node.type = 'split';
      node.direction = direction;
      node.size = 50;
      node.children = [originalPane, newPane];
      delete node.terminalId;
      delete node.shellType;
      return newPaneId;
    }
    if (node.type === 'split' && node.children) {
      for (const child of node.children) {
        const id = recurse(child);
        if (id) return id;
      }
    }
    return null;
  };
  return recurse(tree);
}

// Thunk for splitting panes
export const splitPaneWithTab = createAsyncThunk(
  'panes/splitPaneWithTab',
  async (
    { paneId, direction, shellType = 'default', name, cwd }:
      { paneId: string; direction: 'horizontal' | 'vertical'; shellType?: string; name?: string; cwd?: string }
  ) => {

    // Create new terminal ID for the new pane.
    // Layout convention: a 'horizontal' split stacks panes top/bottom; a
    // 'vertical' split places them left/right. Name the panes accordingly.
    const newTerminalId = generateId('tm');
    const uniqueTitle = name || `Terminal ${direction === 'horizontal' ? 'Bottom' : 'Right'}`;
    const uniqueOriginalTitle = `Terminal ${direction === 'horizontal' ? 'Top' : 'Left'}`;

    // Backlog 004: stash the inherited cwd for the new pane's first spawn. Kept in
    // a transient registry (NOT the pane tree) so detach/restore payloads stay clean.
    if (cwd) setInitialCwd(newTerminalId, cwd);

    // Note: We don't create a tab here - the terminal will be created when TerminalPane mounts
    // The pane split will happen in the reducer

    // Return data for the reducer
    return { paneId, direction, shellType, newTerminalId, uniqueTitle, uniqueOriginalTitle };
  }
);

const panesSlice = createSlice({
  name: 'panes',
  initialState,
  reducers: {
    initializePane: (state, action: PayloadAction<{ terminalId: string; name?: string }>) => {
      const paneId = generateId('pn');
      state.paneTree = {
        id: paneId,
        type: 'terminal',
        terminalId: action.payload.terminalId,
        name: action.payload.name,
      };
      state.activePaneId = paneId;
      syncActive(state);
    },

    splitPane: (state, action: PayloadAction<{ paneId: string; direction: 'horizontal' | 'vertical'; shellType?: string; name?: string; terminalId?: string }>) => {
      const { paneId, direction, shellType, name, terminalId } = action.payload;

      if (!state.paneTree) {
        return;
      }

      const newPaneId = splitLeafInTree(state.paneTree, paneId, { direction, shellType, name, terminalId });
      if (newPaneId) {
        // Set the new pane as active.
        state.activePaneId = newPaneId;
        // Splitting the maximized pane reshapes the tab — exit maximize so the new
        // split is visible (the flag would otherwise point at a now-split node id).
        if (state.activeTabId) delete state.maximizedPaneByTabId[state.activeTabId];
      }
      syncActive(state);
    },

    splitPaneInTab: (state, action: PayloadAction<{ tabId: string; paneId?: string; direction: 'horizontal' | 'vertical'; shellType?: string; name?: string; terminalId?: string }>) => {
      const { tabId, paneId, direction, shellType, name, terminalId } = action.payload;
      const tree = state.treesByTabId[tabId] ?? null;
      const hasTerminal = !!firstLeafId(tree);

      if (!tree || !hasTerminal) {
        // Tab has no terminal-bearing tree yet — seed a single terminal pane.
        const pn = generateId('pn');
        const seeded: PaneNode = {
          id: pn,
          type: 'terminal',
          terminalId: terminalId || generateId('tm'),
          name: name || 'Terminal',
          shellType,
        };
        state.treesByTabId[tabId] = seeded;
        state.activePaneByTabId[tabId] = pn;
      } else {
        // Split the requested pane. If the caller passed a paneId that no longer
        // exists in this tab (e.g. a stale id from the API), fall back to the
        // tab's first leaf so the requested terminal is still added rather than
        // silently dropped (which would make the API report a misleading success).
        const target = (paneId && findLeaf(tree, paneId)) ? paneId : firstLeafId(tree)!;
        const newPaneId = splitLeafInTree(tree, target, { direction, shellType, name, terminalId });
        if (newPaneId) {
          state.activePaneByTabId[tabId] = newPaneId;
          // Splitting reshapes the tab — exit maximize (avoid a stale split-node id).
          delete state.maximizedPaneByTabId[tabId];
        }
      }

      // Mirror into the active-tab view ONLY when this tab is the one on screen,
      // so a split into a background tab never changes the user's focus.
      if (state.activeTabId === tabId) {
        state.paneTree = state.treesByTabId[tabId];
        state.activePaneId = state.activePaneByTabId[tabId] ?? state.activePaneId;
      }
    },

    /**
     * Toggle the maximized (zoomed) pane for a tab. If `paneId` is already the
     * tab's maximized pane → clear it (restore the split); otherwise mark it as
     * maximized. Purely a rendering flag — never touches the tree or sizes.
     */
    toggleMaximizePane: (state, action: PayloadAction<{ tabId: string; paneId: string }>) => {
      const { tabId, paneId } = action.payload;
      if (state.maximizedPaneByTabId[tabId] === paneId) {
        delete state.maximizedPaneByTabId[tabId];
      } else {
        state.maximizedPaneByTabId[tabId] = paneId;
      }
    },

    closePane: (state, action: PayloadAction<string>) => {
      const paneId = action.payload;

      if (!state.paneTree) return;

      // If the closed pane was this (active) tab's maximized pane, drop the
      // maximize flag so the tab falls back to a normal split of what remains.
      if (state.activeTabId && state.maximizedPaneByTabId[state.activeTabId] === paneId) {
        delete state.maximizedPaneByTabId[state.activeTabId];
      }

      // If closing the root pane, clear everything
      if (state.paneTree.id === paneId) {
        state.paneTree = null;
        state.activePaneId = null;
        syncActive(state);
        return;
      }
      
      const removePane = (node: PaneNode, parent: PaneNode | null): boolean => {
        if (node.type === 'split' && node.children) {
          for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            
            if (child.id === paneId) {
              // Remove the child
              node.children.splice(i, 1);
              
              // If only one child remains, replace this split with the remaining child
              if (node.children.length === 1) {
                const remainingChild = node.children[0];
                if (parent && parent.children) {
                  const nodeIndex = parent.children.indexOf(node);
                  parent.children[nodeIndex] = remainingChild;
                } else {
                  // This is the root node
                  state.paneTree = remainingChild;
                }
              }
              
              // Update active pane if needed
              if (state.activePaneId === paneId) {
                state.activePaneId = node.children[0]?.id || null;
              }
              
              return true;
            }
            
            if (removePane(child, node)) return true;
          }
        }
        
        return false;
      };

      removePane(state.paneTree, null);
      syncActive(state);
    },

    resizePane: (state, action: PayloadAction<{ paneId: string; size: number }>) => {
      const { paneId, size } = action.payload;
      
      if (!state.paneTree) return;
      
      const findAndResizePane = (node: PaneNode): boolean => {
        if (node.id === paneId && node.type === 'split') {
          node.size = Math.max(10, Math.min(90, size)); // Clamp between 10% and 90%
          return true;
        }
        
        if (node.type === 'split' && node.children) {
          for (const child of node.children) {
            if (findAndResizePane(child)) return true;
          }
        }
        
        return false;
      };
      
      findAndResizePane(state.paneTree);
      syncActive(state);
    },

    focusPane: (state, action: PayloadAction<string>) => {
      state.activePaneId = action.payload;
    },

    renamePanes: (state, action: PayloadAction<{ paneId: string; name: string }>) => {
      const { paneId, name } = action.payload;
      
      if (!state.paneTree) return;
      
      const findAndRenamePane = (node: PaneNode): boolean => {
        if (node.id === paneId) {
          node.name = name;
          return true;
        }
        
        if (node.type === 'split' && node.children) {
          for (const child of node.children) {
            if (findAndRenamePane(child)) return true;
          }
        }
        
        return false;
      };
      
      findAndRenamePane(state.paneTree);
      syncActive(state);
    },

    setPaneTree: (state, action: PayloadAction<PaneNode | null>) => {
      state.paneTree = action.payload;
      syncActive(state);
    },

    /** Set the active tab and mirror its authoritative tree into `paneTree`. */
    setActiveTabId: (state, action: PayloadAction<string | null>) => {
      const nextTabId = action.payload;

      // Remember where the cursor was in the tab we're leaving, so returning to
      // it restores focus to the same pane.
      const prevTabId = state.activeTabId;
      if (prevTabId && state.activePaneId) {
        state.activePaneByTabId[prevTabId] = state.activePaneId;
      }

      state.activeTabId = nextTabId;
      state.paneTree = nextTabId ? state.treesByTabId[nextTabId] ?? null : null;

      // Restore the entering tab's remembered active pane (if it still exists),
      // else fall back to its first terminal leaf.
      const remembered = nextTabId ? state.activePaneByTabId[nextTabId] : undefined;
      state.activePaneId =
        remembered && findLeaf(state.paneTree, remembered)
          ? remembered
          : firstLeafId(state.paneTree);
    },

    /** Store/overwrite a tab's authoritative tree (background or active). */
    addTabTree: (state, action: PayloadAction<{ tabId: string; tree: PaneNode }>) => {
      const { tabId, tree } = action.payload;
      state.treesByTabId[tabId] = tree;
      if (state.activeTabId === tabId) state.paneTree = tree;
    },

    /**
     * Insert an externally-supplied pane node (from another window) into a tab's
     * tree at a target pane/zone. Used by cross-window drops. `center` is treated
     * as a right-insert (no swap semantics across windows).
     */
    insertPaneIntoTab: (
      state,
      action: PayloadAction<{ tabId: string; targetPaneId: string; zone: DropZone; node: PaneNode }>,
    ) => {
      const { tabId, targetPaneId, zone, node } = action.payload;
      const tree = state.treesByTabId[tabId];
      if (!tree) return;
      const edge: EdgeZone = zone === 'center' ? 'right' : zone;
      const next = insertByZone(tree, targetPaneId, node, edge);
      state.treesByTabId[tabId] = next;
      if (state.activeTabId === tabId) state.paneTree = next;
      state.activePaneId = node.id;
      state.activePaneByTabId[tabId] = node.id;
      // A newly inserted pane must be visible — drop any maximize on this tab.
      delete state.maximizedPaneByTabId[tabId];
    },

    /** Remove a single pane from a tab without touching its PTY (used by detach). */
    removePaneFromTab: (state, action: PayloadAction<{ tabId: string; paneId: string }>) => {
      const { tabId, paneId } = action.payload;
      const tree = state.treesByTabId[tabId];
      if (!tree) return;
      // Removing the maximized pane clears the tab's maximize flag (no dangling id).
      if (state.maximizedPaneByTabId[tabId] === paneId) {
        delete state.maximizedPaneByTabId[tabId];
      }
      const { tree: pruned } = removeLeaf(tree, paneId);
      if (pruned === null) {
        delete state.treesByTabId[tabId];
      } else {
        state.treesByTabId[tabId] = pruned;
      }
      // Only the active tab owns paneTree/activePaneId; fix them if its active pane vanished.
      if (state.activeTabId === tabId) {
        state.paneTree = pruned;
        if (state.activePaneId && (pruned === null || !findLeaf(pruned, state.activePaneId))) {
          state.activePaneId = firstLeafId(pruned);
        }
      }
    },

    /** Drop a tab's tree entirely (e.g. tab closed). */
    removeTabTree: (state, action: PayloadAction<string>) => {
      const tabId = action.payload;
      delete state.treesByTabId[tabId];
      delete state.activePaneByTabId[tabId];
      delete state.maximizedPaneByTabId[tabId];
      if (state.activeTabId === tabId) {
        state.paneTree = null;
        state.activePaneId = null;
      }
    },

    /** Move a pane within a single tab via an edge-zone drop (or center swap). */
    movePaneWithinTab: (
      state,
      action: PayloadAction<{ tabId: string; sourcePaneId: string; targetPaneId: string; zone: DropZone }>,
    ) => {
      const { tabId, sourcePaneId, targetPaneId, zone } = action.payload;
      if (sourcePaneId === targetPaneId) return;
      const tree = state.treesByTabId[tabId];
      if (!tree) return;

      let next: PaneNode;
      if (zone === 'center') {
        next = swapLeaves(tree, sourcePaneId, targetPaneId);
        state.activePaneId = targetPaneId;
      } else {
        const { tree: pruned, removed } = removeLeaf(tree, sourcePaneId);
        if (!removed || !pruned) return;
        next = insertByZone(pruned, targetPaneId, removed, zone);
        state.activePaneId = sourcePaneId;
      }

      state.treesByTabId[tabId] = next;
      if (state.activeTabId === tabId) state.paneTree = next;
    },

    /** Move a pane from one tab into another tab's layout. */
    movePaneToTab: (
      state,
      action: PayloadAction<{
        sourceTabId: string;
        sourcePaneId: string;
        targetTabId: string;
        targetPaneId: string;
        zone: DropZone;
      }>,
    ) => {
      const { sourceTabId, sourcePaneId, targetTabId, targetPaneId, zone } = action.payload;
      if (sourceTabId === targetTabId) return;
      const srcTree = state.treesByTabId[sourceTabId];
      const dstTree = state.treesByTabId[targetTabId];
      if (!srcTree || !dstTree) return;

      const { tree: prunedSrc, removed } = removeLeaf(srcTree, sourcePaneId);
      if (!removed) return;

      // Cross-tab "center" has no swap semantics; treat it as an insert to the right.
      const edge: EdgeZone = zone === 'center' ? 'right' : zone;
      const newDst = insertByZone(dstTree, targetPaneId, removed, edge);

      if (prunedSrc === null) {
        delete state.treesByTabId[sourceTabId];
      } else {
        state.treesByTabId[sourceTabId] = prunedSrc;
      }
      state.treesByTabId[targetTabId] = newDst;

      // Moving a pane out clears a dangling maximize on the source tab; the
      // moved-in pane must be visible, so drop any maximize on the target tab.
      if (state.maximizedPaneByTabId[sourceTabId] === sourcePaneId) {
        delete state.maximizedPaneByTabId[sourceTabId];
      }
      delete state.maximizedPaneByTabId[targetTabId];

      // Follow the moved pane: target tab becomes active.
      state.activeTabId = targetTabId;
      state.paneTree = newDst;
      state.activePaneId = sourcePaneId;
      state.activePaneByTabId[targetTabId] = sourcePaneId;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(splitPaneWithTab.fulfilled, (state, action) => {
      const { paneId, direction, shellType, newTerminalId, uniqueTitle, uniqueOriginalTitle } = action.payload;
      
      if (!state.paneTree) return;
      
      const findAndSplitPane = (node: PaneNode): boolean => {
        if (node.id === paneId && node.type === 'terminal') {
          // Create new terminal pane
          const newPaneId = generateId('pn');
          
          const newPane: PaneNode = {
            id: newPaneId,
            type: 'terminal',
            terminalId: newTerminalId,
            name: uniqueTitle,
            shellType: shellType,
          };
          
          // Convert current terminal pane to split pane
          const originalPane: PaneNode = {
            id: generateId('pn'),
            type: 'terminal',
            terminalId: node.terminalId,
            name: node.name || uniqueOriginalTitle,
          };
          
          node.type = 'split';
          node.direction = direction;
          node.size = 50;
          node.children = [originalPane, newPane];
          delete node.terminalId;
          
          // Set the new pane as active
          state.activePaneId = newPaneId;
          // Splitting the maximized pane reshapes the tab — exit maximize so the new
          // split is visible (the flag would otherwise point at a now-split node id).
          if (state.activeTabId) delete state.maximizedPaneByTabId[state.activeTabId];

          return true;
        }
        
        if (node.type === 'split' && node.children) {
          for (const child of node.children) {
            if (findAndSplitPane(child)) return true;
          }
        }
        
        return false;
      };

      findAndSplitPane(state.paneTree);
      syncActive(state);
    });
  },
});

export const {
  initializePane,
  splitPane,
  splitPaneInTab,
  toggleMaximizePane,
  closePane,
  resizePane,
  focusPane,
  renamePanes,
  setPaneTree,
  setActiveTabId,
  addTabTree,
  removeTabTree,
  removePaneFromTab,
  insertPaneIntoTab,
  movePaneWithinTab,
  movePaneToTab,
} = panesSlice.actions;

export default panesSlice.reducer;