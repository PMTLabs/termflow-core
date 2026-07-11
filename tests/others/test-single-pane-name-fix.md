# Single Pane Tab Name Fix

## The Issue
When editing the name of a tab with a single terminal pane and pressing Enter, the name reverts to the old value. However, when the tab has split panes, name editing works correctly.

## Root Cause
There was a `useEffect` in `TerminalContainer.tsx` that was synchronizing pane names with tab titles. This created a race condition:

1. User edits tab name and presses Enter
2. Tab title updates in Redux
3. The `useEffect` sees the tab title changed
4. It updates the pane name to match the tab title
5. This interferes with the ongoing edit operation, causing the revert

The issue only affected single-pane tabs because the sync logic only ran when `paneTree.terminalId === activeTabId` (which is true for single-pane tabs but not for split panes).

## The Fix
Removed the problematic `useEffect` that was synchronizing pane names with tab titles. For single-pane tabs:
- The tab title is the source of truth
- The pane displays whatever name it has
- When creating or restoring a pane, it gets the name from the tab
- User edits update the tab title directly without interference

## Test Steps

1. **Test Single Pane Tab**
   - Create a new tab (don't split it)
   - Double-click the tab to edit the name
   - Type a new name
   - Press Enter
   - **Expected**: Name should stick, not revert

2. **Test Split Pane Tab**
   - Create a new tab
   - Split it (horizontal or vertical)
   - Edit the tab name
   - **Expected**: Still works correctly

3. **Test Persistence**
   - Edit some tab names
   - Close and reopen the app
   - **Expected**: Names persist correctly

## Why This Works

### Before (Problematic):
```javascript
// This was causing the revert
useEffect(() => {
  if (activeTab && paneTree.name !== activeTab.title) {
    // This would overwrite user's edit
    dispatch(setPaneTree({ ...paneTree, name: activeTab.title }));
  }
}, [tabs, activeTabId, paneTree, dispatch]);
```

### After (Fixed):
- No automatic synchronization that can interfere with user edits
- Pane names are set only when creating or restoring panes
- Tab title updates flow cleanly without side effects

## Architecture Notes

For single-pane tabs:
- Tab title = What user sees and edits
- Pane name = Internal state (set from tab title initially)
- No bidirectional sync to avoid conflicts

For split-pane tabs:
- Tab title = Overall container name
- Each pane has its own name
- Panes can be renamed independently

This fix respects the natural hierarchy and prevents timing conflicts.