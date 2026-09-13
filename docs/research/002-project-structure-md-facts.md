# PROJECT_STRUCTURE.md raw audit

## 1. `src-tauri/src` Rust files

Top-level `.rs` files: **43**  
Recursive `.rs` files under `src-tauri/src`: **124**

- `src-tauri/src/app_config.rs` — development/production/profile config, persisted network settings, ports, and paths.
- `src-tauri/src/automation_commands.rs` — Tauri IPC commands for Terminal Automations.
- `src-tauri/src/automation_engine.rs` — Terminal Automations evaluation/runtime engine.
- `src-tauri/src/automation_validation.rs` — Rust-side automation editor/save validation mirror.
- `src-tauri/src/automation_webhook.rs` — automation webhook request construction and delivery.
- `src-tauri/src/canvas_endpoints.rs` — Axum REST endpoints for Canvas graph/edges and related terminal operations.
- `src-tauri/src/canvas_store.rs` — persistent Canvas connection graph/edge store.
- `src-tauri/src/console_window.rs` — Windows ConPTY hidden-console ownership/parenting support.
- `src-tauri/src/context_menu.rs` — Windows WebView2 native context-menu filtering.
- `src-tauri/src/event_bus.rs` — centralized event bus and activity tracking.
- `src-tauri/src/fabric_manager.rs` — lifecycle, launch, health, and shutdown coordination for optional `termflow-fabric` peering sidecar.
- `src-tauri/src/gpu_preference.rs` — Windows WebView2 GPU preference translation.
- `src-tauri/src/history_flush.rs` — asynchronous history database flush/path handling.
- `src-tauri/src/history_store.rs` — SQLite terminal scrollback/history persistence.
- `src-tauri/src/identity_index.rs` — durable terminal identity to process/run lookup index.
- `src-tauri/src/instance_lock.rs` — profile-aware single-instance enforcement.
- `src-tauri/src/layout_endpoints.rs` — Axum layout persistence endpoints.
- `src-tauri/src/layout_manager.rs` — window/pane layout state persistence and management.
- `src-tauri/src/lib.rs` — Tauri library root, module wiring, app startup, MCP/fabric process shutdown, and runtime orchestration.
- `src-tauri/src/main.rs` — native Tauri binary entry point.
- `src-tauri/src/mcp_sidecar.rs` — MCP sidecar resolution, launch, health verification, respawn, process tracking, and legacy fallback.
- `src-tauri/src/native_notify.rs` — native Windows notification identity/support helpers.
- `src-tauri/src/net_ports.rs` — per-instance API/MCP port selection and conflict avoidance.
- `src-tauri/src/network_commands.rs` — network settings, token rotation, API restart, and port ownership commands.
- `src-tauri/src/open_commands.rs` — opening terminal-detected URLs, paths, and editor targets.
- `src-tauri/src/output_pipeline.rs` — terminal output pipeline/watchdog integration.
- `src-tauri/src/panic_hook.rs` — process-wide panic reporting hook.
- `src-tauri/src/peer_commands.rs` — Tauri commands proxying optional fabric peering control API.
- `src-tauri/src/profile.rs` — profile identity and per-profile derived runtime identity.
- `src-tauri/src/pty_host_client.rs` — GUI client for the Windows PTY-host sidecar over named pipes.
- `src-tauri/src/recording_endpoints.rs` — recording REST endpoints.
- `src-tauri/src/recording_service.rs` — terminal session recording and export service.
- `src-tauri/src/search_endpoints.rs` — search REST endpoints.
- `src-tauri/src/search_service.rs` — terminal history/search service.
- `src-tauri/src/session_notify.rs` — Windows RDP/session reconnect and power-resume event handling.
- `src-tauri/src/shell_integration.rs` — file-manager/shell integration commands.
- `src-tauri/src/sibling_coord.rs` — coordination with other TermFlow instances during updates.
- `src-tauri/src/tmux_manager.rs` — tmux-backed terminal backend and resize/reflow support.
- `src-tauri/src/tray.rs` — system-tray commands and window show/focus integration.
- `src-tauri/src/updater.rs` — feature-gated Velopack update integration.
- `src-tauri/src/webview_power.rs` — minimized-window WebView2 rendering suspension/resume support.
- `src-tauri/src/window_registry.rs` — persistent OS-window registry.
- `src-tauri/src/window_restore.rs` — startup window/layout restoration.

Flagged filename groups:

