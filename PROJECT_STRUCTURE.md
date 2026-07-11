<!-- Last scanned baseline commit: 4b328b2c56bfc11616fa2f39ab0d8a24546ba7be -->
# TermFlow - Project Structure

TermFlow is a cross-platform terminal emulator designed for enhanced developer workflows and multi-agent AI orchestration. It features a robust developer API, allowing external tools and AI agents to inspect, control, and interact with terminal sessions programmatically.

**Application Version:** 0.1.0
**Target Framework:** Node.js 20+, Tauri 2 (Rust 2021 edition)
**Architecture Style:** Modular Monorepo (Tauri App + Companion Services)

**Last Updated:** Tuesday, June 30, 2026

---

## Project Statistics

| Module | Source Files | Style Files (CSS) | Description |
|:---|:---:|:---:|:---|
| **Core App (`src/`)** | 113 (TS/TSX) | 32 | Shared React renderer (pane drag-drop, multi-window detach, network settings, in-terminal search, dialog a11y) + legacy Electron/Node API remnants |
| **Tauri Backend** | 20 (Rust) | 0 | Active backend: API server, PTY & tmux managers, network config, context menu, scrollback persistence (SQLite), file/URL opening, session-reconnect detection |
| **MCP Server** | 5 (TS) | 0 | MCP sidecar exposing terminal tools to AI clients (bearer auth + parent-PID watchdog + SSE heartbeat + self-identity); 9-file test suite |
| **Terminal Kit (CLI)** | 2 (TS) | 0 | `tk` CLI for scaffolding multi-agent workflows |
| **Agent Monitor** | 22 (TS) | 0 | Team orchestration service |
| **Terminal Core** | 29 (TS) | 0 | `@termflow/terminal-core` — shared transport-agnostic xterm engine + Kitty/modifyOtherKeys keyboard-protocol encoding, consumed by the main app + monitor |
| **Terminal Monitor** | 63 (TS/TSX) | 1 | Web-based terminal monitoring dashboard (renders natively via `terminal-core`) |
| **Tests** | N/A | N/A | Unit (Jest) and E2E (Playwright) suites |

