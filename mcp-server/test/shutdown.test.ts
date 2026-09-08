import { expect, test } from "bun:test";
import { isShutdownCommand, quiesce } from "../src/shutdown.js";

test("stdin shutdown protocol accepts only the exact private command line", () => {
    expect(isShutdownCommand("TERMFLOW_SHUTDOWN")).toBe(true);
    expect(isShutdownCommand("TERMFLOW_SHUTDOWN ")).toBe(false);
    expect(isShutdownCommand("shutdown")).toBe(false);
});

test("quiesce stops admission before streams, then waits for HTTP completion", async () => {
    const order: string[] = [];
    await quiesce(
        () => order.push("admission"),
        async () => { order.push("transports"); },
        async () => { order.push("http"); },
    );
    expect(order).toEqual(["admission", "transports", "http"]);
});
