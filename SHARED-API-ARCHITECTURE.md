# Auto-Terminal Shared API Architecture

## Overview

The Auto-Terminal API server can now connect to and control terminals created in the Electron app through a shared terminal registry system.

## How It Works

### 1. Terminal Registry
When you create terminals in the Auto-Terminal app, they are automatically registered in a shared registry file:
- Location: `%APPDATA%\auto-terminal\terminal-registry.json`
- Updated in real-time as terminals are created/closed
- Contains terminal IDs, process IDs, and metadata

### 2. Shared PTY Manager
The API server uses a `SharedPTYManager` that:
- Reads from the terminal registry to discover terminals
- Writes commands to a shared command directory
- Cannot create new terminals (must use the app UI)

### 3. Command Flow

```
Auto-Terminal App                    API Server
       |                                 |
       |-- Creates Terminal -->          |
       |                                 |
       |-- Writes to Registry -->        |
       |                                 |
       |                          <-- Reads Registry
       |                                 |
       |                          <-- API: GET /terminals
       |                                 |
       |                          <-- API: POST /terminals/{id}/input
       |                                 |
       |<-- Reads Command File --        |
       |                                 |
       |-- Executes Command -->          |
```

## Quick Start

1. **Start the Auto-Terminal app**
   ```bash
   npm start
   ```

2. **Create some terminals in the app UI**
   - Use the New Tab dropdown
   - Create 2-3 terminals

3. **Start the API server**
   ```bash
   npm run api:dev
   ```

4. **Test the API**
   ```bash
   # Copy token from API console, then:
   node test-api-terminals.js YOUR_TOKEN
   ```

## API Endpoints in Shared Mode

### Available Endpoints
- `GET /api/terminals` - Lists terminals created in the app
- `GET /api/terminals/{id}` - Get specific terminal info
- `POST /api/terminals/{id}/input` - Send input to terminal
- `GET /api/terminals/{id}/output` - Get terminal output
- `POST /api/terminals/{id}/resize` - Resize terminal
- `DELETE /api/terminals/{id}` - Close terminal

### Disabled Endpoints
- `POST /api/terminals` - Cannot create terminals via API in shared mode

## File Locations

### Windows
```
%APPDATA%\auto-terminal\
├── terminal-registry.json    # Active terminals
├── terminal-commands\        # Command queue
│   ├── {id}-{timestamp}.cmd  # Command files
│   └── ...
└── config.json              # App configuration
```

### macOS
```
~/Library/Application Support/auto-terminal/
├── terminal-registry.json
├── terminal-commands/
└── config.json
```

### Linux
```
~/.config/auto-terminal/
├── terminal-registry.json
├── terminal-commands/
└── config.json
```

## Terminal Registry Format

```json
{
  "version": 1,
  "lastUpdated": "2024-01-20T10:30:00.000Z",
  "terminals": [
    {
      "id": "abc-123",
      "processId": "abc-123",
      "pid": 12345,
      "shell": "C:\\Windows\\System32\\cmd.exe",
      "createdAt": "2024-01-20T10:30:00.000Z",
      "cols": 80,
      "rows": 24
    }
  ]
}
```

## Command File Format

Commands are written as JSON files in the `terminal-commands` directory:

```json
{
  "type": "write|resize|kill",
  "processId": "abc-123",
  "data": "echo Hello\r\n",      // for write commands
  "cols": 120,                   // for resize commands
  "rows": 40,                    // for resize commands
  "signal": "SIGTERM",           // for kill commands
  "timestamp": "2024-01-20T10:30:00.000Z"
}
```

## Limitations

1. **No Terminal Creation** - Terminals must be created in the app UI
2. **One-Way Communication** - API can send commands but doesn't receive real-time output
3. **File-Based IPC** - Slight delay due to file system operations
4. **Local Only** - Both app and API must run on same machine

## Future Improvements

1. **Named Pipes/Sockets** - Replace file-based IPC with faster mechanisms
2. **Bidirectional Streaming** - Real-time output streaming to API clients
3. **Remote API** - Allow API to connect to app over network
4. **Terminal Creation** - Support creating terminals via API with proper security

## Debugging

### Check Registry
```powershell
# Windows
type %APPDATA%\auto-terminal\terminal-registry.json

# Unix
cat ~/.config/auto-terminal/terminal-registry.json
```

### Monitor Commands
```powershell
# Windows
dir %APPDATA%\auto-terminal\terminal-commands

# Unix
ls ~/.config/auto-terminal/terminal-commands
```

### Common Issues

1. **No terminals in API**
   - Ensure terminals are created in the app first
   - Check registry file exists and is readable
   - Verify API has correct permissions

2. **Commands not executing**
   - Check command files are being created
   - Ensure app is monitoring command directory
   - Look for errors in app console

3. **Wrong terminal IDs**
   - Use the Copy Terminal ID context menu in app
   - Terminal IDs may differ from what's shown in UI

## Example Usage

```javascript
const axios = require('axios');

async function controlTerminal() {
  const api = axios.create({
    baseURL: 'http://localhost:3001',
    headers: { 'Authorization': 'Bearer YOUR_TOKEN' }
  });
  
  // List terminals from app
  const { data: terminals } = await api.get('/api/terminals');
  console.log('App terminals:', terminals);
  
  if (terminals.length > 0) {
    const terminalId = terminals[0].id;
    
    // Send command
    await api.post(`/api/terminals/${terminalId}/input`, {
      data: 'dir\r\n'
    });
    
    // Resize
    await api.post(`/api/terminals/${terminalId}/resize`, {
      cols: 120,
      rows: 40
    });
  }
}
```