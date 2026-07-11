# Agent-Monitor Headless Mode Integration

## Overview

Agent-Monitor now supports Auto-Terminal's headless mode, enabling AI agent teams to run without a graphical interface. This is ideal for server environments, CI/CD pipelines, and automated development workflows.

## Features

- **Independent Terminal Processes**: Each agent gets its own isolated terminal process
- **Headless Auto-Terminal Integration**: Direct integration with Auto-Terminal's headless mode
- **Automatic Mode Detection**: Seamlessly switches between UI and headless modes
- **Enhanced Monitoring**: Real-time monitoring of headless terminal processes
- **Improved Performance**: Reduced resource overhead compared to UI mode

## Architecture

### Headless Mode Components

1. **HeadlessAutoTerminalClient**: Enhanced client for headless operations
2. **HeadlessConfig**: Configuration management for headless mode
3. **Automatic Fallback**: Falls back to UI mode if headless is unavailable

### Terminal Management

- **UI Mode**: All agents share a tab with unique process IDs
- **Headless Mode**: Each agent gets an independent terminal process
- **Event Monitoring**: Unified event handling for both modes

## Getting Started

### Prerequisites

1. **Auto-Terminal**: Must be running in headless mode
2. **Node.js**: Version 16+ required
3. **Dependencies**: All agent-monitor dependencies installed

### Starting Auto-Terminal Headless Mode

```bash
# From auto-terminal directory
npm run start:headless
```

### Using Agent-Monitor with Headless Mode

#### Option 1: Automatic Startup (Recommended)
```bash
# Automatically starts Auto-Terminal in headless mode if needed
npm run team:headless

# Or with specific config
npm run team:headless:config team-config.json
```

#### Option 2: Manual Startup
```bash
# Start Auto-Terminal headless mode first
cd ../auto-terminal
npm run start:headless

# Then start agent-monitor in headless mode
cd ../agent-monitor
USE_HEADLESS_MODE=true npm run team:start team-config.json
```

#### Option 3: Force UI Mode
```bash
# Force UI mode even if headless is available
npm run team:ui team-config.json
```

## Configuration

### Environment Variables

```bash
# Headless mode configuration
USE_HEADLESS_MODE=true                    # Enable/disable headless mode
AUTO_TERMINAL_API_URL=http://localhost:3001   # Auto-Terminal API URL
AUTO_TERMINAL_WS_URL=ws://localhost:9876      # Auto-Terminal WebSocket URL
AUTO_TERMINAL_TOKEN=dev-token                 # Authentication token

# Project configuration
PROJECT_FOLDER=/path/to/project              # Working directory for agents
DEFAULT_SHELL=powershell                     # Default shell type
```

### Team Configuration

Your existing `team-config.json` works unchanged. Headless mode is controlled by environment variables and startup method.

```json
{
  "teamConfig": {
    "projectName": "My Project",
    "projectFolder": "C:/projects/my-project",
    "chatHubChannel": 1
  },
  "agents": [
    {
      "id": "coordinator",
      "name": "Project Coordinator",
      "role": "Project Coordinator",
      "shellProfile": "powershell",
      "cliCommand": "claude",
      "aiType": "Claude"
    }
  ]
}
```

## Testing

### Quick Integration Test
```bash
# Test headless integration
node test-headless-integration.js
```

This test validates:
- ✅ API connectivity to Auto-Terminal
- ✅ WebSocket connection
- ✅ Terminal creation and management
- ✅ Input/output operations

### Manual Testing
```bash
# 1. Start Auto-Terminal headless
cd ../auto-terminal
npm run start:headless

# 2. Test API
curl http://localhost:3001/api/health

# 3. Start agent team
cd ../agent-monitor
npm run team:headless
```

## Benefits of Headless Mode

### Performance Improvements
- **Lower Resource Usage**: No GUI rendering overhead
- **Faster Startup**: No Electron window creation
- **Independent Processes**: Each agent has isolated terminal environment
- **Reduced Memory**: Typically 30-50% less memory usage

### Operational Advantages
- **Server Deployment**: Run on headless servers and containers
- **CI/CD Integration**: Perfect for automated development pipelines
- **Remote Management**: Control via terminal-monitor web interface
- **Scalability**: Support for larger agent teams

