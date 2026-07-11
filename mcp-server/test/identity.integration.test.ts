import { test, expect } from "bun:test";
import { spawnSidecar } from "./helpers";

const ACCEPT_BOTH = "application/json, text/event-stream";

/** Minimal mock of the backend REST API; records every path the sidecar calls. */
function startMockBackend() {
    const seen: string[] = [];
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
            const { pathname } = new URL(req.url);
            seen.push(pathname);
            // Echo a terminal-detail-ish body for any /api/terminals/:id GET.
            return new Response(JSON.stringify({ id: "echo", pid: 1, tabId: "tb-x", name: "n" }), {
                headers: { "content-type": "application/json" },
            });
        },
    });
    return { base: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

async function initSessionWithHeader(base: string, terminalId?: string): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: ACCEPT_BOTH };
    if (terminalId) headers["X-Termflow-Terminal-Id"] = terminalId;
    const init = await fetch(`${base}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "itest", version: "0.0.0" } },
        }),
    });
    const sessionId = init.headers.get("mcp-session-id");
    await init.body?.cancel().catch(() => {});
    if (!sessionId) throw new Error(`no mcp-session-id (status ${init.status})`);
    const ack = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    await ack.body?.cancel().catch(() => {});
    return sessionId;
}

async function callGetMyTerminal(base: string, sessionId: string, terminalId?: string): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: ACCEPT_BOTH, "mcp-session-id": sessionId };
    if (terminalId) headers["X-Termflow-Terminal-Id"] = terminalId;
    const resp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_my_terminal", arguments: {} } }),
    });
    // Draining the body guarantees the tool handler (and its backend call) ran.
    await resp.text();
}

test(
    "captures X-Termflow-Terminal-Id and routes get_my_terminal to that terminal; stays anonymous without it",
    async () => {
        const backend = startMockBackend();
        const sc = await spawnSidecar({ AUTO_TERMINAL_API_URL: backend.base });
        try {
            // With the header: get_my_terminal must hit the backend for THAT id.
            const withId = await initSessionWithHeader(sc.base, "pc-itest123");
            await callGetMyTerminal(sc.base, withId, "pc-itest123");
            expect(backend.seen).toContain("/api/terminals/pc-itest123");

            // Without the header: get_my_terminal resolves "me" -> no caller, so it
            // errors at the sidecar and never reaches the backend.
            const before = backend.seen.length;
            const anon = await initSessionWithHeader(sc.base);
            await callGetMyTerminal(sc.base, anon);
            expect(backend.seen.length).toBe(before);

            // Late arrival: init WITHOUT the header, then a LATER tools/call that DOES
            // carry it must refresh the session id (reuse-branch rememberTerminalId in
            // index.ts) so "me" resolves to it. Exercises the real header ->
            // sessionTerminalIds plumbing, not a synthetic getCallerId.
            const late = await initSessionWithHeader(sc.base);
            await callGetMyTerminal(sc.base, late, "pc-late0001");
            expect(backend.seen).toContain("/api/terminals/pc-late0001");
        } finally {
            await sc.stop();
            backend.stop();
        }
    },
    20000,
);
