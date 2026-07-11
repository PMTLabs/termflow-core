import { test, expect } from "bun:test";
import { startSseHeartbeat } from "../src/heartbeat";

function fakeRes(opts: { headersSent: boolean }) {
    const writes: string[] = [];
    const closeHandlers: Array<() => void> = [];
    return {
        headersSent: opts.headersSent,
        writableEnded: false,
        destroyed: false,
        writes,
        write(s: string) {
            writes.push(s);
            return true;
        },
        on(ev: string, cb: () => void) {
            if (ev === "close") closeHandlers.push(cb);
        },
        fireClose() {
            for (const h of closeHandlers) h();
        },
    };
}

test("does not write before headers are sent (header-timing race guard)", async () => {
    const res = fakeRes({ headersSent: false });
    const stop = startSseHeartbeat(res as any, 5);
    await Bun.sleep(25);
    stop();
    expect(res.writes.length).toBe(0);
});

test("writes only the ': ping' SSE comment once headers are sent", async () => {
    const res = fakeRes({ headersSent: true });
    const stop = startSseHeartbeat(res as any, 5);
    await Bun.sleep(25);
    stop();
    expect(res.writes.length).toBeGreaterThan(0);
    expect(res.writes.every((w) => w === ": ping\n\n")).toBe(true);
});

test("stops writing after the response closes", async () => {
    const res = fakeRes({ headersSent: true });
    startSseHeartbeat(res as any, 5);
    res.fireClose();
    const after = res.writes.length;
    await Bun.sleep(25);
    expect(res.writes.length).toBe(after);
});
