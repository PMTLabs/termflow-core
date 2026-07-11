import { test, expect } from "bun:test";
import { createApiClient } from "../src/apiClient";

test("api client defaults to an 8s timeout", () => {
    const client = createApiClient({ baseURL: "http://127.0.0.1:1" });
    expect(client.defaults.timeout).toBe(8000);
});

test("a stalled backend aborts the request via the timeout instead of hanging", async () => {
    // A server that accepts the connection but never responds.
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
        const client = createApiClient({ baseURL: `http://127.0.0.1:${server.port}`, timeout: 200 });
        const start = Date.now();
        let code: string | undefined;
        try {
            await client.get("/terminals");
        } catch (e: any) {
            code = e.code;
        }
        expect(code).toBe("ECONNABORTED");
        expect(Date.now() - start).toBeLessThan(2000);
    } finally {
        server.stop(true);
    }
});
