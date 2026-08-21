import { createSlice, PayloadAction } from '@reduxjs/toolkit';
// Pure and import-free, so a slice can depend on it without risking a cycle back through
// the store.
import { shouldAdoptAutoTitle } from '../../services/autoTitle';

export interface Tab {
  id: string;
  title: string;
  shellType: string;
  isActive: boolean;
  processId?: number;
  isDirty?: boolean;
  icon?: string;
  // True once the tab's underlying process has exited but the tab is kept open
  // for review (see settings.closeTabOnProcessExit).
  exited?: boolean;
  // The exit code of the tab's process when it exited (null if unknown). Used to
  // skip the close-confirmation dialog when the session closed cleanly (exit 0) —
  // there is no running process to warn about. See TabManager.handleCloseRequest.
  exitCode?: number | null;
  // Set when an external (MCP/API) call interacts with a terminal in this tab while
  // the tab is not active; drives the persistent tab-title activity dot.
  hasBackgroundActivity?: boolean;
  // Bumped on each external interaction; used as a React key to replay the finite
  // title-flash animation even when hasBackgroundActivity is already true.
  activityTick?: number;
  // True while a process in this tab is actively producing output (working).
  // Transient live status driven by RunningActivityTracker — never persisted.
  isRunning?: boolean;
  // True once output has arrived for this tab while it was NOT active and the
  // user has not viewed it since. Drives the "unseen output" bell. Set by
  // RunningActivityTracker only AFTER the tab's output has settled for
  // UNSEEN_DEBOUNCE_MS (so it never flickers mid-stream); cleared on focus.
  // Transient — never persisted.
  hasUnseenOutput?: boolean;
  // Per-tab override of settings.colorSchemaId. undefined = inherit the
  // global Settings > Appearance default.
  colorSchemaId?: string;
  // Per-tab override of the tab-title text color. undefined = default CSS color.
  titleColor?: string;
  // True once the user has manually renamed this tab (via the rename popup).
  // Pins the title — auto-title updates (setAutoTabTitle, driven by the
  // selected pane's OSC title changes) are suppressed once this is set.
  titleIsCustom?: boolean;
  // Tab-level notification mute. undefined/false = normal; true = NO pane in
  // this tab rings the unseen bell / toast / OS notification (RunningActivityTracker
  // suppresses at the source). Overrides any per-pane mute and covers panes added
  // later. Persisted across restart (an intentional user setting, like colorSchemaId).
  notifyMuted?: boolean;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  // Terminal ids currently producing output fast enough to count as "busy" — the per-PANE
  // sibling of each Tab's `isRunning`. Written by `setRunningActivity` in the SAME dispatch
  // as `isRunning`, so the two levels can never disagree for a rendered frame (plan/020 §2,
  // Req 8). Transient live status driven by RunningActivityTracker — never persisted.
  runningTerminalIds: string[];
}

const initialState: TabsState = {
  tabs: [],
  activeTabId: null,
  runningTerminalIds: [],
};

/**
 * "The user has now seen this tab" — the one definition, in one place.
 *
 * Three reducers meant this before `plan/024` and each carried its own copy of the two lines:
 * `setActiveTab`, `removeTab` (for the tab it auto-activates) and now `markTabSeen`. Copies of a
 * rule drift, and these two flags drive four surfaces between them — the tab-strip bell, the
 * amber background-activity dot, the canvas sidebar's bell and the OS notification gate — so a
 * copy that cleared one and not the other would leave a tab that is half-read.
 *
 * Both flags go together deliberately (`plan/024` D4). They answer the same question from two
 * sources (output arrived / an API or MCP caller wrote here) and reading the tab answers both.
 */
function markSeen(tab: Tab): void {
  tab.hasBackgroundActivity = false;
  tab.hasUnseenOutput = false;
}

const tabsSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    addTab: (state, action: PayloadAction<Omit<Tab, 'isActive'> & { isActive?: boolean; insertAfterId?: string; insertAtStart?: boolean }>) => {
      // Check if we're explicitly setting isActive (e.g., during restore)
      const shouldActivate = action.payload.isActive !== false;

      if (shouldActivate) {
        // Deactivate all tabs
        state.tabs.forEach(tab => tab.isActive = false);
      }

      // Add new tab (strip the transient placement hints — neither is part of Tab state)
      const { insertAfterId, insertAtStart, ...tabFields } = action.payload;
      const newTab: Tab = {
        ...tabFields,
        isActive: shouldActivate,
      };

      // Three placements, in precedence order. `insertAtStart` wins over `insertAfterId`
      // because it is the more specific request: "first" is a position, while "after X" is a
      // relationship that a caller asking for both has already contradicted.
      const insertIndex = insertAfterId
        ? state.tabs.findIndex(tab => tab.id === insertAfterId)
        : -1;
      if (insertAtStart) {
        state.tabs.unshift(newTab);
      } else if (insertIndex !== -1) {
        // Insert immediately after the given tab (its right neighbour).
        state.tabs.splice(insertIndex + 1, 0, newTab);
      } else {
        state.tabs.push(newTab);
      }

      if (shouldActivate) {
        state.activeTabId = newTab.id;
      }
    },
    
    removeTab: (state, action: PayloadAction<string>) => {
      const index = state.tabs.findIndex(tab => tab.id === action.payload);
      if (index !== -1) {
        state.tabs.splice(index, 1);
        
        // If removed tab was active, activate another
        if (state.activeTabId === action.payload) {
          if (state.tabs.length > 0) {
            const newActiveIndex = Math.min(index, state.tabs.length - 1);
            state.tabs[newActiveIndex].isActive = true;
            // Activating this tab counts as viewing it (mirrors setActiveTab).
            markSeen(state.tabs[newActiveIndex]);
            state.activeTabId = state.tabs[newActiveIndex].id;
          } else {
            state.activeTabId = null;
          }
        }
      }
    },
    
    setActiveTab: (state, action: PayloadAction<string>) => {
      console.log('tabsSlice: Setting active tab to', action.payload);
      state.tabs.forEach(tab => {
        tab.isActive = tab.id === action.payload;
        // Viewing a tab is seeing it.
        if (tab.isActive) markSeen(tab);
      });
      state.activeTabId = action.payload;
      console.log('tabsSlice: New activeTabId:', state.activeTabId);
    },
    
    flagTabActivity: (state, action: PayloadAction<{ tabId: string }>) => {
      const { tabId } = action.payload;
      // Don't flash the tab the user is already viewing.
      if (state.activeTabId === tabId) return;
      const tab = state.tabs.find(t => t.id === tabId);
      if (!tab) return;
      tab.hasBackgroundActivity = true;
      tab.activityTick = (tab.activityTick ?? 0) + 1;
    },

    /**
     * The user has read this tab WITHOUT activating it (`plan/024` Req 2).
     *
     * Until now "seen" and "active" were the same event, so clearing lived inside
     * `setActiveTab`. Canvas Mode's overlay breaks that equivalence: it shows one terminal at
     * 1:1, in a workspace where the *canvas* tab is the active one, so a terminal can be read
     * in full while its own tab is in the background and keeps its bell.
     *
     * Deliberately NOT guarded on `activeTabId`, unlike `markUnseenOutput`'s mirror-image
     * guard: the whole point is a tab that is not active, and clearing an already-clear flag on
     * the active one is a no-op anyway.
     *
     * Tab-level, like the flag itself (`plan/020` §0 D2 stands). Reading one pane of a split
     * clears the whole tab's bell here for exactly the reason activating that tab does.
     */
    markTabSeen: (state, action: PayloadAction<{ tabId: string }>) => {
      const tab = state.tabs.find(t => t.id === action.payload.tabId);
      if (tab) markSeen(tab);
    },

    // Flag a non-active tab as having produced output the user hasn't seen yet.
    // Drives the unseen-output bell (rendered only once the tab stops running).
    // Idempotent — no animation tick, unlike flagTabActivity.
    markUnseenOutput: (state, action: PayloadAction<{ tabId: string }>) => {
      const { tabId } = action.payload;
      // Never flag the tab the user is currently viewing.
      if (state.activeTabId === tabId) return;
      const tab = state.tabs.find(t => t.id === tabId);
      if (!tab) return;
      tab.hasUnseenOutput = true;
    },

    // Req 8 (plan/020 §2): ONE action writes both busy levels — `tab.isRunning` (tab header,
    // unchanged meaning) and `runningTerminalIds` (the per-pane truth Canvas Mode needs).
    // Must stay a single action: two separate dispatches would render an intermediate frame
    // where the tab says busy and none of its panes do.
    setRunningActivity: (state, action: PayloadAction<{ tabIds: string[]; terminalIds: string[] }>) => {
      const running = new Set(action.payload.tabIds);
      state.tabs.forEach(tab => {
        tab.isRunning = running.has(tab.id);
      });
      state.runningTerminalIds = action.payload.terminalIds;
    },

    markTabExited: (state, action: PayloadAction<{ tabId: string; exitCode: number | null }>) => {
      const { tabId, exitCode } = action.payload;
      const tab = state.tabs.find(t => t.id === tabId);
      if (tab) {
        tab.exited = true;
        tab.exitCode = exitCode;
      }
    },

    // Clear the "exited" mark — used when the user restarts a closed session in
    // place (see SessionClosedBanner), so the tab returns to its normal state.
    clearTabExited: (state, action: PayloadAction<string>) => {
      const tab = state.tabs.find(t => t.id === action.payload);
      if (tab) {
        tab.exited = false;
        tab.exitCode = undefined;
      }
    },

    // Manual rename (from the tab rename popup). Pins the title — from this
    // point on, setAutoTabTitle below is a no-op for this tab.
    updateTabTitle: (state, action: PayloadAction<{ id: string; title: string }>) => {
      console.log(`tabsSlice: updateTabTitle - id: ${action.payload.id}, title: "${action.payload.title}"`);
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (tab) {
        console.log(`tabsSlice: Found tab, updating title from "${tab.title}" to "${action.payload.title}"`);
        tab.title = action.payload.title;
        tab.titleIsCustom = true;
      } else {
        console.log(`tabsSlice: Tab with id ${action.payload.id} not found!`);
      }
    },

    // Auto title (driven by the tab's selected pane reporting an OSC title
    // change, e.g. a running process setting its terminal title). No-op once
    // the user has manually renamed the tab (titleIsCustom).
    setAutoTabTitle: (state, action: PayloadAction<{ id: string; title: string }>) => {
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (!tab || tab.titleIsCustom) return;
      // `cmd.exe` announces its own full path as its OSC title, so a "Command Prompt" tab
      // renamed itself to `C:\WINDOWS\system32\cmd.exe` a frame after opening — and Canvas
      // Mode labels a group with its tab's title, which is where it finally got noticed.
      // Refusing keeps the profile name that is already there. See `services/autoTitle`.
      if (!shouldAdoptAutoTitle(action.payload.title)) return;
      tab.title = action.payload.title;
    },

    reorderTabs: (state, action: PayloadAction<{ fromIndex: number; toIndex: number }>) => {
      const { fromIndex, toIndex } = action.payload;
      if (fromIndex !== toIndex && fromIndex >= 0 && toIndex >= 0 && 
          fromIndex < state.tabs.length && toIndex < state.tabs.length) {
        const [movedTab] = state.tabs.splice(fromIndex, 1);
        state.tabs.splice(toIndex, 0, movedTab);
      }
    },
    
    clearAllTabs: (state) => {
      state.tabs = [];
      state.activeTabId = null;
    },

    setTabColorSchema: (state, action: PayloadAction<{ id: string; colorSchemaId?: string }>) => {
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (!tab) return;
      if (action.payload.colorSchemaId) tab.colorSchemaId = action.payload.colorSchemaId;
      else delete tab.colorSchemaId;
    },

    setTabTitleColor: (state, action: PayloadAction<{ id: string; titleColor?: string }>) => {
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (!tab) return;
      if (action.payload.titleColor) tab.titleColor = action.payload.titleColor;
      else delete tab.titleColor;
    },

    // Toggle (set/clear) tab-level notification mute. Muting also clears any
    // pending unseen-output bell so a muted tab never keeps showing a
    // notification indicator that it can no longer earn.
    setTabMuted: (state, action: PayloadAction<{ id: string; muted: boolean }>) => {
      const tab = state.tabs.find(t => t.id === action.payload.id);
      if (!tab) return;
      if (action.payload.muted) {
        tab.notifyMuted = true;
        tab.hasUnseenOutput = false;
      } else {
        delete tab.notifyMuted;
      }
    },
  },
});

export const { addTab, removeTab, setActiveTab, markTabExited, clearTabExited, updateTabTitle, setAutoTabTitle, reorderTabs, clearAllTabs, flagTabActivity, markUnseenOutput, markTabSeen, setRunningActivity, setTabColorSchema, setTabTitleColor, setTabMuted } = tabsSlice.actions;
export default tabsSlice.reducer;