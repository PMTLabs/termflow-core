# Terminal Name Persistence - Final Test

## The Problem
Terminal names were not persisting after app restart. Even though:
- Names were saved in localStorage (in Redux state)
- Names were saved in terminal-registry.json
- The names were not being displayed in the UI after restart

## The Fix
1. **Tab titles are now properly synchronized with pane names**
2. **When restoring pane trees, the name is updated from the tab title**
3. **When tab titles change, the pane name is also updated**
4. **State is saved immediately after renaming**

## Test Steps

### 1. Clean Start (Optional)
```bash
# Remove old registry to start fresh
del %APPDATA%\auto-terminal\terminal-registry.json
```

### 2. Start the App
```bash
npm run dev
```

### 3. Create and Rename Terminals
1. Create a new terminal tab
2. **Double-click the tab header** to edit the name
3. Enter a custom name like "My Server" or "Frontend Dev"
4. Press Enter

### 4. Check Console Logs
Open DevTools (Ctrl+Shift+I) and look for:
- "TabManager: Saved state after title update"
- "TerminalContainer: Updated pane name to match tab title"

### 5. Verify in Console
Run this in DevTools console:
```javascript
// Check saved state
JSON.parse(localStorage.getItem('auto-terminal-state')).tabs

// Should show your custom names
```

### 6. Close and Restart
1. Close the app completely (Ctrl+Q or X)
2. Start again: `npm run dev`

### 7. Check Restoration Logs
In DevTools console, you should see:
- "Restoring X tabs"
- "TerminalContainer: Active tab: {id: ..., title: 'Your Custom Name'}"
- "TerminalContainer: Updated pane name to match tab title: Your Custom Name"
- "TerminalPane: Determining name - pane name: 'Your Custom Name'"

### 8. Verify Names
Your terminals should now show with their custom names!

## What Happens Behind the Scenes

1. **When you rename a tab**:
   - Tab title is updated in Redux
   - Pane name is also updated to match
   - State is saved to localStorage
   - Terminal name is synced to backend

2. **When app restarts**:
   - Tabs are restored from localStorage with custom titles
   - Pane trees are created/restored
   - Pane names are synchronized with tab titles
   - Terminal is created with the correct name

## Debug Commands

```javascript
// See current tab names
window.__REDUX_STORE__.getState().tabs.tabs.map(t => ({id: t.id, title: t.title}))

// See current pane tree
window.__REDUX_STORE__.getState().panes.paneTree

// Force save state
StateManager.saveState()
```

## If Names Still Don't Persist

1. Check if localStorage is being cleared
2. Verify "restoreLastSession" is true in config.json
3. Look for errors in console during restoration
4. Check that the pane name matches the tab title