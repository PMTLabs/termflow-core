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
            description: "List active terminal sessions across the fleet. Each entry includes machineId, os, and deviceName; local terminals are tagged with this machine.",
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
            description: "Spawn a new terminal process (supports split panel layout)",
            inputSchema: {
                name: z.string().optional().describe("Name of the terminal session"),
                profile: z.string().optional().describe("Shell profile ID (e.g., 'powershell', 'cmd', 'git-bash'). Defaults to system default."),
                cols: z.number().optional().default(120),
                rows: z.number().optional().default(40),
                cwd: z.string().optional().describe("Current working directory"),
                tabId: z.string().optional().describe("Tab ID where the terminal pane should be created/split"),
                paneId: z.string().optional().describe("Pane ID within the tab to split"),
                direction: z.enum(["horizontal", "vertical"]).optional().describe("Split direction: 'horizontal' (split right) or 'vertical' (split bottom)"),
            },
        },
        async ({ name, profile, cols, rows, cwd, tabId, paneId, direction }) => {
            try {
                const response = await api.post(`/terminals`, {
                    name,
                    profile_id: profile,
                    cols,
                    rows,
                    cwd,
                    tabId,
                    paneId,
                    direction,
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
                command: z.string().describe("The command string to execute"),
                cliType: z.enum(["default", "claude", "gemini", "chatgpt", "copilot"]).optional().describe("The CLI personality/keystroke pattern. Defaults to copilot if omitted."),
                useBracketedPaste: z.boolean().optional().describe("Whether to use bracketed paste mode for the prompt (more reliable for long inputs)"),
                targetOS: z.enum(["windows", "macos", "linux"]).optional().describe("Route to the unique online peer running this OS (fleet). Mutually informative with machineId/terminalId."),
                machineId: z.string().optional().describe("Route to a specific peer machine by its machineId (fleet)."),
                timeoutMs: z.number().optional().describe("Fleet: max ms to wait for command completion before returning a live handle (done=false). Clamped server-side to [1000, 3600000]."),
            },
        },
        async ({ terminalId, command, cliType, useBracketedPaste, targetOS, machineId, timeoutMs }) => {
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
            description: "Get detailed information about a specific terminal session (including its tabId)",
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
                "Get YOUR OWN terminal's identity and details (id, pid, tabId, name) — the terminal " +
                "this agent is running in. Resolved from the X-Termflow-Terminal-Id header (mapped " +
                "from the $TERMFLOW_TERMINAL_ID env var injected into every terminal). Use the returned " +
                'id, or the "me" shorthand, to target your own terminal with the other tools.',
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

    return server;
}
