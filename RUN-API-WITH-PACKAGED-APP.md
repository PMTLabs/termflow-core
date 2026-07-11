# Running API Server with Packaged Auto-Terminal

This guide explains how to run the API server alongside the packaged Auto-Terminal application.

## Quick Start

### Option 1: Run API Server Separately (Recommended)

1. **Package the application:**
   ```bash
   npm run package:win
   ```

2. **Start the packaged app:**
   ```bash
   cd dist-electron/auto-terminal-win32-x64
   auto-terminal.exe
   ```

3. **In a separate terminal, start the API server:**
   ```bash
   # Navigate back to project root
   cd D:\sources\work\termflow\termflow-core
   
   # Start API server
   npm run api:dev
   ```

The API server will start on port 3001 and display JWT tokens in the console.

### Option 2: Create a Batch Script

Create `start-auto-terminal-with-api.bat`:

```batch
@echo off
echo Starting Auto-Terminal with API Server...

REM Set configuration
set JWT_SECRET=your-secret-key-here
set API_PORT=3001
set WS_PORT=9876

REM Start API server in background
echo Starting API server...
start /B cmd /c "cd /d %~dp0 && npm run api"

REM Wait for API to initialize
timeout /t 3 /nobreak > nul

REM Start Auto-Terminal
echo Starting Auto-Terminal...
cd dist-electron\auto-terminal-win32-x64
start auto-terminal.exe

echo.
echo Auto-Terminal is running with API server
echo API endpoints available at http://localhost:3001
echo.
echo Press any key to stop the API server...
pause > nul

REM Kill the API server
taskkill /F /FI "WINDOWTITLE eq npm*" > nul 2>&1
```

### Option 3: Use Process Manager (PM2)

Install PM2:
```bash
npm install -g pm2
```

Create `ecosystem.config.js`:
```javascript
module.exports = {
  apps: [
    {
      name: 'auto-terminal-api',
      script: 'start-api-server.js',
      env: {
        JWT_SECRET: 'your-secret-key',
        API_PORT: 3001,
        WS_PORT: 9876
      }
    }
  ]
};
```

Start the API:
```bash
pm2 start ecosystem.config.js
pm2 logs auto-terminal-api
```

Then run the packaged app normally.

## Testing the Connection

1. **Get a JWT token** from the API console output or generate one:
   ```javascript
   const jwt = require('jsonwebtoken');
   const token = jwt.sign(
     { sub: 'test-app', permissions: ['*'] },
     'dev-secret-key', // or your JWT_SECRET
     { expiresIn: '24h' }
   );
   console.log(token);
   ```

2. **Test the API:**
   ```bash
   # Health check
   curl http://localhost:3001/api/health
   
   # List terminals (requires auth)
   curl http://localhost:3001/api/terminals \
     -H "Authorization: Bearer YOUR_TOKEN_HERE"
   ```

## Example Integration Script

Create `control-terminal.js`:

```javascript
const axios = require('axios');

// Configuration
const API_URL = 'http://localhost:3001';
const TOKEN = 'YOUR_JWT_TOKEN'; // Get from API console

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json'
  }
});

async function demo() {
  try {
    // Check API health
    const health = await api.get('/api/health');
    console.log('API Status:', health.data);
    
    // Create a terminal
    const { data: terminal } = await api.post('/api/terminals', {
      profile: 'cmd'
    });
    console.log('Created terminal:', terminal.id);
    
    // Send a command
    await api.post(`/api/terminals/${terminal.id}/input`, {
      data: 'echo Hello from API!\r\n'
    });
    
    // Wait for output
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Get output
    const { data: output } = await api.get(`/api/terminals/${terminal.id}/output`);
    console.log('Output:', output.lines.join('\n'));
    
    // Clean up
    await api.delete(`/api/terminals/${terminal.id}`);
    console.log('Terminal closed');
    
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

demo();
```

## Production Deployment

For production, consider:

1. **Windows Service** - Use `node-windows` to install the API as a service
2. **Docker** - Containerize the API server
3. **Reverse Proxy** - Use nginx to proxy both app and API
4. **Authentication** - Implement proper token management

## Troubleshooting

### Port conflicts
If port 3001 is in use:
```bash
# Find process using port
netstat -ano | findstr :3001

# Kill process by PID
taskkill /F /PID <PID>

# Or use different port
set API_PORT=3002
npm run api
```

### Firewall issues
- Add firewall exception for Node.js
- Or use Windows Firewall with Advanced Security to allow ports 3001 and 9876

### Token errors
- Ensure JWT_SECRET matches between token generation and API server
- Check token expiration
- Verify token format (Bearer prefix required)

## Benefits of Separate API Server

1. **Stability** - API crashes don't affect the terminal app
2. **Scalability** - Can run multiple terminal instances with one API
3. **Development** - Easier to debug and update independently
4. **Security** - Can implement rate limiting and authentication separately

## Next Steps

1. Set up the API server to start automatically on Windows startup
2. Implement proper logging and monitoring
3. Add SSL/TLS for secure communication
4. Create a service wrapper for easier management