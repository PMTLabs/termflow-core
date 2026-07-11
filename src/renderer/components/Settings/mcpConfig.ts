export type McpClient = 'claude' | 'gemini' | 'codex';

export interface McpConfigOpts {
    client: McpClient;
    ip: string;
    port: number;
    token: string;
}

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
 *  - Gemini CLI (`settings.json`): `{ httpUrl, headers }`. Gemini does NOT expand env vars
 *    inside `headers` (only inside `env`), so the identity header is OMITTED — it would be
 *    sent literally and break "me". Gemini users pass the id explicitly from
 *    `$TERMFLOW_TERMINAL_ID` instead.
 *
 * Treat the copied block as a secret (it contains the token).
 */
export function buildMcpConfig({ client, ip, port, token }: McpConfigOpts): string {
    const url = `http://${ip}:${port}/mcp`;

    if (client === 'codex') {
        // Codex config.toml: literal auth header + env-mapped identity header.
        return [
            `[mcp_servers.auto-terminal]`,
            `url = "${url}"`,
            `http_headers = { "Authorization" = "Bearer ${token}" }`,
            `env_http_headers = { "${IDENTITY_HEADER}" = "TERMFLOW_TERMINAL_ID" }`,
        ].join('\n');
    }

    if (client === 'gemini') {
        // Gemini ignores env-expansion in headers → omit the identity header.
        const server = { httpUrl: url, headers: { Authorization: `Bearer ${token}` } };
        return JSON.stringify({ mcpServers: { 'auto-terminal': server } }, null, 2);
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
    return JSON.stringify({ mcpServers: { 'auto-terminal': server } }, null, 2);
}
