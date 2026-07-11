import net from "node:net";

const ACCEPT_BOTH = "application/json, text/event-stream";

export interface Sidecar {
    base: string;
    port: number;
    stop: () => Promise<void>;
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });
}

async function waitForHealth(base: string, ms: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < ms) {
        try {
            if ((await fetch(`${base}/health`)).ok) return true;
        } catch {
            /* not up yet */
        }
        await Bun.sleep(100);
    }
    return false;
}

/**
 * Spawn the real sidecar (`bun src/index.ts`) on a free port. The free-port
 * lookup has an unavoidable TOCTOU window, so if the chosen port was stolen
 * before the sidecar binds (health never comes up) we retry on a fresh port.
 */
export async function spawnSidecar(extraEnv: Record<string, string> = {}): Promise<Sidecar> {
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
        const port = await freePort();
        const base = `http://127.0.0.1:${port}`;
        const proc = Bun.spawn(["bun", "src/index.ts"], {
            cwd: `${import.meta.dir}/..`,
            env: {
                ...process.env,
                MCP_PORT: String(port),
                MCP_HOST: "127.0.0.1",
                AUTO_TERMINAL_API_URL: "http://127.0.0.1:1",
                AUTO_TERMINAL_TOKEN: "",
                ...extraEnv,
            },
            stdout: "ignore",
            stderr: "ignore",
        });
        const stop = async () => {
            proc.kill();
            await proc.exited;
        };
        if (await waitForHealth(base, 6000)) {
            return { base, port, stop };
        }
        await stop();
        lastErr = `sidecar did not become healthy on port ${port}`;
    }
    throw new Error(`spawnSidecar failed after 3 attempts: ${lastErr}`);
}

/** Run the MCP initialize handshake against a running sidecar; returns the session id. */
export async function initSession(base: string): Promise<string> {
    const init = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: ACCEPT_BOTH },
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
    const sessionId = init.headers.get("mcp-session-id");
    try {
        await init.body?.cancel();
    } catch {
        /* ignore */
    }
    if (!sessionId) throw new Error(`initialize returned no mcp-session-id (status ${init.status})`);

    // Complete the handshake so the session is fully initialized.
    const ack = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: ACCEPT_BOTH, "mcp-session-id": sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    try {
        await ack.body?.cancel();
    } catch {
        /* ignore */
    }
    return sessionId;
}
