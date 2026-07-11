# TermFlow 🚀

**TermFlow** is a modern, cross-platform terminal emulator built with **Tauri 2**, **React**, and **xterm.js**. Beyond a normal terminal, it exposes a local **developer API** (REST + WebSocket) and an **MCP server** so external tools and AI agents (Claude, Gemini, etc.) can inspect, drive, and automate terminal sessions programmatically.

This is the **open-core** repository (Apache-2.0). The optional multi-machine **peering** capability is provided by a separate, privately-licensed sidecar (`termflow-fabric`) and is **not** required to build or run the app — see [Open core](#-open-core).

> Status: pre-release (`0.1.0`). Platforms: Windows, macOS, Linux.

---

## ✨ Features

- **🔄 Multi-tab & split panes** — multiple sessions, resizable panes, drag-and-drop tabs, multi-window detach, per-tab/pane maximize (zoom)
- **🐚 Multi-shell** — CMD, PowerShell, Git Bash, WSL, bash/zsh/fish, and custom profiles
- **💾 Session & layout persistence** — tabs, panes, and scrollback are saved and restored on restart (SQLite-backed history)
- **🔎 In-terminal search**, **🎨 color schemes**, and a modern keyboard protocol (Kitty / `modifyOtherKeys`) for correct key handling in agentic CLIs
- **⚡ Performance** — xterm.js with WebGL rendering and terminal caching
- **🔌 Developer API** — REST + WebSocket server for automation (see [API](#-developer-api))
- **🤖 MCP server** — a Model Context Protocol sidecar exposing terminal tools to AI clients
- **🖥️ Cross-platform** — Windows, macOS, and Linux

Also included in this repo as companion tooling:
- **`terminal-monitor/`** — a React web dashboard for remotely viewing/controlling terminals over the API.
- **`agent-monitor/`** — a Node.js service for orchestrating AI agents running inside terminals.

---

## 🏗️ Build & Run

### Prerequisites

| Requirement | Notes |
| :--- | :--- |
| **[Bun](https://bun.sh)** | Package manager + JS runtime used throughout (`bun`, not `npm`). |
| **[Rust](https://rustup.rs) ≥ 1.88** | Tauri 2 backend (`cargo`). |
| **Tauri 2 system deps** | Platform-specific — follow the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/). Windows: Microsoft C++ Build Tools + WebView2 (preinstalled on Win 11). macOS: Xcode Command Line Tools. Linux: `webkit2gtk`, `libgtk`, etc. |

### Install & run (development)

```bash
# 1. Clone
git clone https://github.com/PMTLabs/termflow-core.git
cd termflow-core

# 2. Install root workspace dependencies
bun install

# 3. Install the MCP sidecar's dependencies
#    (mcp-server is NOT a root workspace; the Tauri build script compiles it,
#     so this step is required or `tauri`/`cargo` build will fail to resolve it)
cd mcp-server && bun install && cd ..

# 4. Run the app (hot-reload). This auto-builds terminal-core, the renderer,
#    and the MCP sidecar via Tauri's beforeDevCommand.
bun run tauri dev
```

### Build a distributable

```bash
# Full installers (MSI/NSIS on Windows, .app/.dmg on macOS, deb/AppImage on Linux)
bun run publish:tauri

# Faster: compile the app binary without packaging installers
bun run build:tauri
```

Output lands in `src-tauri/target/release/` (binary: `termflow[.exe]`) and `src-tauri/target/release/bundle/` (installers).

### Other useful scripts

```bash
bun run test              # Jest unit suite
bunx tsc --noEmit         # Type-check the renderer
bun run build:terminal-core   # Build the shared @termflow/terminal-core package
```

---

## 🔓 Open core

TermFlow is open-core:

- **This repo (`termflow-core`) — Apache-2.0.** The full terminal app, local API, MCP server, and the *client-side* peering integration. It has **zero build or runtime dependency** on the fabric: if the fabric binary is absent, peering simply reports "not installed" and everything else works normally.
- **`termflow-fabric` (private, FSL-1.1-Apache-2.0).** The multi-machine **peering** sidecar (Ed25519 identity, zero-config mTLS, SPAKE2 pairing, per-terminal ACL). This is the one capability not available from a plain open-core checkout.

Maintainers with access to the fabric source build the peering-enabled ("Pro") variant with `bun run publish:tauri:pro` (set `TERMFLOW_FABRIC_DIR` if the fabric crate isn't the sibling `../termflow-fabric`).

---

## 🔌 Developer API

The app runs a local API server (default port **42031**, REST + WebSocket) and an MCP server (default port **42032**).

### WebSocket

```javascript
const ws = new WebSocket('ws://localhost:42031/api/ws');
ws.onmessage = (e) => console.log('Terminal output:', e.data);
```

### Authentication

The server uses JWT bearer tokens.

```bash
# Obtain a token
curl -X POST http://localhost:42031/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"clientId": "my-app", "permissions": ["*"]}'
# -> { "token": "eyJhbG...", "expiresIn": "24h", "permissions": ["*"] }
```

### REST

```bash
# Create a terminal
curl -X POST http://localhost:42031/api/terminals \
  -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" \
  -d '{"profile": "bash", "name": "My Terminal"}'

# Send input
curl -X POST http://localhost:42031/api/terminals/{id}/input \
  -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" \
  -d '{"data": "ls -la\n"}'

# Execute a CLI prompt (Claude, Gemini, etc.)
curl -X POST http://localhost:42031/api/terminals/{id}/execute \
  -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt": "Write hello world in Python", "cliType": "claude"}'
```

Selected additional endpoints:

- `GET /api/system/info` · `GET /api/system/metrics` · `GET /api/processes` — system & process metrics
- `POST /api/recordings/start` · `POST /api/recordings/stop/{id}` — session recording
- `POST /api/search` · `GET /api/search/suggestions` — search terminal history / recordings
- `GET /api/layout` · `POST /api/layout` — save/restore window & pane layout

### Sending input to an agent CLI

Some CLIs (e.g. Claude) submit on `Escape` + carriage returns. Use the `execute` endpoint with an optional `submissionSignal` (JSON string, e.g. `"\r"`):

```json
POST /api/terminals/{id}/execute
{ "prompt": "Write hello world in Python", "cliType": "claude", "submissionSignal": "\r" }
```

Or drive input manually — the Claude CLI submit format is: prompt text, then ESC (byte 0x1B), then two carriage returns (\r\r).

### Control-character reference

Send these bytes as the `data` field of the `input` endpoint.

| Key | Byte | | Key | Byte |
|-----|------|-|-----|------|
| Ctrl+C (interrupt) | 0x03 | | Ctrl+D (EOF) | 0x04 |
| Ctrl+L (clear screen) | 0x0C | | Tab | 0x09 (\t) |
| Enter | 0x0D (\r) | | Escape | 0x1B |
| Ctrl+Z (suspend) | 0x1A | | Ctrl+W | 0x17 |

Arrow keys (ANSI): Up = ESC [A, Down = ESC [B, Right = ESC [C, Left = ESC [D (where ESC is byte 0x1B).

---

## 🔌 Ports

| Port | Service |
| :--- | :--- |
| **42010** | Frontend dev server (Webpack), development only |
| **42031** | TermFlow API — REST + WebSocket |
| **42032** | MCP server |
| **42030** | `terminal-monitor` web UI (companion tool) |

Ports are configurable in Settings; a second concurrent instance uses an offset range to avoid conflicts.

---

## 📋 System requirements

- **Windows** 10/11 — PowerShell 5.1+ (for PowerShell profiles), Git for Windows (for Git Bash)
- **macOS** 11+ — Xcode Command Line Tools
- **Linux** — a modern distro with `webkit2gtk`; bash/zsh/fish

---

## 📂 Project structure

See [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) for a directory-by-directory breakdown.

## 🤝 Contributing

1. Fork and branch from `develop` (`git checkout -b feature/your-feature`).
2. Commit, push, and open a Pull Request against `develop`.

## 📜 License

Licensed under the **Apache License 2.0** — see [`legal/LICENSE-apache-2.0.txt`](legal/LICENSE-apache-2.0.txt). The separate `termflow-fabric` peering sidecar is not part of this repository and is licensed under FSL-1.1-Apache-2.0.

## 🙏 Acknowledgments

- [Tauri](https://tauri.app/) · [xterm.js](https://xtermjs.org/) · [portable-pty](https://github.com/wez/wezterm/tree/main/pty) · [React](https://react.dev/)
