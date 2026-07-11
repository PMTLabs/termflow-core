# Auto-Terminal Orchestration Platform 🚀

A comprehensive AI agent orchestration platform consisting of three integrated projects that enable collaborative software development through intelligent automation.

## 🏗️ Platform Architecture

This repository contains a complete orchestration ecosystem for AI agent teams:

### 1. **Auto-Terminal** (Core Platform)
A modern, cross-platform terminal emulator built with Tauri, React, and TypeScript. Serves as the foundation for AI agent operations with advanced shell management and developer APIs.

### 2. **Terminal-Monitor** (Management Client)
A React-based web application for monitoring and controlling headless Auto-Terminal instances. Provides real-time visualization and management of terminal operations.

### 3. **Agent-Monitor** (AI Orchestration)
A server-based application for provisioning and monitoring AI agents (Claude Code, Gemini, etc.) running in terminals. Enables intelligent team coordination and task distribution.

## 🤖 AI Agent Team Orchestration

The three projects work together to create a powerful development environment where AI agents can:
- **Collaborate simultaneously** on complex software projects
- **Assume specialized roles** (Frontend, Backend, QA, Architecture, etc.)
- **Communicate through shared terminals** and real-time event streams
- **Maintain persistent sessions** with automatic recovery capabilities
- **Scale dynamically** based on project complexity and requirements

## ✨ Platform Features

### Auto-Terminal (Core)
- **🔄 Multi-Tab Interface**: Create and switch between multiple terminal sessions
- **📱 Split Panes**: Divide your workspace with resizable terminal panes  
- **🐚 Multi-Shell Support**: CMD, PowerShell, Git Bash, WSL, and more
- **💾 Session Persistence**: Automatically saves and restores all tabs/panes on restart
- **⚙️ Configuration Management**: User preferences saved to config.json
- **📐 Layout Management**: Save, load, and switch between terminal layouts
- **🎨 Modern UI**: Clean interface with drag-and-drop tab management
- **⚡ Performance**: Optimized with WebGL rendering and terminal caching
- **🔌 Developer API**: WebSocket and REST APIs for automation
- **🖥️ Cross-Platform**: Windows, macOS, and Linux support

### Terminal-Monitor (Client)
- **🔐 JWT Authentication**: Secure API access with token management
- **📊 Real-time Monitoring**: Live terminal output via WebSocket connections
- **🎛️ Multi-Terminal Control**: Manage multiple terminals from web interface
- **📝 Interactive Input**: Command execution with special key support
- **🌙 Dark Theme**: Optimized interface for terminal viewing
- **📱 Responsive Design**: Works on desktop, tablet, and mobile devices

### Agent-Monitor (Orchestration)
- **🖥️ Headless Mode Support**: Runs AI agents in headless mode for server deployments
- **🤖 AI Agent Detection**: Automatically identifies running AI agents (Claude, Gemini)
- **📈 Performance Metrics**: Tracks response times and session statistics  
- **🔄 Prompt Lifecycle**: Monitors AI interactions from start to finish
- **👥 Team Coordination**: Orchestrates multiple agents working together
- **💾 Session Management**: Save and restore team sessions with crash recovery
- **🧠 Smart Task Distribution**: Intelligent assignment based on agent capabilities
- **🔔 Real-time Alerts**: Discord integration for team notifications
- **📊 Analytics Dashboard**: Comprehensive insights into team performance

## 🚀 Quick Start Guide

### Prerequisites
- Node.js 18+
- npm or yarn

### 1. Auto-Terminal Setup (Core Platform)

```bash
# Clone the repository
git clone <repository-url>
cd auto-terminal

# Install dependencies
npm install

# Start development server (Tauri mode)
npm run dev:tauri
```

### 2. Terminal-Monitor Setup (Management Client)

```bash
# Navigate to terminal-monitor
cd terminal-monitor

# Install dependencies
npm install

# Start the React application
npm start
```

### 3. Agent-Monitor Setup (AI Orchestration)

