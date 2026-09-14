export type McpClient = 'claude' | 'antigravity' | 'codex' | 'copilot';

export interface McpConfigOpts {
    client: McpClient;
    ip: string;
    port: number;
    token: string;
}

/** Display name per client, shared by the agent dropdown and the help text. */
export const CLIENT_LABELS: Record<McpClient, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    antigravity: 'Antigravity CLI',
    copilot: 'GitHub Copilot CLI',
};

/** Header that carries the caller's own terminal id, enabling get_my_terminal / "me". */
const IDENTITY_HEADER = 'X-Termflow-Terminal-Id';

/**
 * Build a paste-ready MCP server config block for the given client.
 *
 * Two values travel as HTTP headers (these are remote streamable-http servers, so an
 * `env` map is ignored — that's a stdio concept):
 *  - The auth token: known now, so it's INLINED as `Authorization: Bearer <token>`.
 *    (Putting it in `env` was the cause of the 401 "lost connection" reports.)
 *  - The caller's terminal id (X-Termflow-Terminal-Id): per-terminal and only known
 *    at runtime, so it must ENV-EXPAND `TERMFLOW_TERMINAL_ID` — there is no literal to
 *    bake. This powers get_my_terminal and the "me" sentinel.
 *
 * Per-client shapes / capabilities:
 *  - Claude Code (`.mcp.json`): `{ type: "http", url, headers }`; `${VAR}` expands in headers.
 *  - Codex (`config.toml`): `[mcp_servers.*]` with `http_headers` (literal) + `env_http_headers`
 *    (maps an env var name into a header) — so identity works without `${VAR}` syntax.
 *  - Antigravity CLI (`mcp_config.json`, Gemini CLI's successor): `{ serverUrl, headers }`.
 *    `url`/`httpUrl` are explicitly unsupported (Antigravity's docs call out that legacy
 *    keys are rejected). Carries the identity header the same `${VAR}` way as Claude Code;
 *    NOTE: Antigravity's own docs don't confirm `${VAR}` expansion inside `headers`, so if it
 *    isn't expanded there, `get_my_terminal`/"me" won't resolve and the terminal id must be
 *    passed explicitly instead — included anyway per explicit request.
 *  - GitHub Copilot CLI (`~/.copilot/mcp-config.json`): `{ type: "http", url, headers }` — same
 *    shape as Claude Code. Same caveat as Antigravity above: its docs don't confirm `${VAR}`
 *    expansion inside `headers` either.
 *
 * Treat the copied block as a secret (it contains the token).
 */
export function buildMcpConfig({ client, ip, port, token }: McpConfigOpts): string {
    const url = `http://${ip}:${port}/mcp`;

    if (client === 'codex') {
        // Codex config.toml: literal auth header + env-mapped identity header. `type` and
        // `streamable` are NOT real fields — Codex's RawMcpServerConfig is #[serde(deny_unknown_fields)]
        // and infers the streamable-http transport from `url` alone, so unknown keys reject the file.
        return [
            `[mcp_servers.termflow]`,
            `url = "${url}"`,
            `enabled = true`,
            `http_headers = { "Authorization" = "Bearer ${token}" }`,
            `env_http_headers = { "${IDENTITY_HEADER}" = "TERMFLOW_TERMINAL_ID" }`,
        ].join('\n');
    }

    if (client === 'antigravity') {
        // Antigravity CLI: serverUrl only — legacy url/httpUrl keys are rejected.
        const server = {
            serverUrl: url,
            headers: {
                Authorization: `Bearer ${token}`,
                [IDENTITY_HEADER]: '${TERMFLOW_TERMINAL_ID}',
            },
        };
        return JSON.stringify({ mcpServers: { termflow: server } }, null, 2);
    }

    if (client === 'copilot') {
        // GitHub Copilot CLI: same { type, url, headers } shape as Claude Code.
        const server = {
            type: 'http',
            url,
            headers: {
                Authorization: `Bearer ${token}`,
                [IDENTITY_HEADER]: '${TERMFLOW_TERMINAL_ID}',
            },
        };
        return JSON.stringify({ mcpServers: { termflow: server } }, null, 2);
    }

    // Claude Code: ${VAR} expands inside headers.
    const server = {
        type: 'http',
        url,
        headers: {
            Authorization: `Bearer ${token}`,
            [IDENTITY_HEADER]: '${TERMFLOW_TERMINAL_ID}',
        },
    };
    return JSON.stringify({ mcpServers: { termflow: server } }, null, 2);
}
