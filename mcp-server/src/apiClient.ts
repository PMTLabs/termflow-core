import axios, { type AxiosInstance } from "axios";

/**
 * Builds the axios instance the MCP tools use to reach the Auto-Terminal REST API.
 * A finite timeout is mandatory: without it a stalled backend leaves the MCP
 * request (and its SSE stream) open indefinitely, which clients read as a dropped
 * connection. 8s is comfortably under the SSE idle/heartbeat window.
 *
 * Loopback must never go through a machine-wide proxy: HTTP_PROXY/HTTPS_PROXY are
 * honoured by axios (Node) and by the Bun runtime itself (below axios, so a per-client
 * `proxy: false` is not enough there), and both only exempt hosts listed in NO_PROXY.
 * Corporate machines commonly set the proxy vars without listing localhost — every API
 * call would then go to the web gateway and come back as an HTML block page. Bun
 * caches the NO_PROXY list once it has parsed it, so the exemption must be in place
 * before the first request — this runs when the client is created, at startup.
 */
export const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "[::1]"];

export function exemptLoopbackFromProxy(env: NodeJS.ProcessEnv = process.env): void {
    // Bun and proxy-from-env read `no_proxy` first and fall back to NO_PROXY only when
    // it is unset/empty, so both spellings must carry the exemption.
    for (const key of ["no_proxy", "NO_PROXY"]) {
        const existing = (env[key] ?? "").split(/[,\s]+/).filter(Boolean);
        const missing = LOOPBACK_NO_PROXY.filter((h) => !existing.includes(h));
        if (missing.length) env[key] = [...existing, ...missing].join(",");
    }
}

export function createApiClient(opts: { baseURL: string; token?: string; timeout?: number }): AxiosInstance {
    exemptLoopbackFromProxy();
    return axios.create({
        baseURL: opts.baseURL,
        timeout: opts.timeout ?? 8000,
        headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
        proxy: false,
    });
}
