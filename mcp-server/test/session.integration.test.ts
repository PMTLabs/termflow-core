import { test, expect } from "bun:test";
import { spawnSidecar } from "./helpers";

const ACCEPT_BOTH = "application/json, text/event-stream";

test(
    "an unknown/stale mcp-session-id returns 404 with JSON-RPC code -32001 on GET/POST/DELETE",
    async () => {
        const sc = await spawnSidecar();
        try {
            const get = await fetch(`${sc.base}/mcp`, {
                headers: { "mcp-session-id": "bogus", Accept: "text/event-stream" },
            });
            expect(get.status).toBe(404);
            expect((await get.json()).error.code).toBe(-32001);

            const del = await fetch(`${sc.base}/mcp`, {
                method: "DELETE",
                headers: { "mcp-session-id": "bogus" },
            });
            expect(del.status).toBe(404);
            expect((await del.json()).error.code).toBe(-32001);

            const post = await fetch(`${sc.base}/mcp`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: ACCEPT_BOTH, "mcp-session-id": "bogus" },
                body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
            });
            expect(post.status).toBe(404);
            expect((await post.json()).error.code).toBe(-32001);
        } finally {
            await sc.stop();
        }
    },
    20000,
);

test(
    "an initialize request carrying a stale session id mints a fresh session (not 404)",
    async () => {
        // A non-SDK client that re-initializes without clearing its old session id
        // should get a fresh session (SDK server contract), not a dead-end 404.
        const sc = await spawnSidecar();
        try {
            const res = await fetch(`${sc.base}/mcp`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: ACCEPT_BOTH,
                    "mcp-session-id": "stale-bogus",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion: "2025-03-26",
                        capabilities: {},
                        clientInfo: { name: "itest", version: "0.0.0" },
                    },
                }),
            });
            try {
                await res.body?.cancel();
            } catch {
                /* ignore */
            }
            expect(res.status).not.toBe(404);
            expect(res.headers.get("mcp-session-id")).toBeTruthy();
        } finally {
            await sc.stop();
        }
    },
    20000,
);