- `canvas_*`: `src-tauri/src/canvas_endpoints.rs`, `src-tauri/src/canvas_store.rs`
- `automation_*`: `src-tauri/src/automation_commands.rs`, `src-tauri/src/automation_engine.rs`, `src-tauri/src/automation_validation.rs`, `src-tauri/src/automation_webhook.rs`
- `fabric_*`: `src-tauri/src/fabric_manager.rs`
- `mcp_sidecar*`: `src-tauri/src/mcp_sidecar.rs`
- `snippet*`: no top-level `src-tauri/src/snippet*.rs` file
- `notification*`: no top-level `src-tauri/src/notification*.rs` file; notification-related top-level files include `native_notify.rs` and `session_notify.rs`

Additional related Rust subdirectories/files exist under `src-tauri/src/automation/`, `src-tauri/src/automation_engine/`, `src-tauri/src/automation_store/`, `src-tauri/src/api_server/`, `src-tauri/src/commands/`, and `src-tauri/src/snippets.rs`.

## 2. Root build-output directories

- `dist/`: **exists**
- `dist-electron/`: **does not exist**

## 3. Current source counts

| Path | Extension count | Total |
|---|---:|---:|
| `src/` recursive | `.ts` 382 + `.tsx` 179 | **561** |
| `mcp-server/src/` recursive | `.ts` | **7** |
| `terminal-kit/src/` recursive | `.ts` | **2** |
| `agent-monitor/src/` recursive | `.ts` | **22** |
| `packages/terminal-core/src/` recursive | `.ts` | **67** |
| `terminal-monitor/src/` recursive | `.ts` 37 + `.tsx` 26 | **63** |

## 4. Current `docs/` tree

- `docs/ci/`
- `docs/ci/001-quarantined-playwright-suites.md`
- `docs/guides/`
- `docs/guides/001-terminal-color-contrast.md`
- `docs/research/` (empty)

## 5. Renderer Canvas, Automation, and Snippets paths

- `src/renderer/components/Canvas/`
- `src/renderer/components/Canvas/CanvasMode.tsx`
- `src/renderer/components/Canvas/CanvasNode.tsx`
- `src/renderer/components/Canvas/CanvasWires.tsx`
- `src/renderer/services/canvasGraph.ts`
- `src/renderer/services/openCanvas.ts`
- `src/renderer/store/slices/canvasSlice.ts`
- `src/renderer/components/Automation/`
- `src/renderer/components/Automation/AutomationEditor.tsx`
- `src/renderer/components/Automation/GlobalAutomationEditor.tsx`
- `src/renderer/components/Settings/Automations/`
- `src/renderer/services/automationArmed.ts`
- `src/renderer/services/automationEditorGuard.ts`
- `src/renderer/services/automationEditorHost.ts`
- `src/renderer/services/automationEvents.ts`
- `src/renderer/components/Settings/SnippetsPanel.tsx`
- `src/renderer/components/Terminal/snippetsHistoryMenu.ts`
- `src/renderer/components/UI/SnippetDialog.tsx`
- `src/renderer/services/snippetImportFormats.ts`
- `src/renderer/services/snippetPorting.ts`
- `src/renderer/services/snippetSearch.ts`

## 6. Optional `termflow-fabric` peering

- `src-tauri/src/fabric_manager.rs` — lifecycle for the `termflow-fabric` peering sidecar; resolves, launches, health-checks, verifies, and monitors the fabric process.
- `src-tauri/src/peer_commands.rs` — Tauri commands proxying the fabric loopback control API.
- `src-tauri/src/lib.rs` — starts/coordin­ates the fabric sidecar alongside the app/MCP runtime.

## 7. MCP sidecar runtime files

- `src-tauri/src/mcp_sidecar.rs` — runtime sidecar path resolution, spawn, health/ownership/build verification, respawn, and process-handle management.
- `src-tauri/src/lib.rs` — runtime MCP shutdown commands/handle cleanup and startup orchestration.
- `src-tauri/src/state.rs` — `McpProcessHandle` state held by the application.
- `src-tauri/src/network_commands.rs` — runtime MCP stop/respawn operations when network configuration changes.
- `src-tauri/build.rs` — build-time MCP sidecar compilation only; distinct from runtime process management.

## 8. Quick Reference facts

- Root `dist/`: **exists**
- Root `dist-electron/`: **does not exist**
- `webpack.renderer.config.js`: **exists**
- `webpack.main.config.js`: **does not exist**
- `webpack.preload.config.js`: **does not exist**
- `webpack.renderer.config.js` is the only root `webpack*` config file found.
- `start-api-server.js`: **does not exist**
- Active API entry/backend: `src-tauri/src/api_server/` and `src-tauri/src/api_server.rs`.
- `src/api/`: still exists as legacy Node API source.
- `dist/` is the current root Webpack output directory; `dist-electron/` is absent.

## 9. Git baseline

- Current `HEAD` short hash: `2e124c2`

REPORT COMPLETE
