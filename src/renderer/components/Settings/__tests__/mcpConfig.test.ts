import { buildMcpConfig } from '../mcpConfig';

describe('buildMcpConfig', () => {
    it('Claude Code: token rides an Authorization header (type+url shape), never env', () => {
        const server = JSON.parse(
            buildMcpConfig({ client: 'claude', ip: '192.168.1.5', port: 42032, token: 'secret' })
        ).mcpServers['auto-terminal'];

        expect(server.type).toBe('http');
        expect(server.url).toBe('http://192.168.1.5:42032/mcp');
        expect(server.headers.Authorization).toBe('Bearer secret');
        expect(server.env).toBeUndefined();
    });

    it('Gemini CLI: token rides an Authorization header (httpUrl shape), never env/type/url', () => {
        const server = JSON.parse(
            buildMcpConfig({ client: 'gemini', ip: '10.0.0.2', port: 42032, token: 'secret' })
        ).mcpServers['auto-terminal'];

        expect(server.httpUrl).toBe('http://10.0.0.2:42032/mcp');
        expect(server.headers.Authorization).toBe('Bearer secret');
        expect(server.url).toBeUndefined();
        expect(server.type).toBeUndefined();
        expect(server.env).toBeUndefined();
    });

    it('Claude Code: emits the identity header env-expanding TERMFLOW_TERMINAL_ID', () => {
        const server = JSON.parse(
            buildMcpConfig({ client: 'claude', ip: '127.0.0.1', port: 42032, token: 'secret' })
        ).mcpServers['auto-terminal'];

        expect(server.headers['X-Termflow-Terminal-Id']).toBe('${TERMFLOW_TERMINAL_ID}');
    });

    it('Gemini CLI: OMITS the identity header (no env-expansion in headers)', () => {
        const block = buildMcpConfig({ client: 'gemini', ip: '10.0.0.2', port: 42032, token: 'secret' });
        const server = JSON.parse(block).mcpServers['auto-terminal'];

        expect(server.headers['X-Termflow-Terminal-Id']).toBeUndefined();
        // Must not leak the literal env-var placeholder anywhere in the block.
        expect(block).not.toContain('TERMFLOW_TERMINAL_ID');
    });

    it('Codex: emits TOML with literal auth + env-mapped identity header', () => {
        const block = buildMcpConfig({ client: 'codex', ip: '127.0.0.1', port: 42032, token: 'secret' });

        expect(block).toContain('[mcp_servers.auto-terminal]');
        expect(block).toContain('url = "http://127.0.0.1:42032/mcp"');
        expect(block).toContain('http_headers = { "Authorization" = "Bearer secret" }');
        expect(block).toContain('env_http_headers = { "X-Termflow-Terminal-Id" = "TERMFLOW_TERMINAL_ID" }');
    });

    it('keeps the server key named "auto-terminal" for all JSON clients', () => {
        for (const client of ['claude', 'gemini'] as const) {
            const parsed = JSON.parse(buildMcpConfig({ client, ip: '127.0.0.1', port: 42032, token: 't' }));
            expect(parsed.mcpServers['auto-terminal']).toBeDefined();
        }
    });
});
