# Auto-Terminal Agent Monitor

Monitor AI agents (Claude CLI, Gemini CLI) running in Auto-Terminal with real-time event tracking and prompt lifecycle management.

## Recent Updates Compatibility

This sample has been updated to work with the latest Auto-Terminal API changes:

### ✅ API Terminal ID Format
- The monitor now handles the new `api-terminal-` prefixed IDs correctly
- Terminal creation returns unique API IDs instead of reusing tab/UI IDs

### ✅ TabId and PaneId Support
- `TerminalInfo` interface updated to include `tabId` and `paneId` fields
- The monitor can track which tab and pane each terminal belongs to
- Useful for correlating UI state with terminal processes

### ✅ Profile Parameter Support
- Terminal creation now correctly uses the specified shell profile
- Supports 'cmd', 'powershell', 'bash' and other configured profiles
- The monitor displays the actual profile used for each terminal

## 📚 Multi-Agent Team Collaboration

This system supports advanced multi-agent development teams working together on software projects:

- **[teamwork.md](teamwork.md)** - Complete team collaboration framework and communication protocols
- **[TEAMWORK-INTEGRATION-GUIDE.md](TEAMWORK-INTEGRATION-GUIDE.md)** - How to integrate team collaboration into your project's CLAUDE.md
- **[CLAUDE-PROJECT-EXAMPLE.md](CLAUDE-PROJECT-EXAMPLE.md)** - Example project setup with team integration
- **[TEAM-ORCHESTRATION-GUIDE.md](TEAM-ORCHESTRATION-GUIDE.md)** - Complete guide to team orchestration with headless mode support
- **[HEADLESS-MODE.md](HEADLESS-MODE.md)** - Complete headless mode documentation and migration guide
- **[README-SIGNALR-UPDATE.md](README-SIGNALR-UPDATE.md)** - SignalR ChatHub integration details

### Quick Start for Team Orchestration

#### Headless Mode (Recommended for Servers/CI/CD)
```bash
# Automatically start Auto-Terminal in headless mode and run team
npm run team:headless team-config.json

# Test headless integration
node test-headless-integration.js
```

#### UI Mode (Traditional)
```bash
# Start with Auto-Terminal GUI (ensure Auto-Terminal is running)
npm run team:ui team-config.json

# Or use the original command
npm run team:start team-config.json
```

#### Session Management
```bash
# Check saved session status
npm run team:session team-config.json

# Resume from previous session
npm run team:start team-config.json --resume
```

### 🖥️ Headless Mode Support

Agent-Monitor now supports **Auto-Terminal's headless mode** for server deployments and automated workflows:

- **Independent Processes**: Each agent gets its own isolated terminal process
- **Server-Friendly**: Perfect for headless servers and containerized environments  
- **Performance**: 30-50% reduced memory usage compared to UI mode
- **Monitoring**: Full compatibility with terminal-monitor web interface

See **[HEADLESS-MODE.md](HEADLESS-MODE.md)** for complete documentation.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Build the project:
```bash
npm run build
```

3. Configure API token:
```bash
# IMPORTANT: Auto-Terminal generates a new JWT secret on each startup
# You must get a fresh token from the running instance:

# Option 1: Use Developer Console in Auto-Terminal
# Press Ctrl+Shift+I, then run in console:
# await window.electronAPI.generateAPIToken('agent-monitor', ['*'])

# Option 2: Run the helper script for instructions
node get-valid-token.js

# Then update your .env file with the token:
API_TOKEN=your-fresh-token-here
```

4. Start Auto-Terminal and ensure the API server is running on port 3001

5. Run the monitor:
```bash
npm start
```

## Features

- 🔍 **AI Agent Detection**: Automatically detects when Claude CLI, Gemini CLI, or other AI agents are running
- 📊 **Prompt Lifecycle Tracking**: Monitors prompt execution from start to finish
- ⏱️ **Performance Metrics**: Tracks response times and session statistics
- 🔄 **Automatic Prompt Chaining**: Queue multiple prompts for sequential execution
- 🌐 **WebSocket Integration**: Real-time event streaming from Auto-Terminal with automatic reconnection
- 📝 **Session Management**: Track and analyze AI interaction sessions
- 🎯 **Claude Desktop Support**: Full support for Claude Desktop's rich terminal UI
- 💓 **Heartbeat Support**: Maintains persistent WebSocket connections with heartbeat mechanism
- 👥 **Multi-Agent Team Orchestration**: Coordinate teams of AI agents working together
- 🧠 **Smart Idle Detection**: Intelligently manages idle agents without spam
- 💾 **Resume Capability**: Save and restore team sessions after crashes/restarts

## Usage Examples

### Basic Monitoring
```bash
# Start monitoring all active terminals
npm start
```

### Demo Mode
```bash
# Create a demo terminal and run example prompts
npm start -- --demo
```

### Testing API Changes
```bash
# Run the API test script to verify recent updates
node test-api.js
```

## API Endpoints Used

- `GET /api/terminals` - List all terminals with new ID format
- `POST /api/terminals` - Create terminals with profile support
- `GET /api/ui/tabs` - Get UI structure with tab/pane information
- `GET /api/terminals/:id/output` - Retrieve terminal output
- `POST /api/terminals/:id/prompt` - Execute AI prompts
- WebSocket events for real-time monitoring