Refer more: `PROJECT_STRUCTURE.md`
`
---

## Table of Contents

- [Project Statistics](#project-statistics)
- [Quick Reference](#quick-reference)
- [Architecture Overview](#architecture-overview)
- [Project Structure](#project-structure)
- [Layer-by-Layer Breakdown](#layer-by-layer-breakdown)
- [Technology Stack](#technology-stack)
- [Testing Strategy](#testing-strategy)
- [Build & Deployment](#build--deployment)

---

## Quick Reference

- **Entry Point (Main):** `src-tauri/src/main.rs` (Tauri); the legacy `src/main/main.ts` Electron entry was removed
- **Entry Point (Renderer):** `src/renderer/index.tsx`
- **Entry Point (API):** `start-api-server.js`
- **Key Config Files:** `package.json`, `tsconfig.json`, `webpack.renderer.config.js`
- **Build Output:** `dist/`, `dist-electron/`

---

## Architecture Overview
The project has **migrated to a Tauri architecture** (Rust backend). The previous **Electron architecture is now obsolete** and kept only for reference or backward compatibility during the transition. All new features and development are focused exclusively on the Tauri implementation.

### Core Components
1.  **Tauri Backend (Rust)**: The **Active** core managing application lifecycle, window creation, and native integrations (via `portable-pty`). It replaces the obsolete Electron Main process.
2.  **Electron Main Process (Removed)**: The Electron bootstrap (`main.ts`, `windowManager`, `menuManager`, `preload`, all IPC handlers) was deleted outright (`chore: retire obsolete Electron main-process island`). Only `src/main/HeadlessManager.ts`, `terminalMetadata.ts`, and `services/{RecordingService,SearchService}.ts` remain, kept solely as shared utilities consumed by `src/api/` and `start-api-server.js`.
3.  **Frontend (React)**: A shared React-based Single Page Application (SPA) responsible for the UI and terminal rendering (via xterm.js). It runs in WebView (Tauri).
4.  **Local API Server**: An embedded `axum` server (Tauri) exposing endpoints for AI integration. The Node.js Express server is obsolete.
5.  **MCP Sidecar**: An MCP (Model Context Protocol) server (`mcp-server/`) compiled to a native binary and launched by the Tauri backend as a sidecar. It bridges AI clients (Claude, Gemini, etc.) to the local REST API, exposing terminal tools (list/create/execute/inspect/close, plus self-identity via `get_my_terminal`).
6.  **Companion Services**:
    -   **Agent Monitor**: A Node.js service for orchestrating multi-agent teams.
    -   **Terminal Monitor**: A web dashboard for remote viewing of terminal sessions; renders terminals natively via the shared `@termflow/terminal-core` engine with server-snapshot hydration on reconnect.
    -   **Terminal Kit (`tk`)**: A standalone CLI that scaffolds the `.agent-comms/` multi-agent workflow structure into any project.

### Design Patterns
-   **AppState (Rust)**: In-memory state management for the Tauri backend.
-   **Redux Store**: For state management in the renderer.
-   **Bridge Pattern**: To abstract IPC communication (Tauri Invoke being the primary implementation).
-   **Service Layer**: Encapsulation of core logic (e.g., `SharedPTYManager`, `RESTServer`).

---

## Project Structure

```
termflow-core/
├── src-tauri/                          # [ACTIVE] Tauri Backend (Rust)
│   ├── src/
│   │   ├── main.rs                     # Binary entry point (calls app_lib::run)
│   │   ├── lib.rs                      # Crate root, plugin/sidecar wiring & headless mode
│   │   ├── api_server.rs               # Embedded Axum API server (constant-time bearer auth, pre-bound listener)
│   │   ├── app_config.rs               # Dev/prod config isolation (config.dev.json vs config.json, port + token persistence)
│   │   ├── commands.rs                 # Tauri commands (invoke handlers)
│   │   ├── context_menu.rs             # Windows-only WebView2 right-click menu filter (preserves native Cut/Copy/Paste/Undo on editable targets)
│   │   ├── event_bus.rs                # Event system & activity tracking
│   │   ├── history_store.rs            # SQLite-backed per-terminal scrollback persistence (history.db), keyed by tab_id
│   │   ├── layout_endpoints.rs         # Layout persistence API
│   │   ├── layout_manager.rs           # Layout state management
│   │   ├── network_commands.rs         # Network config commands + zero-downtime API server hot-restart + cross-instance port-conflict detection
│   │   ├── open_commands.rs            # Opens detected URL/file/editor targets from terminal output (open_external, open_path, open_in_editor)
│   │   ├── pty_manager.rs              # Profile management & native PTYs; OSC 7/9;9 cwd tracking; output-pipeline auto-heal watchdog
│   │   ├── tmux_manager.rs             # tmux-backed terminals (resize/reflow)
│   │   ├── recording_endpoints.rs      # Recording API
│   │   ├── recording_service.rs        # Session recording & export
│   │   ├── search_endpoints.rs         # Search Engine API
│   │   ├── search_service.rs           # In-memory full-text search
│   │   ├── session_notify.rs           # Windows-only: WM_WTSSESSION_CHANGE hook, emits session:reconnect to suppress false-positive activity bell on RDP/unlock
│   │   └── state.rs                    # Application state (adds network config + API shutdown handle)
│   ├── build.rs                        # Build script (compiles MCP sidecar)
│   ├── capabilities/                   # Tauri permission scopes (shell sidecar, dialog:allow-open)
│   ├── Cargo.toml                      # Rust dependencies (clap, portable-pty, rusqlite, tauri-plugin-dialog, etc)
│   ├── tauri.conf.json                 # Base Tauri configuration (macOS-style overlay titlebar by default)
│   ├── tauri.linux.conf.json           # Linux overlay: frameless custom titlebar (decorations: false)
│   └── tauri.windows.conf.json         # Windows overlay: frameless custom titlebar (decorations: false)
├── src/                                # Core Application Source
│   ├── api/                            # [OBSOLETE] Legacy Local API Server (Node.js)
│   │   ├── RESTServer.ts               # Express server definition
│   │   ├── WebSocketServer.ts          # Real-time event handling
│   ├── main/                           # [OBSOLETE] Electron bootstrap removed; 4 files remain as shared utilities for src/api/ + start-api-server.js (HeadlessManager, terminalMetadata, RecordingService, SearchService)
│   ├── renderer/                       # [ACTIVE] Shared Frontend (React)
│   │   ├── components/                 # React components
│   │   │   ├── Tabs/                    # Pointer-based drag tab strip (TabManager) + OS tear-off DragPreview
│   │   │   ├── Panes/                   # Recursive split-pane engine + pointer drag-drop (dnd/), SessionClosedBanner
│   │   │   ├── Terminal/                # xterm.js mount (TerminalDisplay), Ctrl+F in-terminal search (TerminalSearchBar/searchBarLogic)
│   │   │   ├── TitleBar/                # Overlay title bar + window controls
│   │   │   ├── Settings/                # Settings page + network/connections panel, McpConnectModal, dirty-check guard, MCP client config generator (connectionStatus, mcpConfig)
│   │   │   └── UI/                      # Reusable modals + CopyableInfoRow; shared dialog a11y layer (useDialogA11y, Mnemonic, SplitButton, UnsavedChangesDialog)
│   │   ├── services/                   # Frontend services (TerminalService, paneActions, RunningActivityTracker, AgentSchemeTracker + agentSchemeLogic (per-agent color schemes), closeTabs, settingsDirty/settingsNavGuard, initialCwd, inputTargets, openSettings, tabPanesStore, binaryIcons, etc.)
│   │   ├── api/                         # IPC bridges (tauri-bridge, browser-bridge, windowRouting for multi-window event filtering)
│   │   ├── store/                      # Redux state (tabs, panes, settings, layouts, ui, zoom slices) + paneTreeOps/colorSchemas/terminalTheme (per-terminal schema resolver) helpers
│   │   ├── hooks/                       # useSurfaceZoom (per-surface zoom + gesture wiring)
│   │   ├── utils/                       # Helpers (id, diag, pathResolve for ctrl-click links)
│   │   └── styles/                       # CSS/SCSS files
│   ├── shell/                          # [OBSOLETE] Shell integration scripts (Node.js)
│   └── types/                          # Shared TypeScript definitions
├── packages/                           # Bun workspace packages
│   └── terminal-core/                  # @termflow/terminal-core — shared xterm engine (TerminalEngine class + TerminalBridge interface), snapshot hydration, terminal cache, WebGL control, Kitty/modifyOtherKeys keyboard-protocol encoding; consumed by the main app + monitor
├── mcp-server/                         # MCP sidecar (terminal tools for AI clients)
├── terminal-kit/                       # `tk` CLI for multi-agent workflow scaffolding
├── agent-monitor/                      # Agent Orchestration Service
├── terminal-monitor/                   # Web-based Monitor Dashboard
├── scripts/                            # Build scripts (build-mcp-sidecar.mjs)
├── tests/                              # E2E and Integration Tests
├── docs/                               # Project Documentation
├── dist/                               # Webpack build output
└── dist-electron/                      # Electron build output
```

---

## Layer-by-Layer Breakdown

### 1. Tauri Backend (`src-tauri`) - **PRIMARY**
-   **Purpose**: The new, high-performance backend written in Rust.
-   **Key Components**:
    -   `api_server.rs`: REST/WS API supporting AI patterns and legacy endpoints.
    -   `pty_manager.rs`: Native PTY emulation & Shell Profile management.
    -   `tmux_manager.rs`: tmux-backed terminal sessions for content reflow on resize (with WSL fallback).
    -   `recording_service.rs`: Session recording with multi-format export.
    -   `search_service.rs`: In-memory full-text search with persistence.
    -   `event_bus.rs`: Centralized event handling and activity tracking.
    -   `app_config.rs`: Compile-time dev/prod isolation — distinct config files (`config.dev.json` vs `config.json`) and default ports (dev 42051/42052, prod 42031/42032) so a `tauri dev` session and a shipped app never collide; persists/loads `NetworkConfig` (ports, expose flag, auth token).
    -   `network_commands.rs`: `get/set_network_config`, `rotate_auth_token`, `list_network_interfaces`, a zero-downtime Axum hot-restart (bind-new-before-drop-old on port change, retry loop on port release), and cross-instance port-conflict detection (`probe_port_owner`/health-based ownership check via `/health` `instanceId`, since `SO_REUSEADDR` means bind success alone can't detect a conflicting second instance).
    -   `context_menu.rs`: Windows-only WebView2 right-click filter (no-op on macOS/Linux); preserves the full native Cut/Copy/Paste/Undo menu on editable targets, only trims it elsewhere.
    -   `history_store.rs`: SQLite-backed per-terminal scrollback persistence (`history.db`), keyed by the stable renderer `tab_id`; degrades to a silent no-op if the DB can't be opened.
    -   `open_commands.rs`: Backend commands to open a detected URL/file path/editor target from terminal output (`open_external`, `open_path`, `open_in_editor`), with a bounded BFS descendant-path fallback search.
    -   `session_notify.rs`: Windows-only — hooks `WM_WTSSESSION_CHANGE` (RDP/console reconnect, session unlock) and emits a `session:reconnect` event so the renderer suppresses the false-positive activity bell caused by ConPTY's synchronized repaint burst.
-   **Dependencies**: `tauri`, `tauri-plugin-dialog` (native file picker), `portable-pty`, `axum`, `tokio`, `serde`, `clap`, `vt100`, `dashmap`, `sysinfo`, `if-addrs` (LAN IP discovery), `rusqlite` (bundled SQLite, backs `history_store.rs`), and Windows-only `webview2-com`/`windows`/`windows-core` (context menu + `session_notify.rs` session-change detection).
-   **Capabilities**: `clipboard-manager` (native read/write text), `drag-preview`/`window-*` scopes for multi-window detach, `dialog:allow-open` (native file picker for Settings' default-editor field).
-   **MCP Sidecar**: `build.rs` compiles `mcp-server/` into a native sidecar binary; the shell plugin is permitted (via `capabilities/`) to spawn/kill only that named binary.

### 2. Main Process (`src/main`) - **OBSOLETE**
-   **Purpose**: Formerly bootstrapped the legacy Electron application; the bootstrap itself has been deleted (`main.ts`, `windowManager.ts`, `menuManager.ts`, `preload.ts`, `ipc/*`, `terminalRegistry.ts`, `apiServer.ts`, `directAPI.ts`, `services/ConfigManager.ts` are all gone — no rename, a clean removal).
-   **Status**: Deprecated. Only 4 files remain (`HeadlessManager.ts`, `terminalMetadata.ts`, `services/RecordingService.ts`, `services/SearchService.ts`), kept solely as shared utilities consumed by `src/api/` and `start-api-server.js`. No Electron entry point remains in this directory.

### 3. Renderer Process (`src/renderer`) - **SHARED**
-   **Purpose**: Renders the UI and terminal emulator. Handles user interaction.
-   **Key Components**: `App.tsx`, tab strip (`Tabs/TabManager`, with a browser-style close menu — `CloseSummary`/`closeTabs.ts` — that confirms before killing tabs with live foreground processes), split-pane engine (`Panes/PaneManager`), xterm.js mount (`Terminal/TerminalDisplay`, with Ctrl+F in-terminal search via `TerminalSearchBar`), overlay `TitleBar/`, `Settings/` (network panel + `McpConnectModal` + dirty-check/navigation-guard flow + color-schema picker), and reusable `UI/` modals built on a shared `useDialogA11y` hook (focus trap, mnemonics, Esc/Enter) plus `Mnemonic`/`SplitButton`/`UnsavedChangesDialog`.
-   **Pane Drag-and-Drop** (`Panes/dnd/`): Pointer-based iTerm2-style drag for split panes — within-window split/reorder by edge zone (`zone.ts`/`computeZone`), cross-tab and cross-window moves brokered by the Tauri backend, and detach-to-new-window (`detach.ts`) with live PTY reattachment on the detached window's boot. State machine lives in `PaneDragController`; `PaneDragLayer`/`PaneDropOverlay` render the ghost and zone highlights.
-   **Multi-window detach**: Tabs and panes can tear off to a new OS window; `TabManager` drives a real frameless `DragPreview` window that follows the cursor; `TerminalService.attachExistingTerminal`/`detachTerminal` hand a live PTY between windows without re-spawning.
-   **State**: Redux slices for `tabs`, `panes` (per-tab `treesByTabId` + `paneTreeOps` helpers), `settings` (`closeTabOnProcessExit`, `tabSizingMode`, `colorSchemaId`), `layouts`, `ui` (toasts/global dialog), and `zoom` (per-surface zoom level, keyed by terminal id or `'settings'`). Tabs track `exited`/`hasBackgroundActivity` (legacy activity flag), plus `isRunning` and `hasUnseenOutput` (driven by `RunningActivityTracker`/`runningActivity.ts`) for the running-process indicator and unseen-activity bell.
-   **IPC Bridge**: `api/tauri-bridge.ts` is the active bridge — Tauri `invoke()`/`listen()` for PTY ops and events, plus HTTP to the configured API port (default `localhost:42031`) for output/snapshots with bearer-token auth. Adds network-config, multi-window, detach-payload handoff, and cross-window drag-broker methods; uses `windowRouting.ts` (`shouldHandleForWindow`) so each window ignores broadcast `api:createTerminalTab` events not addressed to it. Exposed as `window.electronAPI` for compatibility.
-   **Dependencies**: `react` (v19), `react-redux`, `xterm`, `react-dnd`.

### 4. API Layer (`src-tauri/src/api_server.rs`) - **PRIMARY**
-   **Purpose**: Provides a programmatic interface for external tools (Agents) to control the terminal, manage profiles, search history, and record sessions via the Tauri backend.
-   **Implementation**: Axum (Rust).
-   **Legacy**: The pure Node.js `src/api` implementation is obsolete.

### 5. MCP Server (`mcp-server/`) - **ACTIVE**
-   **Purpose**: An MCP server (`termflow-mcp-server`) exposing terminal tools (`list_terminals`, `create_terminal`, `execute_command`, `get_terminal_output`, `get_terminal_detail`, `get_my_terminal`, `close_terminal`) to AI clients. `get_my_terminal` and the `"me"` shorthand accepted by other tools let an agent self-identify via the `X-Termflow-Terminal-Id` header (`identity.ts`).
-   **Implementation**: TypeScript on `@modelcontextprotocol/sdk` + Express (streamable HTTP); split into `index.ts` (HTTP/session bootstrap, auth gate, SSE wiring) and `server.ts` (`createMcpServer()` — DI'd tool registration, extracted for testability). Proxies tool calls to the REST API via an `axios` client (`apiClient.ts`) with a mandatory finite timeout (default 8s) so a stalled backend can't hang a request/SSE stream. Bundled to a native binary by `scripts/build-mcp-sidecar.mjs` (`bun build --compile`).
-   **Hardening**: Optional bearer-token auth (`AUTO_TERMINAL_TOKEN`, with `AUTO_TERMINAL_API_TOKEN` back-compat fallback; constant-time compare) on all non-`/health` routes, configurable bind host (`MCP_HOST`), a parent-PID watchdog (`MCP_PARENT_PID`) that auto-exits when the Tauri host dies, an SSE idle-heartbeat (`heartbeat.ts`, periodic `: ping` comment) preventing idle-timeout disconnects on the long-lived GET `/mcp` stream, and an `AUTO_TERMINAL_INSTANCE_ID` echoed in `/health` so a launching app can distinguish its own sidecar from another instance holding the same port.

### 6. Terminal Kit (`terminal-kit/`) - **CLI**
-   **Purpose**: A standalone `tk` CLI that scaffolds the `.agent-comms/` multi-agent workflow structure into a project (`tk init`).
-   **Implementation**: TypeScript with `commander`, `chalk`, `fs-extra`.

---

## Technology Stack

### Core
-   **Runtime**: Tauri (Rust) - **Primary**
-   **Legacy Runtime**: Electron / Node.js - **Obsolete**
-   **Language**: TypeScript (v5.x), Rust (2021 edition)
-   **Frontend**: React (v19), Redux Toolkit, Webpack, react-dnd
-   **Terminal**: xterm.js, portable-pty (Rust), tmux (optional backend), vt100 (Rust parser)

### Communication
-   **API**: Axum (Rust), ws (WebSocket)
-   **IPC**: Tauri Invoke & Events
-   **AI Integration**: MCP (`@modelcontextprotocol/sdk`) via bundled sidecar binary

### Tools
-   **Build**: Webpack, Cargo, Tauri CLI, Bun (MCP sidecar compile)
-   **Linting**: ESLint, Prettier, Clippy (Rust)
-   **Testing**: Jest, Playwright

---

## Testing Strategy

-   **Unit Tests**: Located in `__tests__` directories or alongside source files. Run via `npm test` (Jest).
-   **E2E Tests**: Located in `tests/e2e`. Run via `npm run test:e2e` (Playwright). Focuses on full application flows and UI interaction.
-   **Coverage**: Configured in `jest.config.js` to collect coverage from `src`.
-   **Workspace Tests**: `mcp-server/` (own `bun test` runner, excluded from the root Jest run via `testPathIgnorePatterns`) and `packages/terminal-core/` (`bun run test:workspace`) each own their own test runner outside the root Jest suite.

---

## Build & Deployment

-   **Development**:
    -   `bun run dev` (`tauri dev`): Starts the Tauri app with the renderer in watch mode.
    -   `bun run dev:renderer`: Starts the renderer dev server (port 42010) only.
-   **Production Build**:
    -   `bun run build:tauri` (`tauri build --no-bundle`): Builds the native app binary; `beforeBuildCommand` runs the renderer build and `build:mcp-sidecar`. `bun run publish:tauri` produces the full bundle/installer.
    -   `bun run build:terminal-core`: Builds the `@termflow/terminal-core` workspace package (ESM + CJS via tsup) — run first by `build`.
    -   `bun run build:mcp-sidecar`: Compiles `mcp-server/` into a native sidecar binary via Bun.
    -   `bun run build` (= `build:terminal-core && build:renderer`): Builds the Renderer Webpack bundle only — the Electron Main/Preload webpack configs (`webpack.main.config.js`, `webpack.preload.config.js`) were deleted along with the Electron main-process island.
-   **Workspaces**: Bun workspaces (`terminal-monitor`, `packages/*`); `bunfig.toml` sets `linker = "hoisted"` so CRA/webpack in `terminal-monitor` resolves transitive deps. `bun run test:workspace` runs package unit tests (e.g. terminal-core).
-   **CI**: GitHub Actions installs dependencies via `bun install --frozen-lockfile` (`ci.yml`, `e2e-tests.yml`, `release.yml`) but still invokes `npm test`/`npm run build` for the run steps themselves (not yet migrated to `bun run`). Runs on self-hosted runners (replacing the prior ubuntu/windows/macos matrix). CI builds `terminal-core` (`bun run build:terminal-core`) before typechecking (`npx tsc --noEmit`) so its `dist/` types resolve; the `npm run lint` step was removed (no lint script exists). The Playwright E2E suite (`e2e-tests.yml`) remains quarantined (`continue-on-error`) pending a Tauri rewrite; the standalone `e2e` job was removed from `ci.yml` itself.

---

## Configuration

-   **Environment**: `.env` files (referenced in code, though `.env.example` exists).
-   **TypeScript**: `tsconfig.json` (root), `tsconfig.main.json`, `tsconfig.renderer.json`.
-   **Webpack**: `webpack.renderer.config.js` only — the main/preload configs were removed with the Electron main-process island.