### Development Benefits
- **Faster Iteration**: Quicker startup and shutdown cycles
- **Better Isolation**: Agent processes don't interfere with each other
- **Enhanced Monitoring**: More detailed process-level monitoring
- **Debugging**: Easier to trace individual agent activities

## Monitoring

### Terminal-Monitor Integration

The terminal-monitor web interface works seamlessly with headless mode:

```bash
# Start web monitoring interface
cd ../terminal-monitor
npm start

# Access at http://localhost:3000
```

### Real-time Monitoring Features
- **Process Status**: Monitor individual agent terminal processes
- **Output Streaming**: Real-time terminal output display
- **Performance Metrics**: CPU, memory, and activity tracking
- **Event History**: Complete audit trail of agent activities

## Troubleshooting

### Common Issues

#### Auto-Terminal Not Starting
```bash
# Check if Auto-Terminal is already running
curl http://localhost:3001/api/health

# Kill existing processes if needed
npx kill-port 3001
npx kill-port 9876

# Start fresh
npm run start:headless
```

#### Connection Errors
```bash
# Verify Auto-Terminal is in headless mode
curl http://localhost:3001/api/health
# Should return: {"mode": "headless", "status": "ok"}

# Check WebSocket connectivity
# Use browser dev tools or WebSocket client
```

#### Agent Terminal Creation Failures
```bash
# Check available shells
curl http://localhost:3001/api/terminals

# Verify project folder exists and is accessible
# Check environment variables are set correctly
```

### Fallback to UI Mode

If headless mode fails, agent-monitor automatically falls back to UI mode:

```
⚠️ Failed to initialize headless mode: [error details]
⚠️ Falling back to UI mode
```

### Debug Logging

Enable debug logging for troubleshooting:

```bash
DEBUG=agent-monitor:* npm run team:headless
```

## Migration from UI Mode

### Existing Projects
No changes required to existing team configurations. Simply change the startup command:

```bash
# Before (UI mode)
npm run team:start team-config.json

# After (headless mode)
npm run team:headless team-config.json
```

### Configuration Updates
Environment variables take precedence over hardcoded values:

```bash
# Override project folder
PROJECT_FOLDER=/new/project/path npm run team:headless

# Override shell type
DEFAULT_SHELL=bash npm run team:headless
```

## Advanced Usage

### Custom Headless Configuration

Create a custom headless configuration:

```javascript
// custom-headless-config.js
const { getHeadlessConfig } = require('./src/headless-config');

const config = getHeadlessConfig();
config.terminalConfig.defaultShell = 'bash';
config.terminalConfig.environment.CUSTOM_VAR = 'value';

module.exports = config;
```

### Programmatic Usage

```javascript
const { TeamOrchestrator } = require('./src/team-orchestrator');
const { HeadlessAutoTerminalClient } = require('./src/headless-client');

// Create orchestrator with headless mode
const orchestrator = new TeamOrchestrator(
  client,
  detector,
  promptManager,
  configPath,
  chatHubUrl,
  true // Enable headless mode
);

await orchestrator.startTeam();
```

## Best Practices

### Performance Optimization
- Use headless mode for server deployments
- Monitor resource usage with terminal-monitor
- Adjust agent count based on server capacity
- Use appropriate shell types for your platform

### Security Considerations
- Use proper authentication tokens in production
- Restrict API access to authorized clients only
- Monitor terminal processes for security violations
- Use HTTPS/WSS in production environments

### Operational Guidelines
- Test headless integration before production deployment
- Monitor agent health and process status
- Have fallback procedures for headless mode failures
- Maintain separate configurations for different environments

## Support and Troubleshooting

### Getting Help
- Check the test script output for connectivity issues
- Review Auto-Terminal logs for API errors
- Monitor agent-monitor output for orchestration issues
- Use terminal-monitor for visual debugging

### Common Solutions
- Restart Auto-Terminal if API becomes unresponsive
- Check firewall settings for port 3001 and 9876
- Verify Node.js version compatibility
- Ensure sufficient system resources for agent processes