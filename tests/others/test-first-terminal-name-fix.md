# First Terminal Name Revert Fix

## The Issue
The first terminal loaded at startup reverts its name when edited and Enter is pressed, while subsequent tabs work fine.

## Root Cause
The first terminal is special because:
1. It's restored from saved state during app initialization
2. There's a complex timing between state restoration, component mounting, and terminal creation
3. The blur event was firing while state updates were still processing

## The Fix

### 1. Processing State Lock
Added a "processing" state to prevent concurrent submits:
```javascript
if (submitSourceRef.current === 'processing') {
  return; // Ignore additional submits
}
submitSourceRef.current = 'processing';
```

### 2. Delayed Blur
Changed the Enter key handler to blur after React processes the state:
```javascript
setTimeout(() => {
  e.currentTarget.blur();
}, 0);
```

### 3. Skip First Render Effect
Added logic to skip the first render in useEffect to avoid resetting initial state:
```javascript
if (isFirstRenderRef.current) {
  isFirstRenderRef.current = false;
  return;
}
```

### 4. Keep Local State Consistent
Update previousTitleRef when submitting to prevent external sync issues:
```javascript
previousTitleRef.current = editTitle.trim();
```

## Test Steps

1. **Close the App Completely**
   - Make sure to save any work
   - Close all terminals

2. **Start Fresh**
   ```bash
   npm run dev
   ```

3. **Test First Terminal**
   - The first terminal should load with its saved name
   - Double-click to edit
   - Type a new name
   - Press Enter
   - **Expected**: Name should stick, not revert

4. **Check Console Logs**
   Look for:
   - "Already processing a submit" - indicates duplicate prevention working
   - "Tab title changed externally" - should not appear during your edit

5. **Test Other Methods**
   - Create a second tab and test it works normally
   - Test click-away to save
   - Test Escape to cancel

## Debug Commands

```javascript
// Check if first tab has correct title
const firstTab = window.__REDUX_STORE__.getState().tabs.tabs[0];
console.log('First tab:', firstTab);

// Check terminal registry
// Look at: C:\Users\tamtr\AppData\Roaming\auto-terminal\terminal-registry.json

// Monitor Redux state changes
window.__REDUX_STORE__.subscribe(() => {
  const tabs = window.__REDUX_STORE__.getState().tabs.tabs;
  console.log('Tabs updated:', tabs.map(t => ({id: t.id, title: t.title})));
});
```

## Why This Works

1. **Processing Lock**: Prevents the blur handler from interfering with Enter key submit
2. **Delayed Blur**: Ensures React has time to process state updates before blur fires
3. **Skip First Effect**: Prevents the initial mount from resetting the restored title
4. **Local State Sync**: Keeps component state in sync with what we're submitting

This fix specifically addresses the timing issues that occur with the first terminal that's restored from saved state.