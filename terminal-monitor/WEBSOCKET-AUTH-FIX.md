# WebSocket Authentication Fix Guide

## Problem Summary
The terminal-monitor can successfully authenticate with the auto-terminal REST API (port 3001) but fails to connect to the WebSocket server (port 9876) with the same JWT token. This causes real-time terminal updates to fail.

## Root Cause
The WebSocket server in auto-terminal is rejecting valid JWT tokens with a 401 error, even though the same tokens work perfectly with the REST API. This suggests a configuration mismatch or bug in the WebSocket server's authentication implementation.

## Investigation Results

✅ **Working**: REST API authentication (port 3001)
❌ **Failing**: WebSocket authentication (port 9876)

### Test Results
```
REST API: ✅ Status 200 - Token accepted
WebSocket: ❌ Error 401 - Token rejected
```

## Immediate Fix Options

### Option 1: Check Auto-Terminal Server Configuration

1. **Restart the auto-terminal application completely**
   ```bash
   # Close auto-terminal if running
   # Restart it from the command line to see any error messages
   ```

2. **Check server logs when starting auto-terminal**
   Look for any JWT secret or authentication-related error messages.

3. **Verify ports are properly configured**
   ```bash
   netstat -an | findstr "42031"
   ```
   The port should show as LISTENING.

### Option 2: Environment Variable Fix

The auto-terminal server might be using a different JWT secret. Try setting a specific JWT secret:

1. **Set environment variable before starting auto-terminal**
   ```bash
   set JWT_SECRET=your-secret-key-here
   # Then start auto-terminal
   ```

2. **Or modify the auto-terminal startup script**
   Add `process.env.JWT_SECRET = 'your-secret-key-here';` before the server initialization.

### Option 3: Code Fix in Auto-Terminal

The issue might be in the WebSocket server's `verifyClient` method. Check this file:
`D:\sources\demo\auto-terminal\src\api\WebSocketServer.ts`

Add debugging to the `verifyClient` method around line 112:
```typescript
// Verify token using AuthManager
console.log('WebSocket: Verifying token:', token?.substring(0, 20) + '...');
const payload = this.authManager.verifyToken(token);
console.log('WebSocket: Token verification result:', payload ? 'SUCCESS' : 'FAILED');
if (!payload) {
  console.log('WebSocket: Token verification failed for token:', token);
}
callback(payload !== null);
```

### Option 4: Alternative WebSocket Implementation

If the WebSocket issue persists, you can implement polling as a temporary workaround:

1. **Disable WebSocket connection attempts**
2. **Use periodic API polling for updates**
3. **Fall back to API-only mode**

## Current Workaround

The terminal-monitor application has been enhanced with:

1. **Better error handling** - Clear error messages when WebSocket fails
2. **API fallback** - Commands still work via REST API
3. **Detailed troubleshooting** - Console logs guide you through debugging steps

## Testing Your Fix

Run this test to verify the fix works:

```bash
cd terminal-monitor
node src/test-auth-detailed.js
```

Expected output when fixed:
```
✅ API token generation successful
✅ API endpoint authentication successful  
✅ WebSocket authentication successful!
🎉 All tests passed!
```

## Next Steps

1. **Try Option 1 first** (restart auto-terminal)
2. **Check auto-terminal logs** for authentication errors
3. **If needed, try Option 2** (set JWT_SECRET environment variable)
4. **If still failing, try Option 3** (add debugging to WebSocket server)

The application will continue to work in API-only mode until the WebSocket authentication is fixed.