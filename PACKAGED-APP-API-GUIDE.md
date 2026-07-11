# Auto-Terminal Packaged App API Guide

This guide explains how to connect to and use the embedded API server in the packaged Auto-Terminal application.

## Overview

When you run the packaged Auto-Terminal exe, it automatically starts an embedded API server alongside the main application. This allows external applications to control the terminal sessions programmatically.

## Architecture

```
┌─────────────────────────────────┐
│  Auto-Terminal.exe              │
│                                 │
│  ┌──────────────┐  ┌─────────┐ │     ┌─────────────┐
│  │ Electron App │  │   API   │ │<--->│ Your App    │
│  │   (UI)       │  │ Server  │ │     │             │
│  └──────────────┘  └─────────┘ │     └─────────────┘
│                                 │
│  Embedded API:                  │
│  - REST: port 3001              │
│  - WebSocket: port 9876         │
└─────────────────────────────────┘
```

## Quick Start

### 1. Build and Package the Application

```bash
# Build the application
npm run build

# Package for Windows
npm run package:win

# The packaged app will be in: dist-electron/auto-terminal-win32-x64/
```

### 2. Run the Packaged Application

```bash
# Navigate to the packaged app directory
cd dist-electron/auto-terminal-win32-x64

# Run the application
auto-terminal.exe
```

The API server will automatically start on:
- REST API: `http://localhost:3001`
- WebSocket: `ws://localhost:9876`

### 3. Generate an API Token

You have several options to get an API token:

#### Option A: Use Environment Variable (Recommended for Production)

Set a JWT secret before starting the app:

```batch
# Windows Command Prompt
set JWT_SECRET=your-super-secret-key-here
auto-terminal.exe

# Windows PowerShell
$env:JWT_SECRET="your-super-secret-key-here"
.\auto-terminal.exe
```

Then generate tokens using any JWT library with your secret.

#### Option B: Use the Developer Console (Development Only)

1. Open the packaged app
2. Press `Ctrl+Shift+I` to open Developer Tools
3. In the console, run:

```javascript
// Generate a token with all permissions
const token = await window.electronAPI.generateAPIToken('my-app', ['*']);
console.log('Your token:', token);

// Get API configuration
const config = await window.electronAPI.getAPIConfig();
console.log('API Config:', config);
```

#### Option C: Create a Token Generator Script

Create a `generate-token.js` file:

```javascript
const jwt = require('jsonwebtoken');

// Use the same secret as your app
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

const token = jwt.sign(
  {
    sub: 'my-external-app',
    permissions: ['*'] // Or specific permissions
  },
  JWT_SECRET,
  { expiresIn: '24h' }
);

console.log('Token:', token);
```

### 4. Test the API Connection

```bash
# Test health endpoint (no auth required)
curl http://localhost:3001/api/health

# Test with authentication
curl http://localhost:3001/api/terminals \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## API Endpoints

All endpoints except `/api/health` require JWT authentication.

### Terminal Management
- `GET /api/terminals` - List all terminals
- `POST /api/terminals` - Create new terminal
- `GET /api/terminals/{id}` - Get terminal details
- `DELETE /api/terminals/{id}` - Close terminal

### Terminal I/O
- `POST /api/terminals/{id}/input` - Send input to terminal
- `GET /api/terminals/{id}/output` - Get terminal output
- `POST /api/terminals/{id}/resize` - Resize terminal

### System Information
- `GET /api/system/info` - System information
- `GET /api/system/metrics` - Performance metrics
- `GET /api/profiles` - Available shell profiles

## Example: Python Integration

```python
import requests
import json

# Configuration
API_URL = "http://localhost:3001"
TOKEN = "your-jwt-token-here"

headers = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json"
}

# Create a terminal
response = requests.post(
    f"{API_URL}/api/terminals",
    headers=headers,
    json={"profile": "cmd"}
)
terminal = response.json()
terminal_id = terminal['id']

print(f"Created terminal: {terminal_id}")

# Send a command
requests.post(
    f"{API_URL}/api/terminals/{terminal_id}/input",
    headers=headers,
    json={"data": "echo Hello from Python!\r\n"}
)

# Get output
response = requests.get(
    f"{API_URL}/api/terminals/{terminal_id}/output",
    headers=headers
)
output = response.json()
print("Output:", output['lines'])

