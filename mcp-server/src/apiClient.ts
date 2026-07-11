import axios, { type AxiosInstance } from "axios";

/**
 * Builds the axios instance the MCP tools use to reach the Auto-Terminal REST API.
 * A finite timeout is mandatory: without it a stalled backend leaves the MCP
 * request (and its SSE stream) open indefinitely, which clients read as a dropped
 * connection. 8s is comfortably under the SSE idle/heartbeat window.
 */
export function createApiClient(opts: { baseURL: string; token?: string; timeout?: number }): AxiosInstance {
    return axios.create({
        baseURL: opts.baseURL,
        timeout: opts.timeout ?? 8000,
        headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    });
}
