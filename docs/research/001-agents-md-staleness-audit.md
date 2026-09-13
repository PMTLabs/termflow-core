# AGENTS.md audit findings

Audit scope: read-only inspection of `D:\\sources\\work\\termflow\\termflow-core`; no tests were run and no repository files were edited. Evidence below uses current files and line numbers where useful. The repository is TermFlow, not the older three-project “Auto-Terminal Orchestration Platform” description.

1. **Documentation structure and phase files**

   **Current AGENTS.md claim:** Agents must load `docs/agentic/01-setup.md` through `06-operations.md`, plus `docs/agentic/master-agent.md`, and use those phase documents for setup, architecture, coding, testing, debugging, and operations (`AGENTS.md:24-39`, `399-401`).

   **Actual reality:** `docs/agentic/` does not exist, and none of the seven named files exists. The complete current `termflow-core/docs/` tree contains `docs/ci/001-quarantined-playwright-suites.md`, `docs/guides/001-terminal-color-contrast.md`, and an empty `docs/research/` directory; there are no `docs/plan`, `docs/progress`, or `docs/backlog` directories here. The parent workspace guidance (`D:\\sources\\work\\termflow\\CLAUDE.md`) says product-development documents (`docs/backlog`, `docs/core`, `docs/design`, `docs/legal`, `docs/plan`, `docs/progress`, `docs/review`) live in the sibling `termflow-fabric` repository, while core keeps public-safe CI/guides content.

   **Verdict:** **STALE.** Replace the phase-document table with the two actual public docs and explicitly point product planning/progress work to sibling `termflow-fabric` when appropriate.

