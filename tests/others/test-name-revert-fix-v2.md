# Terminal Name Revert Fix v2

## The Issue
When editing a terminal name and pressing Enter, the name reverts to the old value.

## Root Cause Analysis
The issue was more complex than initially thought:
1. When Enter is pressed, it triggers `handleTitleSubmit` 
2. Then the input loses focus, triggering the blur handler
3. The blur handler was being called with stale state or the component was re-rendering before the Redux update completed

## New Fix Approach

### 1. Proper Enter Key Handling
- When Enter is pressed, we now:
  1. Mark that Enter was pressed (`submitSourceRef.current = 'Enter key'`)
  2. Call `handleTitleSubmit` directly
  3. Then blur the input

### 2. Smart Blur Handler
- The blur handler now checks if Enter was pressed
- If Enter was pressed, it just exits edit mode without submitting again
- If blur happened naturally (click away, tab), it submits normally

### 3. Better State Tracking
- Added `previousTitleRef` to track when tab title changes externally
- Only sync `editTitle` when the tab title actually changes from an external source

## Code Changes

```javascript
// Enhanced Enter key handling
const handleTitleKeyDown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitSourceRef.current = 'Enter key';
    handleTitleSubmit('Enter key');
    e.currentTarget.blur(); // Blur after submit
  }
};

// Smart blur handler
onBlur={(e) => {
  if (submitSourceRef.current !== 'Enter key') {
    handleTitleSubmit('blur');
  } else {
    // Just exit edit mode without reverting
    setIsEditing(false);
    submitSourceRef.current = null;
  }
}}
```

## Test the Fix

1. **Open DevTools Console** (Ctrl+Shift+I)

2. **Double-click a tab to edit**
   - You should see: `Double-click, starting edit with title: "Current Name"`

3. **Type a new name and press Enter**
   - You should see:
     ```
     handleTitleKeyDown - key: Enter
     handleTitleSubmit called from Enter key
     Title changed, calling onEditTitle
     TabManager: handleEditTitle
     tabsSlice: updateTabTitle
     ```
   - The name should stick and not revert

4. **Check the terminal registry**
   - The name should be updated there too

5. **Test other methods**:
   - Click away: Should save
   - Press Tab: Should save
   - Press Escape: Should cancel

## Debug Commands

```javascript
// Check current tab state
window.__REDUX_STORE__.getState().tabs.tabs

// Check terminal registry (look at AppData file)
// C:\Users\tamtr\AppData\Roaming\auto-terminal\terminal-registry.json

// Force a manual update to test
window.__REDUX_STORE__.dispatch({
  type: 'tabs/updateTabTitle',
  payload: { id: 'YOUR_TAB_ID', title: 'Test Name' }
})
```

## If It Still Reverts

1. Check console for any error messages
2. Look for "Tab title changed externally" messages - this might indicate something else is updating the title
3. Check if the Redux state is actually being updated
4. Verify the terminal-registry.json shows the new name

The key insight is that we need to handle the Enter→blur sequence carefully to avoid state conflicts.