## Configuration

Edit the CONFIG object in `src/index.ts`:

```typescript
const CONFIG = {
  apiUrl: process.env.API_URL || 'http://localhost:3001',
  wsUrl: process.env.WS_URL || 'ws://localhost:9876',
  token: process.env.API_TOKEN || 'your-api-token-here',
  autoReconnect: true,
  reconnectInterval: 5000
};
```

## How It Works

1. **Connection**: The monitor connects to Auto-Terminal's API via WebSocket with JWT authentication
2. **Terminal Monitoring**: Subscribes to terminal output events and processes them in real-time
3. **Agent Detection**: Analyzes output patterns to detect AI CLI tools (Claude, Gemini, ChatGPT)
4. **Prompt Tracking**: Captures prompts and tracks their execution lifecycle
5. **Response Collection**: Intelligently collects and processes AI responses, handling:
   - ANSI escape sequences and terminal control codes
   - Claude Desktop's rich UI elements (box drawing, progress indicators)
   - Multi-line responses with proper formatting preservation
6. **Session Analysis**: Provides statistics and insights about AI interactions
7. **Automatic Queueing**: Processes multiple prompts sequentially with proper session management

## Example Output

```
Auto-Terminal Agent Monitor v1.0.0
Monitoring AI agents in Auto-Terminal

✓ Connected to Auto-Terminal
Found 2 active terminal(s)

Monitoring terminal: Main Terminal (term-1)
Process ID: proc-123

🤖 AI Agent Detected!
   Terminal: term-1
   Type: claude
   Time: 10:45:23 AM

📝 Prompt Started:
   Agent: claude
   Prompt: Write a haiku about monitoring software - add "PROCESS PROMPT COMPLETED" at the end
   Session ID: 5d3e6364-290c-4094-acae-8f2f1099b28d

✅ Prompt Completed:
   Session: 5d3e6364-290c-4094-acae-8f2f1099b28d
   Duration: 3421ms
   Response: Processes flowing,
            Metrics dance on silent screens—
            Watching code's heartbeat.  PROCESS PROMPT COMPLETED

🔄 Processing next queued prompt (2 remaining)
```

## Troubleshooting

### Common Issues

1. **Authentication Errors (401)**
   - Ensure your API token is valid and properly set in `.env`
   - Generate a new token using the Auto-Terminal console
   - Check that the WebSocket server is running on the correct port

2. **Response Not Detected**
   - The monitor handles various Claude Desktop UI elements
   - Ensure Claude is fully loaded before sending prompts
   - Check debug logs for response detection patterns

3. **WebSocket Disconnection**
   - The monitor includes automatic reconnection with exponential backoff
   - Heartbeat mechanism prevents timeout disconnections
   - Check network connectivity and firewall settings

4. **Duplicate Sessions**
   - The monitor prevents duplicate prompt detection
   - Sessions are properly tracked per terminal
   - Use `clearTerminal()` when switching contexts

### Connection Refused
- Make sure Auto-Terminal is running with `npm run dev`
- Verify API server is on port 3001
- Check WebSocket server is on port 9876
- If WebSocket connection fails but REST API works:
  - The WebSocket server should start automatically with the API server
  - Check the Auto-Terminal console for any WebSocket server errors
  - Ensure no other process is using port 9876 (`npx kill-port 9876`)
  - The agent-monitor will continue to work without WebSocket events (polling mode)

### Terminal Not Found
- Terminals created via API now have `api-terminal-` prefix
- Use the returned terminal ID from creation response
- Check `/api/terminals` to see all available terminals

## Development

### Build from source:

```bash
npm install
npm run build
```

### Run in development mode:

```bash
# Watch mode for development
npm run watch

# Run TypeScript directly
npm run dev
```

### Debug Mode

The agent-monitor includes extensive debug logging that can be enabled by uncommenting debug statements in:
- `src/agent-detector.ts` - For response detection debugging
- `src/index.ts` - For session management debugging

## Version History

### v2.1.0 (2025-01-22)
- **Smart Idle Detection**: Agents checked with Project Coordinator before activation
- **Resume Feature**: Save/restore team sessions after crashes
- **Enhanced Team Orchestration**: Better task assignment and monitoring
- **Improved Agent Management**: Tracks completion status per agent
- **Session Persistence**: Automatic saving every 60 seconds
- **Graceful Reconnection**: Handles missing terminals on resume

### v2.0.0 (2025-01-21)
- **Multi-Agent Team Support**: Full team orchestration capabilities
- **ChatHub Integration**: WebSocket monitoring and MCP tools
- **Discord Notifications**: Real-time alerts and escalations
- **Project Coordinator Monitoring**: Special handling for coordinator role
- **Aggressive Idle Detection**: 30-second checks for idle agents

### v1.0.0 (2025-01-21)
- Full Claude Desktop support with rich UI handling
- Robust ANSI escape sequence filtering
- Improved response detection and collection
- WebSocket heartbeat support
- Automatic session management
- Queue-based prompt execution
- Fixed duplicate session prevention
- Enhanced debugging capabilities

## License

MIT License - see LICENSE file for details