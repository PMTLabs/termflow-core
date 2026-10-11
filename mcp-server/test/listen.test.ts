import { afterEach, describe, expect, spyOn, test } from "bun:test";
import http from "node:http";
import express from "express";
import net from "node:net";
import { startListening } from "../src/listen.js";
import type { Listening } from "../src/listen.js";
import { closeHttpServer } from "../src/shutdown.js";

/**
 * Plan 056 T6: the sidecar's bind retry. Every test uses the production `startListening`, a real
 * Express app and real sockets; the only thing played with is who else holds the port.
 */

const HOST = "127.0.0.1";

function buildApp() {
    const app = express();
    app.get("/health", (_req, res) => {
        res.json({ status: "healthy", server: "termflow-mcp" });
    });
    return app;
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, HOST, () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

/** Occupy `port` the way a holder would. */
function occupy(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(port, HOST, () => resolve(srv));
    });
}

function release(srv: net.Server): Promise<void> {
    return new Promise((resolve) => srv.close(() => resolve()));
}

/** Whether something accepts a connection on the port right now. */
function accepts(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(port, HOST);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}

/** Resolves "pending" when the promise has not settled within `ms`. */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<"pending" | { value: T } | { error: unknown }> {
    const pending = new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms));
    return Promise.race([
        promise.then(
            (value) => ({ value }),
            (error) => ({ error }),
        ),
        pending,
    ]);
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
});

function track(listening: Listening): Listening {
    cleanup.push(async () => {
        listening.cancel();
        const outcome = await settlesWithin(listening.ready, 0);
        if (outcome !== "pending" && "value" in outcome) await closeHttpServer(outcome.value);
    });
    return listening;
}