```bash
# Navigate to agent-monitor
cd agent-monitor

# Install dependencies
npm install

# Build the project
npm run build

# Configure environment (see agent-monitor/.env.example)
cp env.example .env
# Edit .env with your API tokens

# Start agent orchestration
npm start
```

### 4. Team Orchestration Quick Start

#### Headless Mode (Recommended for Servers)
```bash
cd agent-monitor

# Automatically start Auto-Terminal in headless mode and run team
npm run team:headless team-config.json

# Test headless integration
node test-headless-integration.js
```

#### UI Mode (Traditional)
```bash
cd agent-monitor

# Start with Auto-Terminal GUI
npm run team:ui team-config.json

# Monitor team progress via Terminal-Monitor
# Access web interface at http://localhost:42030

# Resume team session after interruption
npm run team:start team-config.json --resume
```

## 📖 Platform Usage

### 🔄 Orchestration Workflow

The three projects work together in a coordinated workflow:

1. **Auto-Terminal** provides the core terminal infrastructure and APIs
2. **Terminal-Monitor** offers web-based monitoring and control interface  
3. **Agent-Monitor** orchestrates AI agents and manages team collaboration

### 🤖 AI Agent Team Development

**Setting up a Development Team:**
```bash
# 1. Configure team roles and responsibilities
cd agent-monitor
cp team-config.json my-project-team.json
# Edit team configuration for your project needs

# 2. Start the orchestration platform (headless mode recommended)
npm run team:headless my-project-team.json

# 3. Monitor progress via web interface
# Terminal-Monitor: http://localhost:42030
# Agent status and coordination visible in real-time
```

**Typical Agent Roles:**
- **Project Coordinator**: Overall project management and task distribution
- **Frontend Developer**: UI/UX implementation and client-side features
- **Backend Developer**: Server-side logic and API development  
- **QA Engineer**: Testing, validation, and quality assurance
- **DevOps Engineer**: Deployment, CI/CD, and infrastructure
- **Security Analyst**: Security reviews and vulnerability assessment

### 🖥️ Auto-Terminal Operations
- **New Tab**: Click the "+" button or use Ctrl+T
- **Close Tab**: Click the "×" on any tab or use Ctrl+W
- **Switch Tabs**: Click on tabs or use Ctrl+1-9
- **Split Panes**: Use the split buttons in terminal headers
- **API Access**: REST and WebSocket endpoints on port **42031**

### 🌐 Terminal-Monitor Control
- **Authentication**: JWT-based secure access
- **Terminal Selection**: Click on terminals in the list view
- **Command Execution**: Type commands and use special key buttons
- **Real-time Output**: Live terminal streaming with syntax highlighting
- **Multi-Terminal**: Manage multiple terminals simultaneously

### 🎯 Agent-Monitor Coordination
- **Team Management**: Add/remove agents, assign roles and responsibilities
- **Task Distribution**: Intelligent workload balancing across team members
- **Progress Tracking**: Real-time monitoring of individual and team progress
- **Session Persistence**: Automatic save/restore for crash recovery
- **Communication**: Discord integration for alerts and notifications

## 🛠️ Development

### 📂 Project Structure

The platform is organized into three major components. For a detailed breakdown of directories and files, please refer to [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md).

### 🔌 Ports Summary

The platform uses the following ports for its integrated services:

| Port | Service | Description |
| :--- | :--- | :--- |
| **42010** | Frontend Dev Server | React/Tauri development server (served via Webpack) |
| **42030** | Terminal Monitor UI | Main interface for the standalone `terminal-monitor` |
| **42031** | Auto-Terminal API | Core Unified API (REST + WebSocket) |
| **42501** | ChatHub REST/SignalR | Production endpoint for agent collaboration hub |
| **42888** | ChatHub WS | Alternative/Dev port for ChatHub communication |

### Technology Stack

**Auto-Terminal (Core):**
- **Core**: Tauri 2.0 with Rust backend
- **Frontend**: React + Redux with TypeScript
- **Terminal**: xterm.js with WebGL acceleration
- **PTY**: portable-pty (Rust)
- **Build**: Vite/Webpack with hot-reload
- **APIs**: Axum (Rust) REST + WebSocket servers

