import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Constant-time string equality (guards the terminal-I/O auth surface). */
function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * The one predicate for "this Authorization header carries the configured token".
 * The auth gate and the drain branch both use it, so they cannot disagree.
 */
export function bearerMatches(token: string, header: string): boolean {
    return safeEqual(header, `Bearer ${token}`);
}

/**
 * Incoming-request auth gate. Enforced ONLY when `token` is set (networked mode
 * or elevated loopback); in unauthenticated localhost mode it is empty and every
 * request passes (back-compat). Health stays open so the app's Settings page can
 * always poll status.
 */
export function createAuthGate(token: string): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!token) return next();
        if (req.path === "/health") return next();
        const auth = req.header("authorization") || "";
        if (bearerMatches(token, auth)) return next();
        res.status(401).json({ error: "unauthorized" });
    };
}

/**
 * Whether the sidecar is draining, and since when. `begin` is the only way in, so
 * a repeated shutdown (watchdog tick, signal, stdin line) cannot restart the clock.
 */
export class DrainState {
    accepting = true;
    startedAt: number | null = null;

    begin(now: number): void {
        this.accepting = false;
        if (this.startedAt === null) this.startedAt = now;
    }
}

/** `2m10s`, `11m05s`; under a minute just `45s` (the host's format). */
export function formatElapsed(seconds: number): string {
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** The text a draining sidecar answers `tools/call` with: the host's Absent wording, minus the reason. */
export function waitText(elapsed: string): string {
    return (
        `TermFlow is restarting (${elapsed} ago). Your terminals are still running. ` +
        "Wait about 30 seconds and retry this call. Do not recreate terminals; " +
        "they will be reattached when TermFlow is back."
    );
}

/** A single JSON-RPC `tools/call` request (not a batch, not a notification) to `POST /mcp`; returns its id. */
function toolsCallId(req: Request): number | string | undefined {
    if (req.method !== "POST" || req.path !== "/mcp") return undefined;
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
    const message = body as { method?: unknown; id?: unknown };
    if (message.method !== "tools/call") return undefined;
    const id = message.id;
    if (typeof id === "string" || (typeof id === "number" && Number.isFinite(id))) return id;
    return undefined;
}

/**
 * Answers every request received while draining: a `tools/call` gets a timed
 * wait (a tool result with `isError`, so the agent retries instead of
 * recreating terminals); everything else keeps the plain 503.
 */
export function createDrainMiddleware(options: {
    drain: DrainState;
    token: string;
    now: () => number;
}): RequestHandler {
    const { drain, token, now } = options;
    return (req: Request, res: Response, next: NextFunction) => {
        if (drain.accepting) return next();
        const id = toolsCallId(req);
        if (id === undefined) {
            res.status(503).json({ error: "MCP server is shutting down" });
            return;
        }
        if (token && !bearerMatches(token, req.header("authorization") || "")) {
            res.status(401).json({ error: "unauthorized" });
            return;
        }
        const current = now();
        const elapsedMs = Math.max(0, current - (drain.startedAt ?? current));
        res.status(200).json({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: waitText(formatElapsed(Math.floor(elapsedMs / 1000))) }], isError: true },
        });
    };
}
