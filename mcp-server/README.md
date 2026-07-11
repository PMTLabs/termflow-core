# Auto-Terminal MCP Server

This is a **Model Context Protocol (MCP)** server that exposes the Auto-Terminal API to AI agents. It allows agents to list, create, and control terminal sessions using standardized tools.

## Architecture

The MCP server now supports **HTTP-based transport** (Streamable HTTP), allowing multiple AI clients to connect to a single shared server instance. This eliminates the need for each client to spawn its own process.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Claude Code    │     │  Claude Desktop │     │  Other Clients  │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │    HTTP POST/GET      │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   MCP Server (HTTP)     │
                    │   localhost:42032/mcp   │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   Auto-Terminal API     │
                    │   localhost:42031       │
                    └─────────────────────────┘
```

## Setup

1.  **Install Dependencies**:
    ```bash
    cd mcp-server
    npm install
    ```

2.  **Build**:
    ```bash
    npm run build
    ```

## Starting the Server

### Option 1: From Root Directory
```bash
# Production
npm run mcp

# Development (with watch mode)
npm run mcp:dev
```

### Option 2: From mcp-server Directory
```bash
cd mcp-server

# Production
npm start

# Development
npm run dev
```

The server will start on `http://localhost:42032/mcp` by default.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_PORT` | `42032` | Port for the MCP HTTP server |
| `AUTO_TERMINAL_API_URL` | `http://localhost:42031` | URL of the Auto-Terminal API |

## Connecting Clients

### Authentication

When **Expose on network** is enabled, every non-`/health` request must carry the
token as an HTTP header: `Authorization: Bearer <AUTO_TERMINAL_TOKEN>`. In localhost
mode the token is empty and auth is bypassed. The token belongs in `headers`, **not**
in an `env` map — `env` is a stdio concept and is ignored by HTTP/streamable-http
clients (putting it there causes silent 401s that look like a dropped connection).

### Claude Code (Streamable HTTP)

Add this to your `.mcp.json`:

```json
{
  "mcpServers": {
    "auto-terminal": {
      "type": "http",
      "url": "http://localhost:42032/mcp",
      "headers": { "Authorization": "Bearer <AUTO_TERMINAL_TOKEN>" }
    }
  }
}
```

(Claude Code expands `${VAR}` inside header values, so `"Bearer ${AUTO_TERMINAL_TOKEN}"`
keeps the token out of the file.)

### Gemini CLI (Streamable HTTP)

Gemini CLI uses `httpUrl` (not `type`+`url`) in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "auto-terminal": {
      "httpUrl": "http://localhost:42032/mcp",
      "headers": { "Authorization": "Bearer <AUTO_TERMINAL_TOKEN>" }
    }
  }
}
```

(Gemini CLI's `${VAR}` substitution in headers is unreliable — inline the literal
token and treat the file as a secret.)

### Legacy Stdio Mode (Single Client)

For clients that only support stdio transport:

```json
{
  "mcpServers": {
    "auto-terminal": {
      "command": "node",
      "args": [
        "D:\\sources\\demo\\auto-terminal\\mcp-server\\build\\index.js"
      ],
      "env": {
        "AUTO_TERMINAL_API_URL": "http://localhost:42031"
      }
    }
  }
}
```

Note: Stdio mode spawns a new process per client and does not share sessions between clients.


## Available Tools

*   `list_terminals`: List active terminal sessions.
*   `create_terminal`: Spawn a new terminal (args: `name`, `cols`, `rows`, `cwd`).
*   `execute_command`: Send a command to a terminal (args: `terminalId`, `command`, `cli_type`).
*   `get_terminal_output`: Read recent output from a terminal.
*   `close_terminal`: Terminate a session.

## Configuration

The server defaults to connecting to the Auto-Terminal API at `http://localhost:42031`. Ensure the Auto-Terminal application is running.
