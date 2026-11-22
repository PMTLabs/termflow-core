import { buildMcpConfig } from '../mcpConfig';

describe('buildMcpConfig', () => {
    it('Claude Code: token rides an Authorization header (type+url shape), never env', () => {
        const server = JSON.parse(
            buildMcpConfig({ client: 'claude', ip: '192.168.1.5', port: 42032, token: 'secret' })
        ).mcpServers['termflow'];

        expect(server.type).toBe('http');
        expect(server.url).toBe('http://192.168.1.5:42032/mcp');
        expect(server.headers.Authorization).toBe('Bearer secret');
        expect(server.env).toBeUndefined();
    });

    it('Antigravity CLI: token rides an Authorization header (serverUrl shape), never env/type/url/httpUrl', () => {
        const server = JSON.parse(
            buildMcpConfig({ client: 'antigravity', ip: '10.0.0.2', port: 42032, token: 'secret' })
        ).mcpServers['termflow'];

        expect(server.serverUrl).toBe('http://10.0.0.2:42032/mcp');
        expect(server.headers.Authorization).toBe('Bearer secret');
        expect(server.url).toBeUndefined();
        expect(server.httpUrl).toBeUndefined();
        expect(server.type).toBeUndefined();
        expect(server.env).toBeUndefined();
    });

    it('Claude Code: emits the identity header env-expanding TERMFLOW_TERMINAL_ID', () => {
        const server = JSON.parse(
            buildMcpConfig({ client: 'claude', ip: '127.0.0.1', port: 42032, token: 'secret' })
        ).mcpServers['termflow'];

        expect(server.headers['X-Termflow-Terminal-Id']).toBe('${TERMFLOW_TERMINAL_ID}');
    });

    it('Antigravity CLI: emits the identity header env-expanding TERMFLOW_TERMINAL_ID', () => {
        const server = JSON.parse(
            buildMcpConfig({ client: 'antigravity', ip: '10.0.0.2', port: 42032, token: 'secret' })
        ).mcpServers['termflow'];

        expect(server.headers['X-Termflow-Terminal-Id']).toBe('${TERMFLOW_TERMINAL_ID}');
    });

    it('Codex: emits TOML with literal auth + env-mapped identity header', () => {
        const block = buildMcpConfig({ client: 'codex', ip: '127.0.0.1', port: 42032, token: 'secret' });

        expect(block).toContain('[mcp_servers.termflow]');
        expect(block).toContain('url = "http://127.0.0.1:42032/mcp"');
        expect(block).toContain('enabled = true');
        expect(block).toContain('http_headers = { "Authorization" = "Bearer secret" }');
        expect(block).toContain('env_http_headers = { "X-Termflow-Terminal-Id" = "TERMFLOW_TERMINAL_ID" }');
    });

    it('Codex: never emits unknown fields Codex\'s deny_unknown_fields parser would reject', () => {
        const block = buildMcpConfig({ client: 'codex', ip: '127.0.0.1', port: 42032, token: 'secret' });

        // `type`/`streamable`/a `[mcp_servers.termflow.headers]` sub-table are not real fields on
        // Codex's RawMcpServerConfig; the transport is inferred from `url` alone.
        expect(block).not.toMatch(/^\s*type\s*=/m);
        expect(block).not.toMatch(/^\s*streamable\s*=/m);
        expect(block).not.toContain('[mcp_servers.termflow.headers]');
    });

    it('GitHub Copilot CLI: token rides an Authorization header (type+url shape, like Claude Code)', () => {
        const server = JSON.parse(
            buildMcpConfig({ client: 'copilot', ip: '10.0.0.2', port: 42032, token: 'secret' })
        ).mcpServers['termflow'];

        expect(server.type).toBe('http');
        expect(server.url).toBe('http://10.0.0.2:42032/mcp');
        expect(server.headers.Authorization).toBe('Bearer secret');
        expect(server.env).toBeUndefined();
    });

    it('GitHub Copilot CLI: emits the identity header env-expanding TERMFLOW_TERMINAL_ID', () => {
        const server = JSON.parse(
            buildMcpConfig({ client: 'copilot', ip: '10.0.0.2', port: 42032, token: 'secret' })
        ).mcpServers['termflow'];

        expect(server.headers['X-Termflow-Terminal-Id']).toBe('${TERMFLOW_TERMINAL_ID}');
    });

    it('keeps the server key named "termflow" for all JSON clients', () => {
        for (const client of ['claude', 'antigravity', 'copilot'] as const) {
            const parsed = JSON.parse(buildMcpConfig({ client, ip: '127.0.0.1', port: 42032, token: 't' }));
            expect(parsed.mcpServers['termflow']).toBeDefined();
        }
    });
});
