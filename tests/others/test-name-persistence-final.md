# Terminal Name Persistence Test Guide - Final

## Test Steps

### 1. Start Fresh
```bash
# Delete old state files to start fresh
del %APPDATA%\auto-terminal\terminal-registry.json
```

### 2. Run the App
```bash
npm run dev
```

### 3. Create and Rename Terminals
1. Create a new terminal tab
2. **Immediately** rename it by double-clicking the tab header
3. Enter a custom name like "My Project" or "Backend Server"
4. Press Enter to save
5. You should see in console: "TabManager: Saved state after title update"

### 4. Verify State Was Saved
Open DevTools Console (Ctrl+Shift+I) and run:
```javascript
// Copy and paste the debug script
localStorage.getItem('auto-terminal-state')
```

You should see your custom tab title in the saved state.

### 5. Close the App
Close the app completely (Ctrl+Q or X button)

### 6. Restart the App
```bash
npm run dev
```

### 7. Check Console Logs
In DevTools, you should see:
- "Restoring state from..."
- "Restoring X tabs"
- "Tab details: [...]" - This should show your custom title
- "TerminalPane: Syncing restored name..."

### 8. Verify Names
Your terminals should appear with the custom names you gave them.

## What We Fixed

1. **Immediate State Saving**: State is now saved immediately when you rename a terminal (not just every 30 seconds)
2. **Name Synchronization**: When terminals are recreated on restart, names from saved state are synced to backend
3. **No Terminal Cleanup on Unmount**: Terminals persist when switching tabs or during restoration

## Debugging Commands

Run these in DevTools Console:

```javascript
// Check saved state
JSON.parse(localStorage.getItem('auto-terminal-state'))

// Check current Redux state
window.__REDUX_STORE__.getState().tabs.tabs

// Check terminal registry
await fetch('http://localhost:3001/api/terminals', {
  headers: { 'Authorization': 'Bearer YOUR_TOKEN' }
}).then(r => r.json())
```

## If Names Still Don't Persist

1. Check if localStorage is being cleared by browser/security software
2. Verify the StateManager.saveState() is being called (check console)
3. Look for any errors in console during name save or restoration
4. Check if the saved state actually contains the custom names