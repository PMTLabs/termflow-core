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

test("the loopback API client ignores a machine-wide HTTP_PROXY", () => {
    // Bun caches NO_PROXY once parsed and createApiClient mutates it process-wide, so the
    // corporate shape (proxy set, localhost absent from NO_PROXY) needs a fresh process.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !/^(https?|all|no)_proxy$/i.test(k)) env[k] = v;
    }
    env.HTTP_PROXY = env.http_proxy = "http://127.0.0.1:9";
    const child = Bun.spawnSync([process.execPath, "run", `${import.meta.dir}/proxyProbe.child.ts`], {
        env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const report = `${child.stdout.toString()}
${child.stderr.toString()}`;
    expect(report).toContain("control: proxied");
    expect(report).toContain("client: direct");
    expect(child.exitCode).toBe(0);
});
