import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { randomUUID, timingSafeEqual } from "node:crypto";

/** Constant-time string equality (guards the terminal-I/O auth surface). */
function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "node:http";
import { createApiClient } from "./apiClient.js";
import { createMcpServer } from "./server.js";
import { readTerminalIdHeader } from "./identity.js";
import { startSseHeartbeat } from "./heartbeat.js";

// Configuration
const MCP_PORT = parseInt(process.env.MCP_PORT || "42032", 10);
const MCP_HOST = process.env.MCP_HOST || "127.0.0.1";
const API_BASE = (process.env.AUTO_TERMINAL_API_URL || "http://localhost:42031").replace(/\/+$/, "") + "/api";
// Single access token. Used both to authenticate incoming MCP requests (when set,
// i.e. networked) and to authorize this server's calls to the backend API.
// AUTO_TERMINAL_TOKEN is preferred; AUTO_TERMINAL_API_TOKEN kept for back-compat.
const ACCESS_TOKEN = process.env.AUTO_TERMINAL_TOKEN || process.env.AUTO_TERMINAL_API_TOKEN || "";
const API_TOKEN = ACCESS_TOKEN || undefined;

// Axios instance with default auth if token is provided. A finite timeout
// prevents a stalled backend from hanging the MCP request indefinitely.
const api = createApiClient({ baseURL: API_BASE, token: API_TOKEN });

// Express app setup
const app = express();
app.use(cors());
app.use(express.json());

// Incoming-request auth gate. Enforced ONLY when ACCESS_TOKEN is set (networked
// mode); in localhost mode it is empty and every request passes (back-compat).
// Health stays open so the app's Settings page can always poll status.
app.use((req: Request, res: Response, next) => {
    if (!ACCESS_TOKEN) return next();
    if (req.path === "/health") return next();
    const auth = req.header("authorization") || "";
    if (safeEqual(auth, `Bearer ${ACCESS_TOKEN}`)) return next();
    res.status(401).json({ error: "unauthorized" });
});

// Session management - stores active transports by session ID
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Per-session caller terminal id, captured from the X-Termflow-Terminal-Id header
// (mapped from $TERMFLOW_TERMINAL_ID). Refreshed whenever any request carries it, so
// a session is never stuck anonymous if the header arrives after initialize. One
// agent = one MCP client = one session = one terminal, so this stays stable.
// NOTE: this is a self-identification convenience, NOT a trust boundary — an
// authenticated client can already target any terminal by its explicit id.
const sessionTerminalIds = new Map<string, string>();

/** Capture/refresh the caller terminal id for a known session from request headers. */
function rememberTerminalId(
    sessionId: string | undefined,
    headers: Record<string, string | string[] | undefined>
): void {
    if (!sessionId) return;
    const id = readTerminalIdHeader(headers);
    if (id) sessionTerminalIds.set(sessionId, id);
}

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
    const activeSessions = Object.keys(transports).length;
    res.json({
        status: "healthy",
        server: "auto-terminal-mcp",
        version: "0.2.0",
        activeSessions,
        apiBackend: API_BASE,
        // Echo the launching app's identity (P0b) so its Settings health check can
        // distinguish OUR sidecar from another instance's that owns this MCP port.
        instanceId: process.env.AUTO_TERMINAL_INSTANCE_ID || "",
    });
});

// A session id was supplied but is unknown (e.g. the sidecar restarted). Use the
// SDK's "Session not found" contract (404 / -32001) so clients can detect it,
// rather than the misleading 400 we used to return for a header that WAS present.
function sessionNotFound(res: Response): void {
    res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
    });
}

// Last-resort guard so one failing request can't crash the process and drop
// every other client's session. Only writes if the SDK hasn't already responded.
function internalError(res: Response, err: unknown): void {
    console.error("[MCP] request handler error:", err);
    if (!res.headersSent) {
        res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
        });
    }
}

// POST /mcp - Handle MCP requests (initialize or regular requests)
app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
        // Reuse existing session. Refresh the caller terminal id in case the header
        // wasn't present at initialize but is now (keeps "me" resolvable).
        transport = transports[sessionId];
        rememberTerminalId(sessionId, req.headers);
    } else if (isInitializeRequest(req.body)) {
        // New session initialization. An initialize request mints a fresh session
        // even if the client sent a stale mcp-session-id (matching the SDK server
        // contract), so a re-initializing client recovers instead of dead-ending.
        // Capture the caller terminal id from THIS request's header; bind it to the
        // session once its id is generated.
        const initialTerminalId = readTerminalIdHeader(req.headers);
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
                transports[id] = transport;
                if (initialTerminalId) sessionTerminalIds.set(id, initialTerminalId);
                console.log(`[MCP] Session initialized: ${id}`);
            },
            onsessionclosed: (id) => {
                delete transports[id];
                sessionTerminalIds.delete(id);
                console.log(`[MCP] Session closed: ${id}`);
            },
        });

        // Handle transport close event
        transport.onclose = () => {
            if (transport.sessionId) {
                delete transports[transport.sessionId];
                sessionTerminalIds.delete(transport.sessionId);
                console.log(`[MCP] Transport closed for session: ${transport.sessionId}`);
            }
        };

        // Create new MCP server instance for this session and connect. The caller-id
        // getter reads the live per-session map at tool-call time (not a frozen value).
        const server = createMcpServer({
            api,
            getCallerId: () => (transport.sessionId ? sessionTerminalIds.get(transport.sessionId) : undefined),
        });
        await server.connect(transport);
        console.log(`[MCP] New server connected for session initialization`);
    } else if (sessionId) {
        // Session id present but unknown (most often: the sidecar was restarted).
        sessionNotFound(res);
        return;
    } else {
        // No session id and not an initialize request.
        res.status(400).json({
            jsonrpc: "2.0",
            error: {
                code: -32600,
                message: "Bad Request: missing mcp-session-id header or not an initialize request",
            },
            id: null,
        });
        return;
    }

    // Handle the request through the transport
    try {
        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        internalError(res, err);
    }
});

