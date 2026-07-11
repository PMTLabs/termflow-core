# Auto-Terminal API Quick Start Guide

## The Problem
You're getting HTML instead of API responses because the API server is not running. The Auto-Terminal app and API server are separate processes.

## Solution: Start the API Server

### Method 1: Quick Start (Development)
```bash
# Start API server with default dev token
npm run api:dev

# Or start both app and API together
npm run dev:all
```

This will:
- Start REST API on port 3001
- Start WebSocket server on port 9876
- Use JWT secret: `dev-secret-key`
- Generate example tokens in the console

### Method 2: Production Setup
```bash
# Set your JWT secret
set JWT_SECRET=your-super-secret-key-here

# Start the API server
npm run api:prod
```

### Method 3: Custom Configuration
```bash
# Set all options
set JWT_SECRET=your-secret-key
set API_PORT=3001
set WS_PORT=9876
set CORS_ORIGINS=http://localhost:3000,http://myapp.com

# Start server
node start-api-server.js
```

## Testing the API

1. **Start the API server** (you'll see example tokens in console):
   ```
   === API Server Ready ===
   REST API: http://localhost:3001
   WebSocket: ws://localhost:9876
   
   Admin token (all permissions):
   eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

2. **Copy the admin token** from the console output

3. **Test with curl**:
   ```bash
   curl http://localhost:3001/api/health
   
   curl http://localhost:3001/api/terminals \
     -H "Authorization: Bearer YOUR_TOKEN_HERE"
   ```

4. **Or use Postman**:
   - Import the `Auto-Terminal-API.postman_collection.json`
   - Set the `jwt_token` variable to your token
   - Try the "Health Check" request

## Common Issues

### Still getting HTML?
- Make sure the API server is running (check for "API Server Ready" message)
- Check you're using port 3001, not 2010 (which is the Electron app)
- Verify the Authorization header is set correctly

### "Invalid token" error?
- Make sure you copied the complete token from console
- Check the JWT_SECRET matches between token generation and server

### Port already in use?
```bash
# Kill the process using the port
npx kill-port 3001 9876
```

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Auto-Terminal  │     │   API Server    │     │   Your App      │
│  Electron App   │     │  (Separate)     │     │                 │
│                 │     │                 │     │                 │
│  Port: 2010     │     │  REST: 3001     │<--->│  Uses API       │
│  (UI Only)      │     │  WS: 9876       │     │  Via Tokens     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

The API server runs separately from the Electron app, allowing external applications to control terminals.

## Next Steps

1. Generate a proper JWT secret for production:
   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

2. Create tokens with specific permissions:
   ```javascript
   const { AuthManager } = require('./src/api/auth');
   const auth = new AuthManager({ jwtSecret: 'your-secret' });
   const token = auth.generateToken('my-app', ['terminal.create', 'terminal.read']);
   ```

3. Build your integration using the API!