import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTerminalId } from "./identity.js";

/** Minimal shape of the backend HTTP client the tools need (an AxiosInstance satisfies this). */
export interface ApiLike {
    get(url: string, config?: unknown): Promise<{ data: unknown }>;
    post(url: string, body?: unknown, config?: unknown): Promise<{ data: unknown }>;
    delete(url: string, config?: unknown): Promise<{ data: unknown }>;
}

export interface McpServerDeps {
    /** Backend REST client (DI so tests can inject a fake). */
    api: ApiLike;
    /** Returns the calling session's own terminal id, or undefined if not known. */
    getCallerId: () => string | undefined;
}

const ME_HINT = 'Use "me" for your own terminal, or pass an explicit id (e.g. $TERMFLOW_TERMINAL_ID).';

/**
 * Creates and configures a new McpServer with all terminal tools registered.
 * Side-effect free (no network, no listen) — dependencies are injected so this
 * can be unit/integration tested via an in-memory transport.
 */
export function createMcpServer({ api, getCallerId }: McpServerDeps): McpServer {
    const server = new McpServer({
        name: "auto-terminal-mcp",
        version: "0.2.0",
    });

    // Tool: list_terminals — fleet roster: local terminals (tagged with this machine)
    // plus peer terminals when the fabric is present. Each entry already carries
    // machineId/os/deviceName from core.
    server.registerTool(
        "list_terminals",
        {
            description: "List active terminal sessions across the fleet. Each entry includes machineId, os, and deviceName; local terminals are tagged with this machine. Each entry also carries `terminalId` (`tm-`, the terminal — durable across restarts) and `owningTabId` (`tb-`, its tab).",
        },
        async () => {
            try {
                const response = await api.get(`/fleet/terminals`);
                return {
                    content: [
                        { type: "text", text: JSON.stringify((response.data as { terminals?: unknown }).terminals, null, 2) },
                    ],
                };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
            }
        }
    );

    // Tool: create_terminal
    server.registerTool(
        "create_terminal",
        {
            description:
                "Spawn a new terminal process (supports split panel layout). " +
                "Every identity has its own prefix, and the prefix IS the type: " +
                "`tm-…` a TERMINAL (a pane's terminal — this is what you address, and it " +
                "survives an app restart); " +
                "`pc-…` a PROCESS (one PTY run — valid only for this run of the app, so never " +
                "save one across a restart); " +
                "`tb-…` a TAB; " +
                "`pn-…` a PANE. " +
                "Passing an id from the wrong space is rejected with a message naming the right " +
                "field, so you never silently address the wrong thing. Read ids from responses " +
                "rather than constructing them. " +
                "One thing the prefix does NOT tell you: whether a pane is a root, a solo pane " +
                "or a split. A `tm-…` terminal is very often the only pane in its tab. Use " +
                "`owningTabId` for tab identity and the pane-tree structure for shape.",
            inputSchema: {
                name: z.string().optional().describe("Name of the terminal session"),
                profile: z.string().optional().describe("Shell profile ID (e.g., 'powershell', 'cmd', 'git-bash'). Defaults to system default."),
                cols: z.number().optional().default(120),
                rows: z.number().optional().default(40),
                cwd: z.string().optional().describe("Current working directory"),
                owningTabId: z.string().optional().describe(
                    "The TAB (`tb-…`) the new pane should belong to — read it from " +
                    "get_terminal_detail's `owningTabId`. Preferred over `tabId`."
                ),
                tabId: z.string().optional().describe(
                    "DEPRECATED alias of owningTabId. Must be a TAB id (`tb-…`); passing a " +
                    "terminal id (`tm-…`) is rejected with 400 — use owningTabId instead."
                ),
                paneId: z.string().optional().describe("Pane ID within the tab to split"),
                direction: z.enum(["horizontal", "vertical"]).optional().describe("Split direction: 'horizontal' (split right) or 'vertical' (split bottom)"),
                connectToCaller: z.boolean().optional().default(true).describe(
                    "Draw a connection from YOUR terminal to the new one on the TermFlow canvas, " +
                    "recording that you spawned it. Default true. Set false for a terminal that " +
                    "is unrelated to your work."
                ),
            },
        },
        async ({ name, profile, cols, rows, cwd, owningTabId, tabId, paneId, direction, connectToCaller }) => {
            try {
                // Every other tool resolves the caller via getCallerId(); this one did not,
                // which is why agent-spawned terminals had no provenance. Absent identity is
                // not an error here — provenance is a bonus, never a precondition for a spawn.
                const parentTerminalId = connectToCaller === false ? undefined : getCallerId();
                const response = await api.post(`/terminals`, {
                    name,
                    profile_id: profile,
                    cols,
                    rows,
                    cwd,
                    owningTabId,
                    tabId,
                    paneId,
                    direction,
                    parentTerminalId,
                });
                return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
            }
        }
    );

    // Tool: execute_command
    server.registerTool(
        "execute_command",
        {
            description: "Execute a command in one or more terminals. Returns immediately (command is async).",
            inputSchema: {
                terminalId: z.union([z.string(), z.array(z.string())]).optional().describe(
                    `The ID(s) of the terminal(s) to execute on. Pass a single id or an array of ids to send the same command to several terminals. Optional for fleet routing (targetOS/machineId). ${ME_HINT}`
                ),
                command: z.string().describe(
                    "The command string to execute. Pass an EMPTY string for a bare submit: it skips the paste and sends only the submit keystroke, which presses Enter on a composer that already holds text (use it when a TUI left your prompt sitting unsubmitted)."
                ),
                cliType: z.enum(["default", "claude", "gemini", "chatgpt", "copilot", "codex", "opencode"]).optional().describe(
                    "The CLI personality/keystroke pattern. Defaults to copilot if omitted. Use `codex` or `opencode` for those TUIs — they submit on a plain Enter, whereas the copilot default prefixes a Down-Arrow that navigates message history in them."
                ),
                submissionSignal: z.string().optional().describe("Raw escape sequence to use as the submit keystroke, overriding cliType's pattern (e.g. \"\\r\"). For TUIs with no built-in pattern."),
                useBracketedPaste: z.boolean().optional().describe("Whether to use bracketed paste mode for the prompt (more reliable for long inputs)"),
                targetOS: z.enum(["windows", "macos", "linux"]).optional().describe("Route to the unique online peer running this OS (fleet). Mutually informative with machineId/terminalId."),
                machineId: z.string().optional().describe("Route to a specific peer machine by its machineId (fleet)."),
                timeoutMs: z.number().optional().describe("Fleet: max ms to wait for command completion before returning a live handle (done=false). Clamped server-side to [1000, 3600000]."),
            },
        },
        async ({ terminalId, command, cliType, useBracketedPaste, submissionSignal, targetOS, machineId, timeoutMs }) => {
            try {
                // Fleet routing: an explicit targetOS or machineId means route through the
                // cross-machine resolver (core POST /fleet/execute) instead of the local path.
                // A bare terminalId (no targetOS/machineId) stays local — existing behavior.
                if (targetOS !== undefined || machineId !== undefined) {
                    if (Array.isArray(terminalId)) {
                        return {
                            content: [{ type: "text", text: "Error: fleet routing targets a single terminal; pass a string terminalId or omit it" }],
                            isError: true,
                        };
                    }
                    const fleetTerminalId = terminalId !== undefined ? resolveTerminalId(terminalId, getCallerId()) : undefined;
                    const response = await api.post(`/fleet/execute`, {
                        command,
                        ...(targetOS !== undefined && { targetOS }),
                        ...(machineId !== undefined && { machineId }),
                        ...(fleetTerminalId !== undefined && { terminalId: fleetTerminalId }),
                        ...(timeoutMs !== undefined && { timeoutMs }),
                    });
                    return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
                }

                const extras = {
                    cliType: cliType || "copilot",
                    ...(useBracketedPaste !== undefined && { useBracketedPaste }),
                    ...(submissionSignal !== undefined && { submissionSignal }),
                };
                if (Array.isArray(terminalId)) {
                    const resolved = [...new Set(terminalId.map((t) => resolveTerminalId(t, getCallerId())))];
                    if (resolved.length === 0) {
                        return { content: [{ type: "text", text: "Error: terminalId array must not be empty" }], isError: true };
                    }
                    const response = await api.post(`/terminals/batch/execute`, {
                        terminalIds: resolved,
                        prompt: command,
                        ...extras,
                    });
                    return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
                }
                if (terminalId === undefined) {
                    return {
                        content: [{ type: "text", text: "Error: terminalId is required for local execution (pass a terminal id or an array of ids, or use fleet routing via targetOS/machineId)" }],
                        isError: true,
                    };
                }
                const id = resolveTerminalId(terminalId, getCallerId());
                const response = await api.post(`/terminals/${id}/execute`, {
                    prompt: command,
                    ...extras,
                });
                return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
            }
        }
    );

    // Tool: send_keys — raw PTY write. The escape hatch for anything the
    // execute_command keystroke patterns don't cover (submitting a stuck
    // composer, answering a y/n prompt, Ctrl+C, arrow keys).
    server.registerTool(
        "send_keys",
        {
            description:
                "Write raw bytes/escape sequences straight to a terminal's PTY — no paste wrapper, no submit keystroke appended. Use for keys rather than text: Enter \"\\r\", Ctrl+C \"\\u0003\", Esc \"\\u001b\", Up \"\\u001b[A\", Down \"\\u001b[B\". Prefer execute_command for sending a prompt; use this to submit a composer a TUI left unsubmitted, or to answer an interactive y/n prompt.",
            inputSchema: {
                terminalId: z.string().describe(`The ID of the terminal to write to. ${ME_HINT}`),
                keys: z.string().describe("Raw bytes to write, verbatim. Sent exactly as given — nothing is appended."),
            },
        },
        async ({ terminalId, keys }) => {
            try {
                const id = resolveTerminalId(terminalId, getCallerId());
                const response = await api.post(`/terminals/${id}/input`, { data: keys });
                return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
            }
        }
    );

    // Tool: get_terminal_output
    server.registerTool(
        "get_terminal_output",
        {
            description: "Get recent output from a terminal as a single clean, human-readable string in the `raw` field (ANSI stripped). Response also includes `totalLines` and `offset`. Use offset for pagination.",
            inputSchema: {
                terminalId: z.string().describe(`The ID of the terminal to read from. ${ME_HINT}`),
                lines: z.number().optional().default(50).describe("Number of lines to retrieve (default: 50). When offset=0, returns the LAST N lines (most recent output)."),
                offset: z.number().optional().default(0).describe("Line offset for pagination. 0 = return last N lines (default). Use with totalLines from response to paginate."),
            },
        },
        async ({ terminalId, lines, offset }) => {
            try {
                const id = resolveTerminalId(terminalId, getCallerId());
                const response = await api.get(`/terminals/${id}/output`, {
                    params: { lines, offset },
                });
                return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
            }
        }
    );

    // Tool: get_terminal_detail
    server.registerTool(
        "get_terminal_detail",
        {
            description: "Get detailed information about a specific terminal session, including its renderer pane id (`terminalId`) and the tab that owns it (`owningTabId`). `tabId` is a DEPRECATED alias of `terminalId` — it always carries a `tm-` terminal id and is never a tab id. Use `owningTabId` for the tab.",
            inputSchema: {
                terminalId: z.string().describe(`The ID of the terminal session to retrieve. ${ME_HINT}`),
            },
        },
        async ({ terminalId }) => {
            try {
                const id = resolveTerminalId(terminalId, getCallerId());
                const response = await api.get(`/terminals/${id}`);
                return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
            }
        }
    );

    // Tool: get_my_terminal — the caller's own terminal identity ("whoami").
    server.registerTool(
        "get_my_terminal",
        {
            description:
                "Get YOUR OWN terminal's identity and details (id, pid, terminalId, owningTabId, name) " +
                "— the terminal this agent is running in. Resolved from the X-Termflow-Terminal-Id " +
                "header (mapped from the $TERMFLOW_TERMINAL_ID env var injected into every terminal). " +
                "The response carries `terminalId` (this pane) and `owningTabId` (the tab it lives in); " +
                "pass the latter to create_terminal to open a sibling pane in the same tab. Use the " +
                'returned id, or the "me" shorthand, to target your own terminal with the other tools.',
        },
        async () => {
            try {
                const id = resolveTerminalId("me", getCallerId());
                const response = await api.get(`/terminals/${id}`);
                return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
            }
        }
    );

    // Tool: get_my_connections — the caller's own neighbours on the canvas.
    server.registerTool(
        "get_my_connections",
        {
            description:
                "Get the terminals connected to YOUR OWN terminal on the TermFlow canvas — " +
                "both connections you point at (outgoing) and connections pointing at you " +
                "(incoming). Resolved from the X-Termflow-Terminal-Id header, like " +
                "get_my_terminal. Each neighbour carries its nodeId, title, groupId, groupTitle, " +
                "direction, origin (user or agent), optional label and createdAt. An empty " +
                "`connections` array is a SUCCESSFUL result meaning nothing is connected to this " +
                "terminal yet, not an error. Title and group fields are null until Canvas Mode " +
                "has been opened at least once in this session — that is what publishes them.",
        },
        async () => {
            try {
                const id = resolveTerminalId("me", getCallerId());
                const response = await api.get(`/terminals/${id}/connections`);
                return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
            }
        }
    );

    // Tool: close_terminal
    server.registerTool(
        "close_terminal",
        {
            description: "Terminate a terminal session",
            inputSchema: {
                terminalId: z.string().describe(
                    'The ID of the terminal to close. Use "me" to close your own terminal ' +
                        "(self-terminating), or an explicit id ($TERMFLOW_TERMINAL_ID)."
                ),
            },
        },
        async ({ terminalId }) => {
            try {
                const id = resolveTerminalId(terminalId, getCallerId());
                await api.delete(`/terminals/${id}`);
                return { content: [{ type: "text", text: "Terminal closed successfully" }] };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
            }
        }
    );

    // Tool: list_machines — the fleet's machine roster (this instance + fabric peers).
    // Fabric absent → just this machine (online). Each entry: machineId, deviceName, os, online, self.
    server.registerTool(
        "list_machines",
        {
            description: "List all machines in the fleet (this instance plus paired peers). Each entry includes machineId, deviceName, os, online, and self. Use a machineId with execute_command/get_terminal_screen to target a peer.",
        },
        async () => {
            try {
                const response = await api.get(`/fleet/machines`);
                return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
            }
        }
    );

    // Tool: get_terminal_screen — the authoritative LIVE screen of a terminal
    // (local or a fleet peer). Preferred for observing progress; unlike
    // get_terminal_output it is the exact on-screen content, not a lossy history.
    server.registerTool(
        "get_terminal_screen",
        {
            description: "Get the authoritative LIVE screen of a terminal (local or a fleet peer) as readable plain text — ANSI stripped, column alignment preserved. Prefer this over get_terminal_output for watching progress. Returns { terminalId, title, running, screen }.",
            inputSchema: {
                machineId: z.string().optional().describe("Target peer machineId. Omit for a terminal on this machine."),
                terminalId: z.string().describe("The ID of the terminal whose live screen to read."),
            },
        },
        async ({ machineId, terminalId }) => {
            try {
                // Resolved like every other tool. This one passed the raw argument
                // straight through, so `"me"` was sent verbatim (404 instead of the
                // caller's own screen) and a `tb-`/`pn-` id got a bare not-found
                // rather than the message naming the field to use. It is also the
                // tool an agent reaches for most, so the gap was the most visible one.
                const id = resolveTerminalId(terminalId, getCallerId());
                const response = await api.post(`/fleet/screen`, {
                    ...(machineId !== undefined && { machineId }),
                    terminalId: id,
                });
                return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
            }
        }
    );

    return server;
}
