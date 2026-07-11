# Debug Terminal Name Reverting Issue

## Problem
When changing a terminal name in the UI and pressing Enter, the name reverts to the old name.

## Debug Logging Added

### 1. TabItem Component (TabManager.tsx)
- Added logging to track when `useEffect` syncs `editTitle` with `tab.title`
- Added source tracking to `handleTitleSubmit` (blur vs Enter key)
- Added preventDefault on Enter key to avoid conflicts
- Added tab ID to all logs for easier tracking

### 2. Redux tabsSlice
- Added logging to `updateTabTitle` action to track Redux state changes
- Logs both the incoming title and the current title before update

### 3. TabManager Selector
- Added logging to the Redux selector to see state changes in real-time

## Test Steps

1. **Open DevTools Console** (Ctrl+Shift+I)
   - Clear the console for a fresh start

2. **Create or Select a Terminal Tab**
   - Note the tab ID in the logs

3. **Double-click to Edit Name**
   - Watch for: `TabItem[{id}]: useEffect` logs

4. **Type a New Name and Press Enter**
   - Watch for these logs in sequence:
     ```
     TabItem[{id}]: handleTitleKeyDown - key: Enter
     TabItem[{id}]: handleTitleSubmit called from Enter key
     TabItem[{id}]: Calling onEditTitle with id={id}, title="{new name}"
     TabManager: handleEditTitle - id: {id}, new title: "{new name}"
     tabsSlice: updateTabTitle - id: {id}, title: "{new name}"
     tabsSlice: Found tab, updating title from "{old}" to "{new}"
     TabManager: Redux state tabs: [{id: ..., title: "{new name}"}]
     ```

5. **Check What Happens After**
   - Look for any `useEffect` logs that might be resetting the title
   - Check if Redux state shows the correct title
   - See if there are multiple `handleTitleSubmit` calls (from both Enter and blur)

## Expected Issues

### Race Condition
- Enter key triggers submit
- Input loses focus, triggering blur
- Both might call `handleTitleSubmit`

### State Sync Issue
- `useEffect` might be resetting `editTitle` incorrectly
- Redux state might not be updating properly

## Debugging in Console

```javascript
// Check current Redux state
window.__REDUX_STORE__.getState().tabs.tabs

// Check if tab exists
window.__REDUX_STORE__.getState().tabs.tabs.find(t => t.id === 'YOUR_TAB_ID')

// Manually update a tab title
window.__REDUX_STORE__.dispatch({
  type: 'tabs/updateTabTitle',
  payload: { id: 'YOUR_TAB_ID', title: 'Test Name' }
})
```

## What to Look For

1. **Multiple Submit Calls**: Is `handleTitleSubmit` called twice (Enter + blur)?
2. **Redux State Update**: Does the Redux state actually change?
3. **useEffect Reset**: Is the `useEffect` resetting the local state incorrectly?
4. **Component Re-render**: Is the component re-rendering with old props?

## Potential Fixes

1. **Prevent Double Submit**: Already added `preventDefault()` on Enter
2. **Debounce blur handler**: Might need to ignore blur if Enter was just pressed
3. **Fix useEffect dependency**: Might need to track previous title to avoid resets