**Terminal-Monitor (Client):**
- **Frontend**: React + TypeScript + Material-UI
- **State**: Redux Toolkit with RTK Query
- **Communication**: Axios + Socket.io client
- **Authentication**: JWT with automatic refresh

**Agent-Monitor (Orchestration):**
- **Runtime**: Node.js + TypeScript
- **AI Integration**: Claude Code CLI, Gemini CLI
- **Communication**: WebSocket + REST API clients
- **Persistence**: JSON-based session storage
- **Notifications**: Discord webhook integration

### Available Scripts

**Auto-Terminal:**
- `npm run dev` - Start development with hot-reload and API
- `npm run build` - Build for production
- `npm run dist` - Create distributable packages
- `npm test` - Run tests

**Terminal-Monitor:**
- `npm start` - Start React development server
- `npm run build` - Build optimized production bundle
- `npm test` - Run component and integration tests

**Agent-Monitor:**
- `npm start` - Start agent monitoring
- `npm run build` - Compile TypeScript
- `npm run team:start <config>` - Start team orchestration
- `npm run team:session <config>` - Check team session status

## 🐛 Recent Updates (Jan 19, 2025)

### ✅ New Features
- **Session Persistence**: Full session restoration with all tabs and panes
- **Configuration Management**: Settings saved to `%APPDATA%/auto-terminal/config.json`
- **Auto-Save**: State automatically saved every 30 seconds
- **Layout Management**: Save and restore custom terminal layouts
- **Production Build**: Fixed packaged app loading issues

### ✅ Bug Fixes
- **New Tab Functionality**: Fixed shell profile initialization and TypeScript typing
- **Tab Switching**: Implemented per-tab pane management for proper switching  
- **Shell Selection**: Created semantic profile ID mapping for accurate shell launching
- **Content Persistence**: Terminal instance caching preserves history across tab switches
- **Windows Compatibility**: Eliminated ConPTY errors with platform-specific cleanup
- **Signal Handling**: Added Windows-compatible PTY process termination

## 📋 System Requirements

### Windows
- Windows 10/11
- PowerShell 5.1+ (for PowerShell terminals)
- Git for Windows (for Git Bash)

### macOS
- macOS 10.14+
- Xcode Command Line Tools

### Linux
- Ubuntu 18.04+ / equivalent
- bash, zsh, or fish shell

## 🔌 API Documentation

Auto-Terminal includes a comprehensive API for automation:

### WebSocket API
```javascript
const ws = new WebSocket('ws://localhost:42031/api/ws');
ws.on('terminal:data', (data) => {
  console.log('Terminal output:', data);
});
```

### API Authentication
The server uses JWT (JSON Web Tokens) for authentication. By default, the secret is `dev-secret-key`, but it can be configured via environment variables.

#### Obtain a Token
```bash
curl -X POST http://localhost:42031/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"clientId": "my-app", "permissions": ["*"]}'
```
Response:
```json
{
  "token": "eyJhbG...",
  "expiresIn": "24h",
  "permissions": ["*"]
}
```

### REST API
```bash
# Create new terminal
curl -X POST http://localhost:42031/api/terminals \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"profile": "bash", "name": "My Terminal"}'

# Send command
curl -X POST http://localhost:42031/api/terminals/{id}/input \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"data": "ls -la\n"}'

# Execute CLI prompt (Claude, Gemini, etc.)
curl -X POST http://localhost:42031/api/terminals/{id}/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"prompt": "Write hello world in Python", "cliType": "claude"}'

# Alias for execute
# curl -X POST http://localhost:42031/api/terminals/{id}/prompt ...

```

### Advanced Endpoints

#### System & Process Metrics
- `GET /api/system/info`: General system information.
- `GET /api/system/metrics`: CPU and Memory usage.
- `GET /api/processes`: List active processes running in terminals.
- `GET /api/processes/{id}/metrics`: Detailed resource usage for a specific terminal process.

