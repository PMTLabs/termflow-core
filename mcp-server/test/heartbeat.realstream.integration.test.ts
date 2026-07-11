import { test, expect } from "bun:test";
import { spawnSidecar, initSession } from "./helpers";

// Closes the gap the dual-review flagged: the other heartbeat integration test
// uses a vanilla express route, NOT the real SDK-pumped GET /mcp. This boots the
// actual sidecar, completes the MCP handshake, opens the real notification stream,
// and asserts a heartbeat ping arrives through the SDK/@hono pump without mangling.
test(
    "the real SDK-pumped GET /mcp stream receives heartbeat pings",
    async () => {
        const sc = await spawnSidecar();
        try {
            const sessionId = await initSession(sc.base);

            const ac = new AbortController();
            const resp = await fetch(`${sc.base}/mcp`, {
                headers: { "mcp-session-id": sessionId, Accept: "text/event-stream" },
                signal: ac.signal,
            });
            expect(resp.status).toBe(200);

            const reader = resp.body!.getReader();
            const decoder = new TextDecoder();
            let received = "";
            const start = Date.now();
            // Heartbeat fires every 5s; read until the first ping or ~9s.
            while (Date.now() - start < 9000) {
                const { value, done } = await reader.read();
                if (done) break;
                received += decoder.decode(value, { stream: true });
                if (received.includes(": ping")) break;
            }
            ac.abort();

            expect(received).toContain(": ping\n\n");
        } finally {
            await sc.stop();
        }
    },
    25000,
);
