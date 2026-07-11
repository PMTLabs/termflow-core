# Terminal Restoration Test Guide

## What Should Happen

1. **On App Close**:
   - StateManager saves tabs, panes, and names to localStorage
   - Terminal processes are terminated (they can't persist across app restarts)
   - Terminal registry keeps track of terminal metadata

2. **On App Restart**:
   - StateManager restores tabs and pane trees from localStorage
   - For each restored tab/pane, a NEW terminal process should be created
   - Terminal names from the saved state should be applied to new terminals

## How to Test

1. **Start the app**: `npm run dev`

2. **Open DevTools** (Ctrl+Shift+I) and monitor console logs

3. **Create some terminals**:
   - Create 2-3 tabs with different shells
   - Rename them (double-click tab header)
   - Maybe split some panes

4. **Close the app** (Ctrl+Q or X button)

5. **Check saved state**:
   - Run: `node debug-state-restoration.js`
   - You should see terminals in the registry (but they're stale)

6. **Restart the app**: `npm run dev`

7. **Watch console logs for**:
   - "Restoring state from..."
   - "Restoring X tabs"
   - "TerminalContainer: Restoring pane tree for tab..."
   - "TerminalPane: Terminal init effect..."
   - "TerminalPane: Creating terminal for..."

## Expected Console Output on Restart

```
Initializing app...
Restoring state from [timestamp]
Restoring 2 tabs
Tab details: [{ id: "tab-xxx", title: "My Terminal", shellType: "bash" }, ...]
TerminalContainer: Restoring pane tree for tab tab-xxx
TerminalPane: Terminal init effect - terminalId: tab-xxx, name: My Terminal
TerminalPane: Creating terminal for tab-xxx
TerminalPane: Created terminal tab-xxx with process yyy
TerminalPane: Syncing restored name "My Terminal" to backend for process yyy
```

## Common Issues

1. **No terminals created**: Check if TerminalPane useEffect is firing
2. **Names not restored**: Check if name sync is happening after terminal creation
3. **Stale processes**: Old PIDs in registry should be cleaned up

## Debug Commands in DevTools Console

```javascript
// Check saved state
localStorage.getItem('auto-terminal-state')

// Check terminal service mappings
terminalService.getAllProcessIds()

// Check Redux state
store.getState().tabs
store.getState().panes
```