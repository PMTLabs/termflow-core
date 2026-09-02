import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit';
import { generateId } from '../../utils/id';
import { removeLeaf, insertByZone, swapLeaves, findLeaf, firstLeafId, terminalIdentityOf, EdgeZone } from './paneTreeOps';
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
  // Per-pane notification mute. undefined/false = notifications behave normally;
  // true = this pane's terminal activity never rings the bell / toast / OS
  // notification (see RunningActivityTracker). Lives ON the node so it survives
  // tree serialization (persist across restart) and is dropped automatically
  // when the pane is closed — no orphaned side-state. A tab-level mute
  // (tabsSlice) overrides this and suppresses every pane regardless.
  notifyMuted?: boolean;
  /** The pty-host session key, when it differs from `terminalId`.
   *
   *  `undefined` means "same as `terminalId`", which is the case for every pane
   *  created on this build. It is set only by the pre-014 migration, where the
   *  leaf becomes a fresh `tm-` but the host still knows the session by its old
   *  `tb-` id — renaming it there would orphan an armed session, because the
   *  pty-host protocol has no rename verb (design 014 §A2). */
  sessionKey?: string;
  /** The tab this pane was seeded for.
   *
   *  Recorded because design 014 removed the equality `root leaf === tab.id`,
   *  which `tabTreeSeed.claimsItsOwnId` used as its ownership tiebreak when the
   *  same terminal appears in two tabs' persisted mirrors. Without an explicit
   *  owner that repair degrades to `tabs` order — a coin-flip, and the exact
   *  non-determinism that function exists to remove. Legacy trees have no value
   *  here and fall back to the id equality. */
  seededForTabId?: string;
}

export type DropZone = EdgeZone | 'center';

interface PanesState {
  // Active-tab mirror (kept for backward compatibility with all existing readers).
  paneTree: PaneNode | null;
  activePaneId: string | null;
  // Authoritative per-tab store powering cross-tab / detach moves.
  //
  // Three states, and the difference between the last two is load-bearing:
  //   - key absent  → this tab has never been given a tree. TerminalContainer seeds one.
  //   - value null  → the tab is OPEN and EMPTY. Every terminal it had was moved elsewhere.
  //   - a PaneNode  → the tab's layout.
  //
  // `null` used to be expressed by DELETING the key, which made "emptied" and "never
  // initialised" the same state — and TerminalContainer's seed effect, which exists for the
  // second, therefore fired for the first. It manufactured a fresh root leaf carrying the
  // tab's own id and so RESURRECTED the terminal that had just been dragged into another
  // group, leaving one terminal in two groups at once. Arrange then placed the node in the
  // last group claiming it and shrink-wrapped the other group's frame across the whole
  // canvas. Design 010 §6.3 calls an emptied tab "already a legal state"; this is what
  // makes that true.
  treesByTabId: Record<string, PaneNode | null>;
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

/** Percentage a keyboard resize (Alt+Shift+Arrow) moves a split divider per press. */
const PANE_RESIZE_STEP = 5;

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
    return;
  }
  // An emptied tab keeps its KEY, holding null — exactly as `removePaneFromTab` does.
  // Deleting it said "never initialised", which is the state TerminalContainer's seed net
  // exists to fill, so closing an active tab's last pane through the legacy path
  // resurrected the terminal it had just closed.
  //
  // Only ever DOWNGRADE an entry that already exists. A virtual tab (canvas, settings) is
  // active with no tree of its own, and minting a null key for it would hand the canvas a
  // phantom group frame for itself.
  if (state.activeTabId in state.treesByTabId) {
    state.treesByTabId[state.activeTabId] = null;
  }
}

