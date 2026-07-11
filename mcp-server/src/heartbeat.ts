import type { ServerResponse } from "node:http";

/** The minimal slice of ServerResponse the heartbeat needs (keeps it testable). */
type SseResponse = Pick<ServerResponse, "write" | "headersSent" | "writableEnded" | "destroyed" | "on">;

/**
 * Keeps a long-lived SSE response non-idle by writing a periodic SSE comment
 * (a `:`-prefixed line, which clients ignore per the SSE spec). This is what
 * stops the byte-silent GET /mcp stream from being reaped by an idle timeout
 * (Bun's ~10s server idle close and the client's undici ~300s bodyTimeout).
 *
 * Two guards make it safe to share the SDK-owned response stream:
 *  - it never writes before `headersSent`, avoiding the header-timing race where
 *    an early write forces an implicit (wrong) Content-Type before the SDK/Hono
 *    pump calls writeHead;
 *  - it skips writes once the response is ended/destroyed.
 *
 * Auto-clears when the response emits `close`; also returns a stop() for the
 * caller to wire to the request's close.
 */
export function startSseHeartbeat(res: SseResponse, intervalMs = 5000): () => void {
    const timer = setInterval(() => {
        if (res.headersSent && !res.writableEnded && !res.destroyed) {
            try {
                res.write(": ping\n\n");
            } catch {
                /* peer gone mid-write; the close handler will clear the timer */
            }
        }
    }, intervalMs);
    // The heartbeat alone must not keep the process alive.
    (timer as { unref?: () => void }).unref?.();

    const stop = () => clearInterval(timer);
    res.on("close", stop);
    return stop;
}