describe("startListening", () => {
    test("Bun_bind_error_measurements_and_nonlocal_retry_limit", async () => {
        console.log(`Bun bind measurement version=${Bun.version} platform=${process.platform}`);
        const port = await freePort();
        const holder = await occupy(port);
        cleanup.push(() => release(holder));
        const cases = [
            ["in-use", port, HOST],
            ["non-local", port, "203.0.113.1"],
            ["invalid-host", port, "::notanip"],
        ] as const;
        const errors: NodeJS.ErrnoException[] = [];
        for (const [name, p, host] of cases) {
            const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
                const server = http.createServer();
                server.once("error", (err) => { server.close(); resolve(err); });
                server.once("listening", () => { server.close(); reject(new Error(`${name} unexpectedly bound`)); });
                try { server.listen(p, host); } catch (err) { server.close(); resolve(err as NodeJS.ErrnoException); }
            });
            console.log(JSON.stringify({ case: name, code: err.code, errno: err.errno, syscall: err.syscall, message: err.message }));
            errors.push(err);
        }
        expect(errors[0]?.code).toBe("EADDRINUSE");
        expect(errors[2]?.code).not.toBe("EADDRINUSE");
        // Windows (Bun 1.3.14): a non-local address reports the SAME code/errno/syscall as an
        // occupied port, so it is retried up to the limit. Linux (Bun 1.4.3, CI): EADDRNOTAVAIL,
        // errno -99, so it is not retried and fails at once.
        const windows = process.platform === "win32";
        if (windows) {
            expect(errors[1]?.code).toBe("EADDRINUSE");
            expect(errors[1]?.errno).toBe(errors[0]?.errno);
            expect(errors[1]?.syscall).toBe(errors[0]?.syscall);
        } else {
            expect(errors[1]?.code).toBe("EADDRNOTAVAIL");
        }
        const started = Date.now();
        const listening = track(startListening(buildApp(), port, "203.0.113.1", { retryMs: 20, limitMs: 300 }));
        const outcome = await settlesWithin(listening.ready, 2000);
        expect(outcome).not.toBe("pending");
        expect((outcome as { error: NodeJS.ErrnoException }).error.code).toBe(errors[1]?.code);
        if (windows) {
            expect(Date.now() - started).toBeGreaterThanOrEqual(250);
        } else {
            expect(Date.now() - started).toBeLessThan(250);
        }
        expect(Date.now() - started).toBeLessThan(2000);
    });

    test("invalid_port_observably_throws_without_error_event_or_retry", async () => {
        const original = http.Server.prototype.listen;
        let attempts = 0;
        let thrown: unknown;
        let errorEvents = 0;
        let observed: http.Server | undefined;
        const spy = spyOn(http.Server.prototype, "listen").mockImplementation(function (this: http.Server, ...args: unknown[]) {
            attempts++;
            observed = this;
            this.on("error", () => errorEvents++);
            try {
                return Reflect.apply(original, this, args);
            } catch (err) {
                thrown = err;
                throw err;
            }
        } as typeof original);
        try {
            const started = Date.now();
            // Bun clamps numeric 70000 to 65535, and emits validation errors asynchronously.
            // An invalid options object's throwing port getter exercises a REAL synchronous throw
            // before Bun's internal asynchronous error conversion. The spy only observes it.
            const invalidPort = { get port(): number { throw new RangeError("invalid port getter"); } } as unknown as number;
            const listening = track(startListening(buildApp(), invalidPort, HOST, { retryMs: 400, limitMs: 5000 }));
            const outcome = await settlesWithin(listening.ready, 300);
            expect(outcome).not.toBe("pending");
            expect(thrown).toBeInstanceOf(Error);
            expect((outcome as { error: unknown }).error).toBe(thrown);
            expect(Date.now() - started).toBeLessThan(400);
            await Bun.sleep(450);
            expect(attempts).toBe(1);
            expect(errorEvents).toBe(0);
            expect(observed?.listening).toBe(false);
            expect(observed?.address()).toBeNull();
        } finally { spy.mockRestore(); }
    });
    test("binds_after_port_frees", async () => {
        const port = await freePort();
        const holder = await occupy(port);
        cleanup.push(() => (holder.listening ? release(holder) : undefined));

        const listening = track(startListening(buildApp(), port, HOST, { retryMs: 50, limitMs: 5000 }));
        // Still occupied: it keeps trying and has not given up.
        expect(await settlesWithin(listening.ready, 250)).toBe("pending");
        await release(holder);

        const server = await listening.ready;
        expect(server.listening).toBe(true);
        const res = await fetch(`http://${HOST}:${port}/health`);
        expect(res.status).toBe(200);
        expect((await res.json()) as { server: string }).toMatchObject({ server: "termflow-mcp" });
    });

    test("does_not_retry_other_errors", async () => {
        const started = Date.now();
        // Bun reports an unresolvable or unbindable host as EADDRINUSE, so the one host it rejects
        // for another reason is a malformed one.
        const listening = track(startListening(buildApp(), 0, "::notanip", { retryMs: 400, limitMs: 5000 }));
        const outcome = await settlesWithin(listening.ready, 3000);

        expect(outcome).not.toBe("pending");
        const err = (outcome as { error: NodeJS.ErrnoException }).error;
        expect(err).toBeInstanceOf(Error);
        expect(err.code).not.toBe("EADDRINUSE");
        // One attempt only: a retry would have waited out the 400 ms pause first.
        expect(Date.now() - started).toBeLessThan(400);
    });

    test("rejects_when_the_port_stays_occupied_past_the_limit", async () => {
        const port = await freePort();
        const holder = await occupy(port);
        cleanup.push(() => release(holder));

        const started = Date.now();
        const listening = track(startListening(buildApp(), port, HOST, { retryMs: 20, limitMs: 300 }));
        const outcome = await settlesWithin(listening.ready, 3000);

        expect(outcome).not.toBe("pending");
        expect(((outcome as { error: NodeJS.ErrnoException }).error).code).toBe("EADDRINUSE");
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(250);
        expect(elapsed).toBeLessThan(2000);
    });

    test("cancel_before_the_next_attempt_never_binds", async () => {
        const port = await freePort();
        const holder = await occupy(port);
        cleanup.push(() => (holder.listening ? release(holder) : undefined));

        const listening = track(startListening(buildApp(), port, HOST, { retryMs: 300, limitMs: 5000 }));
        await Bun.sleep(100); // the first attempt has failed; the retry timer is pending
        listening.cancel();
        await release(holder);
        await Bun.sleep(600); // well past the retry pause

        expect(await accepts(port)).toBe(false);
        expect(await settlesWithin(listening.ready, 0)).toBe("pending");
    });

    test("cancel_during_inflight_success_never_publishes", async () => {
        const port = await freePort();
        // The port is free, so the first attempt binds at once; cancelling in the same turn means the
        // success lands after `cancel()`.
        const listening = track(startListening(buildApp(), port, HOST, { retryMs: 50, limitMs: 5000 }));
        listening.cancel();

        expect(await settlesWithin(listening.ready, 300)).toBe("pending");
        expect(await accepts(port)).toBe(false);
    });

    test("cancel_is_idempotent", async () => {
        const port = await freePort();
        const listening = track(startListening(buildApp(), port, HOST, { retryMs: 50, limitMs: 5000 }));
        listening.cancel();
        expect(() => listening.cancel()).not.toThrow();
        expect(() => listening.cancel()).not.toThrow();
        expect(await accepts(port)).toBe(false);
    });

    test("cancel_after_ready_leaves_the_server_to_its_owner", async () => {
        const port = await freePort();
        const listening = track(startListening(buildApp(), port, HOST, { retryMs: 50, limitMs: 5000 }));
        const server = await listening.ready;
        listening.cancel();

        expect(server.listening).toBe(true);
        expect((await fetch(`http://${HOST}:${port}/health`)).status).toBe(200);
    });

    test("closeHttpServer_closes_the_server_ready_returned", async () => {
        const port = await freePort();
        const listening = track(startListening(buildApp(), port, HOST, { retryMs: 50, limitMs: 5000 }));
        const server = await listening.ready;
        expect(await accepts(port)).toBe(true);

        await closeHttpServer(server);

        expect(await accepts(port)).toBe(false);
    });
});