/**
 * The leaf that KEEPS an existing terminal when its pane is split.
 *
 * **Shared because there are two split implementations and they drifted.** A split
 * turns the original leaf node into a `split` container, so the terminal it held has
 * to be re-homed onto a fresh child node — and every field that describes the
 * TERMINAL (rather than the pane's position) must come with it. `splitLeafInTree`
 * below carried them; `splitPaneWithTab.fulfilled` — the reducer behind the pane
 * split BUTTONS, i.e. how a user actually splits — carried only `notifyMuted`, so an
 * ordinary UI split silently stripped both identity fields.
 *
 * What each field costs if dropped:
 * - `seededForTabId` — after design 014 no leaf carries its tab's id, so this is the
 *   ONLY record that a tab owns its terminals. Lose it and `tabTreeSeed.claimsItsOwnId`
 *   returns false for that tab forever: the duplicate-leaf tiebreak degrades to `tabs`
 *   order, and `planSeeds` Rule 3 stops recognising the tab as one that was emptied —
 *   which is the resurrection bug (design 010 §6.3) reached by another route.
 * - `sessionKey` — orphans a migrated pane's armed pty-host session (design 014 §A2).
 * - `notifyMuted` — a muted pane silently unmutes itself when split.
 *
 * Both callers must go through here. `panesSlice.test.ts` runs one table over every
 * split entry point so a third cannot quietly grow its own copy.
 */