2. **Package manager**

   **Current AGENTS.md claim:** Commands are presented as npm-first (`npm install`, `npm run ...`, `npm test`) throughout `AGENTS.md:127-186`.

   **Actual reality:** Bun is the project-standard package manager/runtime. `README.md:32-36` explicitly says “Bun ... used throughout (`bun`, not `npm`)”; the root has `bun.lock` and `bunfig.toml` with `linker = "hoisted"`, and no root `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, or `npm-shrinkwrap.json`. Root `package.json:5` defines Bun workspaces (`terminal-monitor`, `packages/*`), and most scripts invoke `bun`. There are compatibility leftovers: root `test:all` is `npm run test && npm run test:e2e` (`package.json:52`), `mcp:dev` invokes `npm run dev` (`package.json:55`), and `terminal-kit` uses npm in publish/postinstall hooks (`terminal-kit/package.json:13-14`). `agent-monitor` retains a `package-lock.json` and npm-era scripts but is still a root standalone package.

   **Verdict:** **STALE.** Say “use Bun; npm appears only in legacy/compatibility scripts and some standalone package metadata,” and identify the exceptional commands rather than making npm the default.

3. **Electron versus Tauri**

   **Current AGENTS.md claim:** Tauri is active and Electron is obsolete (`AGENTS.md:204-209`), implying the obsolete Electron implementation is effectively gone.

   **Actual reality:** Tauri is the active application backend (`src-tauri/src/main.rs`, `src-tauri/src/lib.rs`), and the Electron bootstrap files are gone. However, `src/main/` still exists with `HeadlessManager.ts`, `terminalMetadata.ts`, and `services/{RecordingService,SearchService}.ts`; `src/api/` still exists with the legacy Node/Express/WebSocket API implementation; and `src/shell/` also remains. `webpack.renderer.config.js` still exists and is active for the renderer. `dist-electron/` does not exist, and no `webpack.main.config.js` or `webpack.preload.config.js` exists. `PROJECT_STRUCTURE.md:108-127`, `165-167`, and `181-185` correctly describe the remaining source as legacy/shared, but its tree at `:139` still lists nonexistent `dist-electron/`.

   **Verdict:** **PARTIALLY STALE.** State: “Tauri is the only active desktop runtime; Electron’s main-process island is removed, but legacy Node API/shared utility files remain and must not be casually deleted.” Do not call `src/main` and `src/api` simply obsolete without explaining their current consumers.

4. **Renderer state management**

   **Current AGENTS.md claim:** The renderer uses Redux Toolkit and Redux slices for tabs, panes, and settings (`AGENTS.md:224-229`, `255-263`, `371-373`).

   **Actual reality:** This remains substantially true. Root `package.json:97` includes `@reduxjs/toolkit:^2.8.2` and `:120` includes `react-redux:^9.2.0`; `src/renderer/store/` exists; and `PROJECT_STRUCTURE.md:123`, `:174`, and `:200` describe Redux slices for tabs, panes, settings, layouts, UI, and zoom. The renderer has grown beyond the old three-slice summary, including layout, UI/toasts, zoom, color-schema/theme, activity, canvas, automation, and multi-window services.

   **Verdict:** **PARTIALLY STALE.** Keep Redux Toolkit, but update the slice inventory and mention that `@termflow/terminal-core` owns transport-agnostic terminal engine behavior rather than putting all terminal state/design under the renderer.

5. **Actual top-level module/package layout**

   **Current AGENTS.md claim:** The main architecture section describes three projects: core, `terminal-monitor`, and `agent-monitor` (`AGENTS.md:102-118`), with a narrower `src-tauri`/`src/renderer` inventory (`AGENTS.md:204-247`).

   **Actual reality:** The current top-level source modules are:

   - `src-tauri/` — active Tauri/Rust backend: Axum API, PTY/profile handling, tmux, network/config, layout, recording/search, SQLite scrollback, canvas, automation, notifications/session-resume, optional fabric peering, and sidecar/window plumbing. Actual current files include `automation_*`, `canvas_*`, `history_*`, `tmux_manager.rs`, `network_commands.rs`, `mcp_sidecar.rs`, `fabric_manager.rs`, and more.
   - `src/` — shared React renderer plus legacy/shared Node TypeScript layers: `renderer/`, `api/`, `main/`, `shell/`, `types/`, and tests.
   - `packages/terminal-core/` — `@termflow/terminal-core`, shared xterm engine/cache/bridge, snapshot hydration, WebGL policy, and Kitty/`modifyOtherKeys` protocol handling; consumed by the app and monitor (`PROJECT_STRUCTURE.md:129-130`).
   - `mcp-server/` — active MCP sidecar exposing terminal tools to AI clients; compiled/bundled for Tauri (`PROJECT_STRUCTURE.md:131`, `:183-186`).
   - `terminal-kit/` — standalone `tk` CLI for scaffolding `.agent-comms/` workflows (`PROJECT_STRUCTURE.md:132`, `:188-190`).
   - `terminal-monitor/` — React remote terminal dashboard, now consuming the shared terminal core (`PROJECT_STRUCTURE.md:134`, `:24`, `terminal-monitor/package.json:6-37`).
   - `agent-monitor/` — standalone Node/TypeScript team-orchestration service with team, session, validation, and enhanced/headless commands (`agent-monitor/package.json:1-24`).
   - `scripts/` — sidecar, notice/EULA, notification-sound, and release/smoke build helpers.
   - `tests/` — Playwright/E2E and integration-oriented tests.
   - `docs/` — only public-safe CI and guide documents in this repository.

   `PROJECT_STRUCTURE.md:14-25` gives the intended module summary, but the file is itself partly stale: it reports 20 Rust files while the current `src-tauri/src/` has substantially more, and it lists `dist-electron/` although that directory is absent.

   **Verdict:** **STALE.** The rewritten file needs a module map that includes MCP, terminal core, terminal kit, sidecars/fabric integration, and current Rust feature modules.

6. **Locations and package status of terminal-monitor and agent-monitor**

   **Current AGENTS.md claim:** Both are standalone root projects at `/terminal-monitor` and `/agent-monitor` (`AGENTS.md:112-116`, `152-174`).

   **Actual reality:** Both still exist at those root paths. `terminal-monitor` is a root Bun workspace member (`package.json:5`) and has its own `package.json` scripts (`start`, `start:prod`, `build`, `test`, `test:e2e`, `lint`, `format`). `agent-monitor` remains at root but is not listed in the root workspace array; its own `package.json` provides `build`, `start`, `dev`, `watch`, `team:start`, `team:session`, and related orchestration commands (`agent-monitor/package.json:6-24`). `@termflow/terminal-core` is the package moved under `packages/`, not either monitor.

   **Verdict:** **PARTIALLY STALE.** The paths are accurate, but the document should distinguish the Bun workspace monitor from the standalone npm-lockfile-era agent monitor and mention the shared package dependency.

7. **Actual development, build, and test commands**

   **Current AGENTS.md claim:** Generic npm commands are listed for all projects, including `npm run build`, `npm start`, `npm test`, Playwright commands, and Cargo commands (`AGENTS.md:127-186`).

   **Actual reality:** Exact current root scripts are in `package.json`: `dev`, `start`, `dev:renderer`, `dev:tauri`, `build`, `build:renderer`, `build:terminal-core`, `build:tauri`, `publish:tauri`, `build:mcp-sidecar`, `build:pty-host`, `typecheck`, `test`, `test:workspace`, `test:e2e`, `test:e2e:headed`, `test:e2e:debug`, `test:all`, `mcp`, and `mcp:dev` (`package.json:6-55`). Canonical README examples are `bun install`, `bun run tauri dev`, `bun run publish:tauri`, `bun run build:tauri`, `bun run test`, `bunx tsc --noEmit`, and `bun run build:terminal-core` (`README.md:38-75`).

   `terminal-monitor/package.json` scripts are `start`, `start:prod`, `build`, `test`, `test:e2e`, `test:e2e:ui`, `eject`, `lint`, `lint:fix`, `format`, and `format:check`. `mcp-server/package.json` scripts are `build`, `start`, `dev`, `test` (`bun test`), and `typecheck`. `packages/terminal-core/package.json` scripts are `build`, `dev`, `typecheck`, and `test`; root `test:workspace` dispatches its test. `terminal-kit/package.json` scripts are `build`, `dev`, `prepublishOnly`, and `postinstall`. `agent-monitor/package.json` scripts are listed above in item 6.

   Rust has three manifests under `src-tauri/`: the app, `pty-host`, and `pty-protocol`. CI invokes `cargo test` against the protocol/host manifests and the Tauri app; the requested generic `cd src-tauri && cargo build/test/clippy` is not the complete current workflow. No root `lint` script exists; CI explicitly removed that step (`PROJECT_STRUCTURE.md:235`).

   **Verdict:** **STALE.** Replace generic npm-first snippets with canonical Bun commands, list workspace/sidecar commands, preserve the exact npm compatibility exceptions, and document the separate Rust manifests and quarantined E2E status.

8. **Progress tracking, requirements, and `docs/auto-terminal`**

   **Current AGENTS.md claim:** Agents must always consult `/docs/auto-terminal/implementation.md`, `/docs/auto-terminal/changelogs.md`, and `/docs/auto-terminal/requirements.md` (`AGENTS.md:92-94`, `:401`).

   **Actual reality:** All three paths are absent from `termflow-core`. The only local docs are the CI quarantine note and xterm color-contrast guide. The parent workspace `CLAUDE.md` explicitly says the product docs and planning directories live in sibling `termflow-fabric`; that is the current place to look for backlog/plan/progress/requirements material, subject to repository access and scope.

   **Verdict:** **STALE.** Remove nonexistent local paths and replace them with a clear core-versus-fabric documentation boundary.

9. **xterm version and addons**

   **Current AGENTS.md claim:** xterm.js and all modern `@xterm/*` packages are v5.5.0, with fit, web-links, webgl, and unicode11 addons (`AGENTS.md:118`, `:265-266`, `:329-330`).

   **Actual reality:** The addons named in the old file are present, but versions have moved. Root `package.json:105-111` has `@xterm/xterm:^6.0.0`, `addon-fit:^0.11.0`, `addon-search:^0.16.0`, `addon-serialize:^0.14.0`, `addon-unicode11:^0.9.0`, `addon-web-links:^0.12.0`, and `addon-webgl:^0.19.0`. `terminal-monitor` and `packages/terminal-core` use the same xterm 6/addon generation. Search and serialize are additional addons omitted by the old document.

   **Verdict:** **PARTIALLY STALE.** Keep the addon architecture, update xterm to 6.0.0 and list search/serialize as well as fit/web-links/webgl/unicode11.

10. **Master Agent Protocol**

   **Current AGENTS.md claim:** A special “Master Agent” role exists, with mandatory delegation to Implementer/Test Analyst agents and a required `docs/agentic/master-agent.md` protocol (`AGENTS.md:56-87`).

   **Actual reality:** `docs/agentic/master-agent.md` does not exist anywhere in this repo, and no current phase-doc set supports the protocol. The repo does contain normal agent-orchestration product code (`agent-monitor/`) and `.agent-comms`-related tooling (`terminal-kit`), but that is not evidence of a repository-level Master Agent operating protocol. The current parent instructions instead describe separate repositories and their local guidance.

   **Verdict:** **STALE.** Remove the protocol unless a new, maintained cross-agent policy is intentionally introduced elsewhere; do not confuse the product’s agent-monitor/team orchestration with instructions for the coding agent.

11. **CLAUDE.md/GEMINI.md pointer structure**

   **Current AGENTS.md claim:** Claude agents read `CLAUDE.md` and Gemini agents read `GEMINI.md` after shared `AGENTS.md` (`AGENTS.md:5-8`, `:397-401`).

   **Actual reality:** Root `CLAUDE.md` and `GEMINI.md` are tiny pointer files. `CLAUDE.md:4` says to read `agents.md` (wrong casing on a case-sensitive filesystem, and not the filename actually present); `GEMINI.md:4` says to read `agent.md` (also singular/wrong). Neither adds useful current project guidance. The parent workspace files say each repo has its own guidance and that all four TermFlow repos use Bun; the core root pointer should be corrected to the actual `AGENTS.md` and should not promise nonexistent phase docs.

   **Verdict:** **PARTIALLY STALE.** The per-agent pointer concept exists, but the pointers are currently inaccurate and the shared file they reference is stale.

12. **MCP server gap**

   **Current AGENTS.md claim:** The architecture description has no MCP server module or command surface.

   **Actual reality:** `mcp-server/` is an active, tested TypeScript sidecar. `PROJECT_STRUCTURE.md:20`, `:62`, and `:183-186` describe bearer authentication, parent-PID watchdog, SSE heartbeat, self-identity, and terminal tools. `mcp-server/package.json` has `build`, `start`, `dev`, `test` (`bun test`), and `typecheck`; root `package.json:20`, `:54-55` has sidecar and MCP scripts. `src-tauri/build.rs`/Tauri configuration compile or launch it as a sidecar.

   **Verdict:** **STALE.** This is a major omission. Add MCP architecture, security/auth expectations, build/test commands, and the relationship between MCP, the Axum API, and the Tauri host.

13. **Major current features absent from AGENTS.md**

   **Current AGENTS.md claim:** The feature overview is mainly tabs, panes, shells, xterm rendering, Redux, REST/WebSocket, and generic agent monitoring (`AGENTS.md:102-118`, `:213-278`).

   **Actual reality:** Current README/structure/source show the shared instructions are silent on major features and boundaries, including:

   - `@termflow/terminal-core` shared engine, cache, snapshot hydration, WebGL policy, Kitty/`modifyOtherKeys` input protocol;
   - tmux-backed terminals and WSL fallback;
   - SQLite scrollback/history persistence and command history;
   - layout persistence and session restore/reconnect/resume handling;
   - Canvas Mode, canvas graph/edges, terminal connections, and multi-window detach/drag broker;
   - automation editor/runtime, targeting, scheduling, validation, logs, and webhook providers;
   - snippets import/export and command suggestions;
   - activity/unseen-output tracking, notification chime, native notifications, power/RDP reconnect repair;
   - network configuration, LAN exposure, token rotation, hot restart, port conflict detection;
   - in-terminal search, recordings/export, color schemes, zoom/maximize, accessibility dialogs, URL/file/editor opening;
   - MCP sidecar, optional `termflow-fabric` peering, Pro builds, sidecar compilation, and open-core licensing boundary;
   - terminal-kit `tk` CLI and `.agent-comms` scaffolding.

   **Verdict:** **STALE.** Add a concise architecture/features section prioritizing the active backend, shared terminal-core package, MCP boundary, persistence/reconnect, Canvas/automation, and optional fabric sidecar.

14. **File-size and coverage policy**

   **Current AGENTS.md claim:** A ~1,200-line file limit and 80%+ coverage for new code are presented as project rules (`AGENTS.md:45-47`), with 80% thresholds repeated for branches/functions/lines/statements (`AGENTS.md:346-349`).

   **Actual reality:** `jest.config.js:31-43` does enforce global root-Jest thresholds of 80 for branches, functions, lines, and statements, and collects coverage from `src` (excluding declarations/tests/index files). This is a real root Jest configuration, not proof that every new code path in every subproject is covered: root Jest excludes `terminal-monitor`, `mcp-server`, `packages`, and E2E paths (`jest.config.js:48-61`), while those components own separate runners/configurations. No config or script establishes a ~1,200-line maximum; it is an aspirational guidance limit at best. There is no root lint script, though `terminal-monitor` has its own lint scripts.

   **Verdict:** **PARTIALLY STALE.** Keep the 80% root-Jest threshold with its scope and exceptions stated precisely; label the file-size limit as a maintainability guideline unless an actual enforcement mechanism is added.

## Recommended new structure

1. **Scope and source of truth:** TermFlow core, current date/version, active Tauri architecture, and a warning that legacy Node/Electron-era files remain for compatibility/shared API use.
2. **Repository map:** `src-tauri`, `src`, `packages/terminal-core`, `mcp-server`, `terminal-monitor`, `agent-monitor`, `terminal-kit`, `scripts`, `tests`, and the limited local `docs` tree.
3. **Runtime boundaries:** Tauri/Rust backend, React/Webpack renderer, Axum API, MCP sidecar, optional fabric sidecar, and legacy Node API/shared utilities.
4. **Package manager/workspaces:** Bun as canonical; root workspaces; separate `mcp-server`, `agent-monitor`, and `terminal-kit` caveats; hoisted linker requirement.
5. **Canonical commands:** Bun dev/build/typecheck/test commands, terminal-core and MCP commands, monitor/agent-monitor commands, and the three Rust manifests/CI commands.
6. **Testing and quality:** root Jest 80% thresholds and exclusions, terminal-core/MCP/monitor-owned runners, Playwright quarantine/status, Rust tests/clippy, and no enforced file-size rule.
7. **Active architecture/features:** PTY/tmux, xterm 6/addons, persistence, layout/reconnect, Canvas, automation, snippets/history, notifications, network config, recordings/search, multi-window, and accessibility.
8. **MCP and security:** tools, bearer token, identity header, watchdog, heartbeat, API relationship, and sidecar build flow.
9. **Documentation routing:** local `docs/ci` and `docs/guides`; product planning/progress docs in sibling `termflow-fabric` per parent workspace guidance.
10. **Agent-specific pointers:** correct `CLAUDE.md`/`GEMINI.md` references to `AGENTS.md`; remove the unsupported Master Agent Protocol unless a maintained document is restored.

REPORT COMPLETE
