import { test, expect } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { startSseHeartbeat } from "../src/heartbeat";

// Empirical check (the dual-review's Q1): on the real Bun runtime, writing the
// heartbeat comment to a live ServerResponse keeps the SSE stream open and
// produces well-formed, client-readable bytes.
test("a real SSE response on Bun receives heartbeats and stays open", async () => {
    const app = express();
    app.get("/sse", (_req, res) => {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
        });
        res.flushHeaders?.();
        startSseHeartbeat(res, 30);
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.on("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const ac = new AbortController();
    let received = "";
    try {
        const resp = await fetch(`http://127.0.0.1:${port}/sse`, { signal: ac.signal });
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();
        const start = Date.now();
        while (Date.now() - start < 500) {
            const { value, done } = await reader.read();
            if (done) break;
            received += decoder.decode(value, { stream: true });
            if ((received.match(/: ping/g) ?? []).length >= 2) break;
        }
        ac.abort();
    } finally {
        server.close();
    }

    expect(received).toContain(": ping\n\n");
    expect((received.match(/: ping/g) ?? []).length).toBeGreaterThanOrEqual(2);
});
