import { createServer } from "node:http";
import type { RequestListener, Server } from "node:http";

export interface ListenOptions {
    /** Pause between a refused bind and the next attempt. */
    retryMs: number;
    /** How long a port may stay occupied before the final attempt's error is reported. */
    limitMs: number;
}

export interface Listening {
    /** Resolves with the bound server, or rejects with the error that ended the attempts. */
    ready: Promise<Server>;
    /**
     * Stops trying. Idempotent. Before `ready` has resolved: `ready` then never settles and no attempt is
     * left bound. A server `ready` already handed over belongs to its caller, who closes it.
     */
    cancel(): void;
}

function closeQuietly(server: Server): void {
    try {
        server.close();
    } catch {
        /* never bound, or already closed */
    }
}

/**
 * Bind `app` to `port`/`host`, retrying while the port is still occupied (a previous holder is
 * mid-release). Each attempt is a fresh `http.createServer`: a server whose listen failed cannot be
 * reused. Only `EADDRINUSE` is retried; any other error rejects at once. The helper owns every
 * attempt until `ready` hands one over.
 * Measured on Windows with Bun 1.3.14: non-local addresses report EADDRINUSE with the same
 * fields as occupied ports, so these also wait out the ~5s production retry limit. On Linux
 * (Bun 1.4.3) they report EADDRNOTAVAIL and fail at once. See test/listen.test.ts (plan 057).
 */
export function startListening(app: RequestListener, port: number, host: string, options: ListenOptions): Listening {
    const deadline = Date.now() + options.limitMs;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Server | undefined;
    let resolveReady!: (server: Server) => void;
    let rejectReady!: (err: unknown) => void;
    const ready = new Promise<Server>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });

    function attempt(): void {
        timer = undefined;
        if (cancelled) return;
        const server = createServer(app);
        inFlight = server;
        let settled = false;
        // Settle exactly once, whichever of listening / error / a synchronous throw comes first.
        const settle = (outcome: () => void): void => {
            if (settled) return;
            settled = true;
            server.removeListener("listening", onListening);
            server.removeListener("error", onError);
            if (inFlight === server) inFlight = undefined;
            outcome();
        };
        const onListening = (): void =>
            settle(() => {
                if (cancelled) {
                    closeQuietly(server);
                    return;
                }
                resolveReady(server);
            });
        const onError = (err: Error): void =>
            settle(() => {
                if (cancelled) {
                    closeQuietly(server);
                    return;
                }
                const occupied = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
                if (occupied && Date.now() + options.retryMs < deadline) {
                    closeQuietly(server);
                    timer = setTimeout(attempt, options.retryMs);
                    return;
                }
                closeQuietly(server);
                rejectReady(err);
            });
        server.once("listening", onListening);
        server.once("error", onError);
        try {
            server.listen(port, host);
        } catch (err) {
            onError(err as Error);
        }
    }

    attempt();

    return {
        ready,
        cancel(): void {
            cancelled = true;
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            const pending = inFlight;
            inFlight = undefined;
            if (pending) closeQuietly(pending);
        },
    };
}