// GET /mcp - SSE stream for server-to-client notifications
app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports[sessionId];

    if (transport) {
        // Capture the caller id here too, in case it arrives on the SSE stream
        // request rather than the POST handshake.
        rememberTerminalId(sessionId, req.headers);
        // This stream is byte-silent between notifications, so keep it alive:
        // disable the socket idle timeout and emit a periodic SSE-comment
        // heartbeat (otherwise Bun's ~10s idle close / the client's undici
        // bodyTimeout reaps it and the client reports a lost connection).
        req.socket.setTimeout(0);
        const stopHeartbeat = startSseHeartbeat(res);
        req.on("close", stopHeartbeat);
        try {
            await transport.handleRequest(req, res);
        } catch (err) {
            internalError(res, err);
        }
    } else {
        sessionNotFound(res);
    }
});

// DELETE /mcp - Close session
app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string;
    const transport = transports[sessionId];

    if (transport) {
        try {
            await transport.handleRequest(req, res);
        } catch (err) {
            internalError(res, err);
        }
    } else {
        sessionNotFound(res);
    }
});

// Captured at app.listen() so graceful shutdown can stop accepting connections.
let server: Server | undefined;

/**
 * Close active transports (so each SSE/POST stream gets an orderly end instead
 * of a raw socket reset) and then exit. Bounded by a 1.5s race so a stuck stream
 * can't block exit. Do NOT try to keep running afterward.
 */
let exiting = false;
async function gracefulExit(code: number): Promise<void> {
    // Re-entrancy guard: the 2s watchdog tick, SIGINT/SIGTERM, and uncaughtException
    // can all call this, and the 1.5s close race leaves a window for overlap.
    if (exiting) return;
    exiting = true;
    try {
        await Promise.race([
            Promise.all(Object.values(transports).map((t) => t.close().catch(() => {}))),
            new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
    } catch {
        /* ignore */
    }
    try {
        server?.close();
    } catch {
        /* ignore */
    }
    process.exit(code);
}

// A stray rejection/exception must not silently take down every session. Always
// log; for a truly uncaught exception the process state is undefined, so shut
// down gracefully and let the desktop app respawn the sidecar.
process.on("unhandledRejection", (reason) => {
    console.error("[MCP] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("[MCP] uncaughtException:", err);
    void gracefulExit(1);
});

// Orphan guard: when launched as a sidecar by the desktop app, the app passes
// its own PID via MCP_PARENT_PID. If the app dies abruptly (e.g. Ctrl+C during
// `tauri dev`), its graceful sidecar-shutdown never runs, so we'd linger and
// keep holding the MCP port. Poll the parent and self-exit once it's gone.
const PARENT_PID = parseInt(process.env.MCP_PARENT_PID || "", 10);
if (!Number.isNaN(PARENT_PID) && PARENT_PID > 0) {
    const watchdog = setInterval(() => {
        try {
            // Signal 0 doesn't kill — it only probes existence; throws if gone.
            process.kill(PARENT_PID, 0);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ESRCH") {
                console.log(`[MCP] Parent process ${PARENT_PID} is gone — shutting down.`);
                void gracefulExit(0);
            }
            // EPERM (exists, not ours) or other: treat as still alive.
        }
    }, 2000);
    // Don't let the watchdog timer itself keep the process alive.
    watchdog.unref?.();
}

// Exit cleanly if the signal is actually delivered to us (belt-and-suspenders
// alongside the parent watchdog above).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void gracefulExit(0));
}

// Start the HTTP server
server = app.listen(MCP_PORT, MCP_HOST, () => {
    console.log(`[MCP] Auto-Terminal MCP Server started`);
    console.log(`[MCP] Listening on http://${MCP_HOST}:${MCP_PORT}`);
    console.log(`[MCP] Health check: http://${MCP_HOST}:${MCP_PORT}/health`);
    console.log(`[MCP] MCP endpoint: http://${MCP_HOST}:${MCP_PORT}/mcp`);
    console.log(`[MCP] Auth: ${ACCESS_TOKEN ? "required (token)" : "open (localhost)"}`);
    console.log(`[MCP] Backend API: ${API_BASE}`);
});
