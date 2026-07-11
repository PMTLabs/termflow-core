# Terminal Name Revert Fix - Test Guide

## The Problem
When editing a terminal name and pressing Enter, the name was reverting to the old value.

## Root Cause
1. **Double Submit**: Pressing Enter triggers submit, then the input loses focus which also triggers submit via onBlur
2. **Race Condition**: The blur event might fire with stale state
3. **Unnecessary Re-sync**: useEffect was re-syncing editTitle even when not needed

## The Fix
1. **Prevent Double Submit**: Track the submit source and ignore blur if Enter was just pressed
2. **Skip No-op Updates**: Only update if the title actually changed
3. **Better useEffect Logic**: Only sync editTitle when it's actually different from tab.title

## Changes Made

### TabManager.tsx
```javascript
// Added ref to track submit source
const submitSourceRef = useRef<string | null>(null);

// Modified handleTitleSubmit to prevent double submit
const handleTitleSubmit = (source: string = 'unknown') => {
  // Prevent double submit from Enter + blur
  if (submitSourceRef.current === 'Enter key' && source === 'blur') {
    console.log(`Ignoring blur submit because Enter was just pressed`);
    return;
  }
  
  // Only update if title actually changed
  if (editTitle.trim() && editTitle.trim() !== tab.title) {
    onEditTitle(tab.id, editTitle.trim());
  }
  
  setIsEditing(false);
};

// Fixed useEffect to avoid unnecessary syncs
React.useEffect(() => {
  // Only sync if not editing AND title actually changed
  if (!isEditing && editTitle !== tab.title) {
    setEditTitle(tab.title);
  }
}, [tab.title, isEditing, editTitle]);
```

## Test Steps

1. **Start the App** (if not already running)
   ```bash
   npm run dev
   ```

2. **Open DevTools Console** (Ctrl+Shift+I)
   - Clear console for fresh start

3. **Create a Terminal Tab**
   - Note the tab ID in logs

4. **Test Name Change with Enter**
   - Double-click tab to edit
   - Type new name (e.g., "Test Terminal")
   - Press Enter
   - **Expected**: Name should stick, not revert
   - **Console**: Should show "Ignoring blur submit because Enter was just pressed"

5. **Test Name Change with Click Away**
   - Double-click tab to edit
   - Type new name
   - Click elsewhere
   - **Expected**: Name should update correctly

6. **Test Name Change with Tab Key**
   - Double-click tab to edit
   - Type new name
   - Press Tab
   - **Expected**: Name should update correctly

7. **Test Escape Cancel**
   - Double-click tab to edit
   - Type new name
   - Press Escape
   - **Expected**: Should revert to original name

8. **Test Empty Name**
   - Double-click tab to edit
   - Clear all text
   - Press Enter
   - **Expected**: Should keep original name

## Verify Persistence

1. **After Renaming**
   ```javascript
   // Check Redux state
   window.__REDUX_STORE__.getState().tabs.tabs
   ```

2. **Close and Reopen App**
   - Names should persist

## Console Logs to Watch

### Successful Rename
```
TabItem[{id}]: handleTitleKeyDown - key: Enter
TabItem[{id}]: handleTitleSubmit called from Enter key
TabItem[{id}]: Title changed, calling onEditTitle
TabManager: handleEditTitle - id: {id}, new title: "{new}"
tabsSlice: updateTabTitle - id: {id}, title: "{new}"
TabItem[{id}]: handleTitleSubmit called from blur
TabItem[{id}]: Ignoring blur submit because Enter was just pressed
```

### No Change
```
TabItem[{id}]: No change in title, skipping update
```

## Troubleshooting

If names still revert:
1. Check if there are any errors in console
2. Verify Redux state is updating: `window.__REDUX_STORE__.getState().tabs.tabs`
3. Check if backend is updating: Look for "Successfully updated backend name" log
4. Ensure no other components are updating the title

## Success Criteria
✅ Pressing Enter saves the new name without reverting
✅ Clicking away saves the new name
✅ Pressing Escape cancels the edit
✅ Empty names are not saved
✅ Names persist after app restart