function survivingLeaf(node: PaneNode, fallbackName: string): PaneNode {
  return {
    id: generateId('pn'),
    type: 'terminal',
    // Built from the ONE list rather than re-typed here — see TERMINAL_BOUND_FIELDS.
    ...terminalIdentityOf(node),
    name: node.name || fallbackName,
  };
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
      const originalPane = survivingLeaf(
        node,
        node.name || `Terminal ${direction === 'horizontal' ? 'Top' : 'Left'}`,
      );
      node.type = 'split';
      node.direction = direction;
      node.size = 50;
      node.children = [originalPane, newPane];
      delete node.terminalId;
      delete node.shellType;
      // The node is now a split container, not a terminal leaf — drop the flag so
      // it isn't stranded where no tracker/UI lookup would ever read it.
      delete node.notifyMuted;
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
    { paneId, direction, position = 'after', shellType = 'default', name, cwd }:
      { paneId: string; direction: 'horizontal' | 'vertical'; position?: 'before' | 'after'; shellType?: string; name?: string; cwd?: string }
  ) => {

    // Create new terminal ID for the new pane.
    // Layout convention: a 'horizontal' split stacks panes top/bottom; a
    // 'vertical' split places them left/right. `position` says which side of the
    // original the NEW pane lands on ('before' = top/left, 'after' = bottom/right).
    // Name the panes accordingly.
    const newTerminalId = generateId('tm');
    const [firstLabel, secondLabel] = direction === 'horizontal' ? ['Top', 'Bottom'] : ['Left', 'Right'];
    const uniqueTitle = name || `Terminal ${position === 'before' ? firstLabel : secondLabel}`;
    const uniqueOriginalTitle = `Terminal ${position === 'before' ? secondLabel : firstLabel}`;

    // Backlog 004: stash the inherited cwd for the new pane's first spawn. Kept in
    // a transient registry (NOT the pane tree) so detach/restore payloads stay clean.
    if (cwd) setInitialCwd(newTerminalId, cwd);

    // Note: We don't create a tab here - the terminal will be created when TerminalPane mounts
    // The pane split will happen in the reducer

    // Return data for the reducer
    return { paneId, direction, position, shellType, newTerminalId, uniqueTitle, uniqueOriginalTitle };
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

    /**
     * SET (not toggle) a tab's maximized pane — `paneId: null` clears it.
     *
     * A restore must never use `toggleMaximizePane`: it is idempotent only from
     * a known-empty starting state. Restoring `maximizedPaneByTabId[t] = p`
     * onto a tab whose pane `p` is ALREADY maximized makes the toggle delete
     * the entry, i.e. the restore un-maximizes exactly the pane it was asked to
     * maximize (plan/025 §2.4 — the tab-scoped load never runs `resetPanes`, so
     * it has no empty starting state to rely on).
     *
     * The safety of a toggle here can only ever be argued from what the CALLER
     * did first, which is precisely the kind of guarantee the next caller opts
     * out of without noticing. This reducer needs no such argument.
     */
    setMaximizedPane: (state, action: PayloadAction<{ tabId: string; paneId: string | null }>) => {
      const { tabId, paneId } = action.payload;
      if (paneId === null) delete state.maximizedPaneByTabId[tabId];
      else state.maximizedPaneByTabId[tabId] = paneId;
    },

    /**
     * Toggle (set/clear) a single pane's notification mute. Finds the leaf by
     * `paneId` across all tabs' trees and sets/deletes its `notifyMuted` flag.
     * Mutating the node in `treesByTabId` also updates the active tab's
     * `paneTree` mirror (they share the same object graph). Only affects THIS
     * pane — tab-level mute is handled separately in tabsSlice.
     */
    setPaneMuted: (state, action: PayloadAction<{ paneId: string; muted: boolean }>) => {
      const { paneId, muted } = action.payload;
      for (const tabId of Object.keys(state.treesByTabId)) {
        const node = findLeaf(state.treesByTabId[tabId], paneId);
        if (node) {
          if (muted) node.notifyMuted = true;
          else delete node.notifyMuted;
          // Refresh the active-tab paneTree mirror. Under Immer, paneTree and
          // treesByTabId[tabId] are distinct draft paths, so mutating one does
          // NOT reflect into the other — reassign so active-tab readers see it.
          if (state.activeTabId === tabId) state.paneTree = state.treesByTabId[tabId];
          return;
        }
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

    /**
     * Keyboard resize (Alt+Shift+Arrow): nudge the divider of the nearest
     * ancestor split — of the focused pane — whose orientation matches the
     * arrow axis. Left/Right target a side-by-side ('vertical') split, Up/Down
     * a stacked ('horizontal') one. The arrow gives the divider's absolute
     * travel direction (Right/Down = size up, Left/Up = size down), regardless
     * of which child holds the focus, so Left always undoes Right. Same 10-90
     * clamp as drag resize. No matching ancestor → no-op.
     */
    resizeFocusedPane: (state, action: PayloadAction<{ direction: 'left' | 'right' | 'up' | 'down' }>) => {
      const { direction } = action.payload;
      if (!state.paneTree || !state.activePaneId) return;
      // While a pane is maximized no divider is visible — resizing would silently
      // distort the hidden layout, revealed only on restore (reviews 053/054).
      if (state.activeTabId && state.maximizedPaneByTabId[state.activeTabId]) return;

      const wantedOrientation = direction === 'left' || direction === 'right' ? 'vertical' : 'horizontal';
      const delta = direction === 'right' || direction === 'down' ? PANE_RESIZE_STEP : -PANE_RESIZE_STEP;

      // Walk to the focused pane, carrying the nearest matching-orientation split.
      let target: PaneNode | null = null;
      const visit = (node: PaneNode, nearest: PaneNode | null): boolean => {
        if (node.id === state.activePaneId) {
          target = nearest;
          return true;
        }
        if (node.type === 'split' && node.children) {
          const next = node.direction === wantedOrientation ? node : nearest;
          return node.children.some(child => visit(child, next));
        }
        return false;
      };
      visit(state.paneTree, null);
      if (!target) return;

      const split: PaneNode = target;
      split.size = Math.max(10, Math.min(90, (split.size ?? 50) + delta));
      syncActive(state);
    },

    focusPane: (state, action: PayloadAction<string>) => {
      state.activePaneId = action.payload;
    },

    /**
     * Focus a pane in a tab that is not necessarily the active one.
     *
     * `focusPane` alone cannot express this. It writes `activePaneId`, which belongs to
     * whichever tab is active NOW — and `setActiveTabId` overwrites it on arrival from
     * `activePaneByTabId`. So dispatching `focusPane` either side of a tab switch is
     * clobbered: before, because the switch restores the remembered pane; after, because
     * TerminalContainer's activation effect runs a commit later and does the same.
     *
     * Writing the REMEMBERED pane is what survives, in either order. Canvas Mode's
     * "open in its tab" affordance needs exactly that — the node you clicked names a
     * pane in a tab you are not on yet.
     */
    focusPaneInTab: (state, action: PayloadAction<{ tabId: string; paneId: string }>) => {
      const { tabId, paneId } = action.payload;
      if (!findLeaf(state.treesByTabId[tabId] ?? null, paneId)) return;
      state.activePaneByTabId[tabId] = paneId;
      if (state.activeTabId === tabId) state.activePaneId = paneId;
    },

    /**
     * Rename a pane in a specific tab. `tabId` is optional and defaults to the
     * active tab, so every existing caller (TerminalPane.handleNameSave) keeps
     * working unchanged.
     *
     * This used to walk `state.paneTree` — the ACTIVE-tab mirror — so a rename
     * aimed at any other tab silently no-opped. The canvas sidebar renames
     * nodes across every group, so the authoritative `treesByTabId` is the
     * thing to write.
     */
    renamePanes: (
      state,
      action: PayloadAction<{ paneId: string; name: string; tabId?: string }>
    ) => {
      const { paneId, name, tabId } = action.payload;

      const targetTabId = tabId ?? state.activeTabId;
      if (!targetTabId) return;
      const tree = state.treesByTabId[targetTabId];
      if (!tree) return;

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

      if (!findAndRenamePane(tree)) return;

      // Refresh the active-tab mirror FROM treesByTabId — the same direction
      // setPaneMuted uses. Under Immer `paneTree` and `treesByTabId[tabId]` are
      // distinct draft paths, so the write above is not visible through
      // `paneTree`. Note this is the OPPOSITE direction to `syncActive()`,
      // which copies paneTree INTO treesByTabId and would therefore discard
      // the rename we just made.
      if (state.activeTabId === targetTabId) {
        state.paneTree = state.treesByTabId[targetTabId];
      }
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

    /**
     * Full teardown of the panes slice (re-review 111 finding 4).
     *
     * Layout load / reset-to-default used to tear down by dispatching
     * `setPaneTree(null)`, which reaches `syncActive` and deletes ONLY
     * `treesByTabId[activeTabId]`. Every BACKGROUND tab's tree survived; and
     * because the window-side tab-panes map was cleared first,
     * TerminalContainer's cleanup effect had no keys left to enumerate and
     * could never dispatch `removeTabTree` for them. The stale trees were then
     * re-serialized by the next `saveLayout` and made keep-logic believe their
     * terminals were still present. Clearing every per-tab map in ONE
     * synchronous action removes that whole class of leak.
     */
    resetPanes: (state) => {
      state.paneTree = null;
      state.activePaneId = null;
      state.activeTabId = null;
      state.treesByTabId = {};
      state.activePaneByTabId = {};
      state.maximizedPaneByTabId = {};
    },

    /** Store/overwrite a tab's authoritative tree (background or active). */
    // `tree: null` installs the KEY for a tab that is open and empty. That is a real
    // instruction — absent means "never initialised" and gets seeded, so restoring an
    // emptied tab has to write the null rather than write nothing.
    addTabTree: (state, action: PayloadAction<{ tabId: string; tree: PaneNode | null }>) => {
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
      action: PayloadAction<{ tabId: string; targetPaneId: string | null; zone: DropZone; node: PaneNode }>,
    ) => {
      const { tabId, targetPaneId, zone, node } = action.payload;
      const tree = state.treesByTabId[tabId];
      // An absent key is a tab with no layout to insert into. A key holding NULL is an open,
      // empty tab — design 010 §6.3 keeps its frame on the canvas as a drop target, so a drop
      // there has to land: the arriving pane simply becomes the tab's whole tree. Refusing it
      // (the old `if (!tree) return`) made an emptied group a place you could drag out of and
      // never back into, with no error to explain the refusal.
      if (tree === undefined) return;
      const edge: EdgeZone = zone === 'center' ? 'right' : zone;
      const next = tree === null || targetPaneId === null
        ? node
        : insertByZone(tree, targetPaneId, node, edge);
      state.treesByTabId[tabId] = next;
      // `activePaneByTabId` is per tab, so it is always the arriving pane's. `paneTree` and
      // `activePaneId` belong to the ACTIVE tab only (see `removePaneFromTab` below, which
      // states the same invariant) — writing them for an insert into a BACKGROUND tab points
      // the active tab's cursor at a pane that is not in it.
      //
      // This guard used to cover `paneTree` but not `activePaneId`. Unreachable until now: the
      // only production caller was the cross-window drop in `dnd/detach.ts`, which always
      // targets the receiving window's active tab. Canvas re-homing (`plan/013` Task 11) is the
      // first caller that inserts into a background tab, and it fails without this.
      if (state.activeTabId === tabId) {
        state.paneTree = next;
        state.activePaneId = node.id;
      }
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
      // An emptied tab keeps its KEY, holding null: it is open and has no terminals.
      // Deleting it here is what let TerminalContainer seed the tab a second terminal —
      // see the `treesByTabId` note. Callers that want the tab CLOSED when it empties
      // (the cross-window detach) test for a null tree and dispatch `removeTab`.
      state.treesByTabId[tabId] = pruned;
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
      // The DESTINATION may legitimately be null — an open tab someone emptied by dragging
      // its last terminal away is a drop target, not a missing tab. Only `undefined` (never
      // initialised) is a refusal here. `insertPaneIntoTab` and `planRegroup` already made
      // this distinction; this was the third caller of the same guard and it still read the
      // empty tab as absent, so a tab-strip drag onto an emptied tab silently no-opped.
      if (!srcTree || dstTree === undefined) return;

      const { tree: prunedSrc, removed } = removeLeaf(srcTree, sourcePaneId);
      if (!removed) return;

      // Cross-tab "center" has no swap semantics; treat it as an insert to the right.
      const edge: EdgeZone = zone === 'center' ? 'right' : zone;
      const newDst = dstTree === null
        ? removed
        : insertByZone(dstTree, targetPaneId, removed, edge);

      // Null rather than a deleted key, as in `removePaneFromTab`. The tab-strip drag
      // closes a source tab it empties (`PaneDragController.commitDrop`), which now reads
      // that null instead of the key's absence.
      state.treesByTabId[sourceTabId] = prunedSrc;
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
      const { paneId, direction, position, shellType, newTerminalId, uniqueTitle, uniqueOriginalTitle } = action.payload;
      
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
          
          // Convert current terminal pane to split pane. Goes through the SAME
          // helper `splitLeafInTree` uses — this reducer carried only `notifyMuted`
          // and dropped `seededForTabId`/`sessionKey`, which is how an ordinary UI
          // split silently unmade a tab's ownership record. See `survivingLeaf`.
          const originalPane = survivingLeaf(node, uniqueOriginalTitle);

          node.type = 'split';
          node.direction = direction;
          node.size = 50;
          // 'before' puts the new pane on the top/left of the original.
          node.children = position === 'before' ? [newPane, originalPane] : [originalPane, newPane];
          delete node.terminalId;
          delete node.notifyMuted; // node is a split container now, not a leaf

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
  setMaximizedPane,
  setPaneMuted,
  closePane,
  resizePane,
  resizeFocusedPane,
  focusPane,
  focusPaneInTab,
  renamePanes,
  setPaneTree,
  resetPanes,
  setActiveTabId,
  addTabTree,
  removeTabTree,
  removePaneFromTab,
  insertPaneIntoTab,
  movePaneWithinTab,
  movePaneToTab,
} = panesSlice.actions;

export default panesSlice.reducer;