#### Recording & Search
- `POST /api/recordings/start`: Begin recording terminal output.
- `POST /api/recordings/stop/{id}`: Stop recording and save to disk.
- `POST /api/search`: Search across terminal history or recorded sessions.
- `GET /api/search/suggestions`: Get search term suggestions.

#### Layout & Testing
- `GET /api/layout`: Retrieve current window/pane layout.
- `POST /api/layout`: Save current layout for future restoration.
- `POST /api/test/capture-backend`: Capture backend state for debugging/testing.

---

### Sending Input to Claude CLI

When interacting with Claude CLI via the API, you have two options:

#### Option 1: Use the Prompt Execution Endpoint (Recommended)
```json
POST /api/terminals/{id}/execute
{
  "prompt": "Write hello world in Python",
  "cliType": "claude",
  "submissionSignal": "\x1b\r"
}
```

For more details on `submissionSignal` and platform-specific behavior, see [docs/API_SUBMISSION_SIGNALS.md](docs/API_SUBMISSION_SIGNALS.md).


#### Option 2: Manual Input Control
```json
// Start Claude CLI
POST /api/terminals/{id}/input
{
  "data": "claude\n"
}

// Send a prompt to Claude CLI (requires Escape followed by two carriage returns)
POST /api/terminals/{id}/input
{
  "data": "Write hello world in Python\u001b\r\r"
}

// Exit Claude CLI
POST /api/terminals/{id}/input
{
  "data": "\u0004"  // Ctrl+D
}
```

The Claude CLI input format is: `prompt text` + `\u001b` (Escape) + `\r\r` (two carriage returns)

### Control Character Reference

| Key Combination | Unicode | Description |
|----------------|---------|-------------|
| Ctrl+A | `\u0001` | Start of heading |
| Ctrl+B | `\u0002` | Start of text |
| Ctrl+C | `\u0003` | End of text (interrupt) |
| Ctrl+D | `\u0004` | End of transmission (EOF) |
| Ctrl+E | `\u0005` | Enquiry |
| Ctrl+F | `\u0006` | Acknowledge |
| Ctrl+G | `\u0007` | Bell |
| Ctrl+H | `\u0008` | Backspace |
| Ctrl+I | `\u0009` or `\t` | Tab |
| Ctrl+J | `\u000a` or `\n` | Line feed (Enter) |
| Ctrl+K | `\u000b` | Vertical tab |
| Ctrl+L | `\u000c` | Form feed (clear screen) |
| Ctrl+M | `\u000d` or `\r` | Carriage return |
| Ctrl+N | `\u000e` | Shift out |
| Ctrl+O | `\u000f` | Shift in |
| Ctrl+P | `\u0010` | Data link escape |
| Ctrl+Q | `\u0011` | Device control 1 (XON) |
| Ctrl+R | `\u0012` | Device control 2 |
| Ctrl+S | `\u0013` | Device control 3 (XOFF) |
| Ctrl+T | `\u0014` | Device control 4 |
| Ctrl+U | `\u0015` | Negative acknowledge |
| Ctrl+V | `\u0016` | Synchronous idle |
| Ctrl+W | `\u0017` | End of transmission block |
| Ctrl+X | `\u0018` | Cancel |
| Ctrl+Y | `\u0019` | End of medium |
| Ctrl+Z | `\u001a` | Substitute (suspend) |
| Escape | `\u001b` | Escape (Submit in Claude CLI) |

### Arrow Keys (ANSI Escape Sequences)
| Key | Sequence | Description |
|-----|----------|-------------|
| Up Arrow | `\u001b[A` | Move cursor up |
| Down Arrow | `\u001b[B` | Move cursor down |
| Right Arrow | `\u001b[C` | Move cursor right |
| Left Arrow | `\u001b[D` | Move cursor left |

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with [Tauri](https://tauri.app/)
- Terminal rendering by [xterm.js](https://xtermjs.org/)
- PTY support via [portable-pty](https://github.com/wez/wezterm/tree/main/pty)
- UI framework: [React](https://reactjs.org/)

---

**Status**: ✅ Fully Functional | **Quality**: 🏆 Production Ready | **Maintenance**: ⚡ Active