# Close terminal
requests.delete(
    f"{API_URL}/api/terminals/{terminal_id}",
    headers=headers
)
```

## Example: Node.js/JavaScript Integration

```javascript
const axios = require('axios');

const API_URL = 'http://localhost:3001';
const TOKEN = 'your-jwt-token-here';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json'
  }
});

async function runCommand() {
  // Create terminal
  const { data: terminal } = await api.post('/api/terminals', {
    profile: 'powershell'
  });
  
  console.log(`Created terminal: ${terminal.id}`);
  
  // Send command
  await api.post(`/api/terminals/${terminal.id}/input`, {
    data: 'Get-Date\r\n'
  });
  
  // Wait a bit for output
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Get output
  const { data: output } = await api.get(`/api/terminals/${terminal.id}/output`);
  console.log('Output:', output.lines.join('\n'));
  
  // Clean up
  await api.delete(`/api/terminals/${terminal.id}`);
}

runCommand().catch(console.error);
```

## WebSocket Real-Time Events

Connect to `ws://localhost:9876?token=YOUR_TOKEN` for real-time events:

```javascript
const WebSocket = require('ws');

const ws = new WebSocket(`ws://localhost:9876?token=${TOKEN}`);

ws.on('open', () => {
  // Subscribe to terminal output events
  ws.send(JSON.stringify({
    id: 'sub-1',
    type: 'subscribe',
    payload: {
      patterns: ['output.data', 'terminal.*']
    }
  }));
});

ws.on('message', (data) => {
  const event = JSON.parse(data);
  if (event.type === 'output.data') {
    console.log(`Terminal ${event.terminalId}: ${event.data.content}`);
  }
});
```

## Configuration Options

Control the embedded API server with environment variables:

```batch
# Disable API server
set AUTO_TERMINAL_API=false

# Custom ports
set API_PORT=3002
set WS_PORT=9877

# Custom JWT secret
set JWT_SECRET=my-secret-key

# Allow specific CORS origins
set CORS_ORIGINS=http://localhost:3000,http://myapp.com

auto-terminal.exe
```

## Security Considerations

1. **JWT Secret**: Always set a secure JWT secret in production
2. **Token Permissions**: Use specific permissions instead of wildcard `['*']`
3. **CORS**: Configure allowed origins for your specific use case
4. **Network**: The API only listens on localhost by default

## Permissions List

- `terminal.create` - Create new terminals
- `terminal.read` - Read terminal info and output
- `terminal.write` - Send input to terminals
- `terminal.delete` - Close terminals
- `terminal.resize` - Resize terminals
- `system.info` - Read system information
- `system.profiles` - List shell profiles
- `process.monitor` - Monitor process metrics
- `event.subscribe` - Subscribe to WebSocket events
- `event.history` - Read event history
- `*` - All permissions (admin)

## Troubleshooting

### API server not responding?
- Check if the app is running
- Verify ports 3001 and 9876 are not in use
- Check Windows Firewall settings

### Authentication errors?
- Ensure token is valid and not expired
- Verify JWT secret matches between token and server
- Check token has required permissions

### Can't connect from external machine?
- API only listens on localhost by default
- Use SSH tunneling or modify the source code for network access

## Using with Postman

Import the included `Auto-Terminal-API.postman_collection.json` and:
1. Set the `jwt_token` variable to your generated token
2. Ensure `base_url` is set to `http://localhost:3001`
3. Start testing the API endpoints!

## Advanced Usage

### Running Multiple Instances

To run multiple Auto-Terminal instances with different API ports:

```batch
# Instance 1
set API_PORT=3001
set WS_PORT=9876
start auto-terminal.exe

# Instance 2
set API_PORT=3002
set WS_PORT=9877
start auto-terminal.exe
```

### Automated Deployment

For automated deployments, create a batch script:

```batch
@echo off
REM Set production configuration
set JWT_SECRET=%AUTOTERMINAL_JWT_SECRET%
set API_PORT=3001
set WS_PORT=9876
set AUTO_TERMINAL_API=true

REM Start the application
start "" "%~dp0\auto-terminal.exe"

REM Wait for API to be ready
timeout /t 5

REM Test API health
curl http://localhost:3001/api/health
```

## Next Steps

1. Build your integration using the API
2. Set up proper authentication with secure JWT secrets
3. Monitor API usage and performance
4. Consider implementing rate limiting for production use