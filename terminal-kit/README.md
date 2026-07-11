# Terminal Kit (tk)

A CLI tool to initialize multi-team agent workflow assets for AI orchestration.

## Installation

```bash
# From the terminal-kit directory
npm install
npm run build
npm link
```

This creates a global `tk` command.

## Usage

```bash
# Navigate to your project
cd /path/to/your/project

# Initialize workflow assets
tk init

# Initialize with custom API URL
tk init --api-url http://localhost:3000

# Force overwrite existing files
tk init --force

# Skip documentation files
tk init --no-docs
```

## What Gets Created

```
your-project/
├── .agent-comms/           # Cross-terminal communication
│   ├── requests/           # PM -> Leader Agent requests
│   ├── responses/          # Leader Agent -> PM responses
│   ├── status/             # Real-time status files
│   ├── shared/findings/    # Research results cache
│   └── README.md           # Quick reference
├── .mcp.json               # MCP server configuration
├── .gemini/
│   └── settings.json       # Gemini agent settings
├── .claude/
│   └── settings.local.json # Claude agent permissions
└── docs/
    └── multi-team-agent-workflow.md  # Protocol documentation
```

## CLI Options

```
Usage: tk <command> [options]

Commands:
  init    Initialize multi-team agent workflow assets

Options:
  -V, --version     Show version number
  -h, --help        Display help

Init Options:
  -f, --force       Overwrite existing files without prompting
  --no-docs         Skip documentation files
  --api-url <url>   Set custom API URL (default: http://localhost:42031)
```

## Multi-Team Workflow Overview

This tool sets up infrastructure for the following team structure:

```
Terminal A (Development Team)     Terminal B (Research Team)
┌─────────────────────────┐       ┌─────────────────────────┐
│   Project Manager       │       │   Leader Agent          │
│   ├── Architect         │ <---> │   └── Explorer Agent    │
│   ├── Implementer       │ file  │                         │
│   └── QA/Reviewer       │ based │                         │
└─────────────────────────┘       └─────────────────────────┘
```

## Requirements

- Node.js >= 18.0.0
- Auto-Terminal API server running (for MCP integration)

## License

MIT
