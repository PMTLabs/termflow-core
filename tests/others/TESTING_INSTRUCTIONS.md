# Testing Multiple Terminal Creation Fix

## Problem Fixed
When creating multiple terminals in the same tab via the API, all terminals after the first one were sharing the same process ID. This fix ensures each terminal gets its own unique process.

## Changes Made

### 1. TerminalPane.tsx
- Added check to always create new processes for pane terminals (terminals created via splits)
- Pane terminals have IDs starting with `pane-terminal-`

### 2. TerminalService.ts  
- Updated `createTerminal` to always create new processes for pane terminals
- Even if a mapping exists, pane terminals will get new processes

## How to Test

### Method 1: Using the API (when app is running)
```bash
# Run the app
npm start

# In another terminal, run the test script
node test-api-multiple-terminals.js
```

### Method 2: Using the Browser Console
1. Start the app: `npm start`
2. Open the browser DevTools (F12)
3. Go to the Console tab
4. Copy and paste the contents of `test-ui-multiple-terminals.js`
5. Press Enter to run the test

### Expected Results
- Each terminal should have a unique process ID
- The test should show "✓ SUCCESS: All terminals have unique process IDs!"
- No terminals should share the same process ID

### Verification in the App
1. After creating multiple terminals, you can type different commands in each
2. Each terminal should operate independently
3. Input should only go to the focused terminal
4. Each terminal should maintain its own shell session

## Debug Output
The fix adds console logging to help trace the issue:
- Look for "Terminal X is a pane terminal, will create new process" in the console
- Each terminal creation should show a unique process ID