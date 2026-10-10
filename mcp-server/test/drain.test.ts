import { afterEach, describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { bearerMatches, createAuthGate, createDrainMiddleware, DrainState } from "../src/drain.js";

const TOKEN = "tok-5e2a";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const T0 = 1_000_000;

const WAIT = (elapsed: string) =>
    `TermFlow is restarting (${elapsed} ago). Your terminals are still running. Wait about 30 seconds and retry this call. ` +
    "Do not recreate terminals; they will be reattached when TermFlow is back.";

const open: Server[] = [];
afterEach(async () => {
    for (const server of open.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function serve(app: express.Express): Promise<string> {
    const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    open.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The production order: json body, drain, then a sentinel standing in for everything behind them. */
function draining(options: { token?: string; clock?: () => number } = {}) {
    const drain = new DrainState();
    const reached: string[] = [];
    const clock = { now: T0 };
    const app = express();
    app.use(express.json());
    app.use(createDrainMiddleware({ drain, token: options.token ?? TOKEN, now: options.clock ?? (() => clock.now) }));
    app.use((req, res) => {
        reached.push(`${req.method} ${req.path}`);
        res.status(218).json({ sentinel: true });
    });
    return { app, drain, reached, clock };
}

function rpc(body: unknown, headers: Record<string, string> = AUTH, path = "/mcp") {
    return { path, init: { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) } };
}

async function post(base: string, body: unknown, headers?: Record<string, string>, path?: string) {
    const r = rpc(body, headers, path);
    return fetch(`${base}${r.path}`, r.init);
}

const call = (id: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_terminals", arguments: {} } });

describe("DrainState", () => {
    test("begin stops admission and records the first start only", () => {
        const drain = new DrainState();
        expect(drain.accepting).toBe(true);
        expect(drain.startedAt).toBeNull();
        drain.begin(111);
        expect(drain.accepting).toBe(false);
        expect(drain.startedAt).toBe(111);
        drain.begin(222);
        expect(drain.accepting).toBe(false);
        expect(drain.startedAt).toBe(111);
    });
});

describe("bearerMatches", () => {
    test("matches only the exact bearer header", () => {
        expect(bearerMatches("abc", "Bearer abc")).toBe(true);
        expect(bearerMatches("abc", "Bearer abd")).toBe(false);
        expect(bearerMatches("abc", "bearer abc")).toBe(false);
        expect(bearerMatches("abc", "abc")).toBe(false);
        expect(bearerMatches("abc", "")).toBe(false);
        expect(bearerMatches("abc", "Bearer abc ")).toBe(false);
    });
});

describe("createDrainMiddleware while draining", () => {
    test("a tools/call with the right token gets the timed wait, id echoed, isError true", async () => {
        const { app, drain, reached, clock } = draining();
        const base = await serve(app);
        drain.begin(T0);
        clock.now = T0 + 130_000;
        const res = await post(base, call(7));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            jsonrpc: "2.0",
            id: 7,
            result: { content: [{ type: "text", text: WAIT("2m10s") }], isError: true },
        });
        expect(reached).toEqual([]);
    });

    test("id 0 and a string id are echoed with their types", async () => {
        const { app, drain } = draining();
        const base = await serve(app);
        drain.begin(T0);
        const zero = (await (await post(base, call(0))).json()) as { id: unknown };
        expect(zero.id).toBe(0);
        const text = (await (await post(base, call("abc"))).json()) as { id: unknown };
        expect(text.id).toBe("abc");
    });

    test("under a minute the elapsed time is seconds only", async () => {
        const { app, drain, clock } = draining();
        const base = await serve(app);
        drain.begin(T0);
        clock.now = T0 + 45_000;
        const body = (await (await post(base, call(1))).json()) as { result: { content: { text: string }[] } };
        expect(body.result.content[0].text).toBe(WAIT("45s"));
    });

    test("the format pads seconds after a minute", async () => {
        const { app, drain, clock } = draining();
        const base = await serve(app);
        drain.begin(T0);
        clock.now = T0 + 665_000;
        const body = (await (await post(base, call(1))).json()) as { result: { content: { text: string }[] } };
        expect(body.result.content[0].text).toBe(WAIT("11m05s"));
    });

    test("a clock that went backwards reads as 0s", async () => {
        const { app, drain, clock } = draining();
        const base = await serve(app);
        drain.begin(T0);
        clock.now = T0 - 5_000;
        const body = (await (await post(base, call(1))).json()) as { result: { content: { text: string }[] } };
        expect(body.result.content[0].text).toBe(WAIT("0s"));
    });

    test("a wrong or missing token is refused with 401, never the wait", async () => {
        const { app, drain, reached } = draining();
        const base = await serve(app);
        drain.begin(T0);
        const wrong = await post(base, call(1), { authorization: "Bearer nope" });
        expect(wrong.status).toBe(401);
        expect(await wrong.json()).toEqual({ error: "unauthorized" });
        const missing = await post(base, call(1), {});
        expect(missing.status).toBe(401);
        expect(reached).toEqual([]);
    });

    test("open mode (empty token) answers the wait without a header", async () => {
        const { app, drain } = draining({ token: "" });
        const base = await serve(app);
        drain.begin(T0);
        const res = await post(base, call(3), {});
        expect(res.status).toBe(200);
        expect(((await res.json()) as { id: unknown }).id).toBe(3);
    });

    test("everything else keeps the 503", async () => {
        const { app, drain, reached } = draining();
        const base = await serve(app);
        drain.begin(T0);
        const refused = async (res: Response) => {
            expect(res.status).toBe(503);
            expect(await res.json()).toEqual({ error: "MCP server is shutting down" });
        };
        await refused(await post(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
        await refused(await post(base, [call(1), call(2)]));
        await refused(await post(base, { jsonrpc: "2.0", method: "tools/call", params: {} }));
        await refused(await post(base, call(1), AUTH, "/other"));
        await refused(await fetch(`${base}/health`));
        await refused(await fetch(`${base}/mcp`, { method: "GET", headers: AUTH }));
        await refused(await post(base, { jsonrpc: "2.0", id: null, method: "tools/call" }));
        await refused(await post(base, { jsonrpc: "2.0", id: { a: 1 }, method: "tools/call" }));
        expect(reached).toEqual([]);
    });

    test("a draining 503 is also sent to a tools/call with no token configured on other paths", async () => {
        const { app, drain } = draining({ token: "" });
        const base = await serve(app);
        drain.begin(T0);
        expect((await post(base, call(1), {}, "/other")).status).toBe(503);
    });
});

describe("createDrainMiddleware while accepting", () => {
    test("a tools/call reaches the next handler and never gets the wait", async () => {
        const { app, reached } = draining();
        const base = await serve(app);
        const res = await post(base, call(7));
        expect(res.status).toBe(218);
        expect(await res.json()).toEqual({ sentinel: true });
        expect(reached).toEqual(["POST /mcp"]);
    });
});

describe("createAuthGate", () => {
    function gated(token: string) {
        const reached: string[] = [];
        const app = express();
        app.use(createAuthGate(token));
        app.use((req, res) => {
            reached.push(req.path);
            res.status(218).json({ sentinel: true });
        });
        return { app, reached };
    }

    test("the right token reaches the handler; a wrong or missing one gets 401", async () => {
        const { app, reached } = gated(TOKEN);
        const base = await serve(app);
        expect((await fetch(`${base}/mcp`, { headers: AUTH })).status).toBe(218);
        const wrong = await fetch(`${base}/mcp`, { headers: { authorization: "Bearer nope" } });
        expect(wrong.status).toBe(401);
        expect(await wrong.json()).toEqual({ error: "unauthorized" });
        expect((await fetch(`${base}/mcp`)).status).toBe(401);
        expect(reached).toEqual(["/mcp"]);
    });

    test("/health needs no token", async () => {
        const { app, reached } = gated(TOKEN);
        const base = await serve(app);
        expect((await fetch(`${base}/health`)).status).toBe(218);
        expect(reached).toEqual(["/health"]);
    });

    test("an empty configured token lets every request through", async () => {
        const { app, reached } = gated("");
        const base = await serve(app);
        expect((await fetch(`${base}/mcp`)).status).toBe(218);
        expect((await fetch(`${base}/mcp`, { headers: { authorization: "Bearer anything" } })).status).toBe(218);
        expect(reached).toEqual(["/mcp", "/mcp"]);
    });
});
