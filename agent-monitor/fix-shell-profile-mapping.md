# Fix for Auto-Terminal Shell Profile Mapping Issue

## Problem
Auto-Terminal's shell profile mapping logic in `src/main/ipc/terminalHandlers.ts` has order-dependent mapping that can cause Git Bash to overwrite PowerShell mapping.

## Root Cause
The mapping logic uses `.includes()` with overlapping patterns:

```typescript
// Current problematic code (lines 89-104 in terminalHandlers.ts)
shells.forEach((shell, index) => {
  const shellName = shell.name.toLowerCase();
  if (shellName.includes('cmd') || shellName.includes('command prompt')) {
    profileMap['cmd'] = shell.name;
  } else if (shellName.includes('powershell') && !shellName.includes('core')) {
    profileMap['powershell'] = shell.name;
  } else if (shellName.includes('pwsh') || shellName.includes('powershell core')) {
    profileMap['pwsh'] = shell.name;
  } else if (shellName.includes('git bash') || shellName.includes('bash')) {
    profileMap['bash'] = shell.name; // This can overwrite other mappings!
  }
});
```

## Solution

### Step 1: Fix terminalHandlers.ts
Replace the problematic mapping logic in `D:\sources\demo\auto-terminal\src\main\ipc\terminalHandlers.ts` (lines 89-104):

```typescript
// FIXED - More specific and non-overlapping mapping
const profileMap: { [key: string]: string } = {};

shells.forEach((shell, index) => {
  const shellName = shell.name.toLowerCase();
  const shellPath = shell.path.toLowerCase();
  
  // More specific matching to prevent overwrites
  if (shellName.includes('command prompt') || shellName.includes('cmd.exe') || shellPath.includes('cmd.exe')) {
    if (!profileMap['cmd']) profileMap['cmd'] = shell.name;
  } else if (shellName.includes('powershell') && !shellName.includes('core') && shellPath.includes('powershell.exe')) {
    if (!profileMap['powershell']) profileMap['powershell'] = shell.name;
  } else if (shellName.includes('pwsh') || shellName.includes('powershell core') || shellPath.includes('pwsh.exe')) {
    if (!profileMap['pwsh']) profileMap['pwsh'] = shell.name;
  } else if (shellName.includes('git bash') || (shellName.includes('bash') && shellPath.includes('git'))) {
    if (!profileMap['bash']) profileMap['bash'] = shell.name;
  }
  
  console.log(`Shell detected: ${shell.name} -> Path: ${shell.path}`); // Debug logging
});

console.log('Profile mapping:', profileMap); // Debug logging
```

### Step 2: Add Debug Logging (Optional)
To help debug shell detection issues, add this logging in terminalHandlers.ts after the profile mapping:

```typescript
// Add after profile mapping logic
console.log('=== SHELL PROFILE MAPPING DEBUG ===');
console.log('Available shells:', shells.map(s => `${s.name} -> ${s.path}`));
console.log('Final profile mapping:', profileMap);
console.log('=====================================');
```

### Step 3: Rebuild Auto-Terminal
After making the changes:

```bash
cd D:\sources\demo\auto-terminal
npm run build:main
```

## Testing the Fix

Use the debug script to test:

```bash
cd D:\sources\demo\auto-terminal\docs\samples\agent-monitor
node debug-terminal-assignment.js
```

This will:
1. Create terminals with each profile type
2. Show which shell actually gets created
3. Test individual terminal input to verify assignment

## Alternative Workaround

If you can't modify Auto-Terminal source, use explicit shell profiles in team configs:

```json
{
  "agents": [
    {
      "shellProfile": "cmd",    // For Command Prompt
      "shellProfile": "pwsh",   // For PowerShell Core (more reliable)
      "shellProfile": "bash"    // For Git Bash
    }
  ]
}
```

The `pwsh` profile is often more reliable than `powershell` on systems with both Windows PowerShell and PowerShell Core.