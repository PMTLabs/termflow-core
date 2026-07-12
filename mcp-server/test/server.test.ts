import { describe, it, expect } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer, type ApiLike } from "../src/server.js";

interface Call {
    method: "get" | "post" | "delete";
    url: string;
    body?: unknown;
}

function makeFakeApi() {
    const calls: Call[] = [];
    const api: ApiLike = {
        get: async (url: string) => {
            calls.push({ method: "get", url });
            return { data: { id: "pc-self", pid: 123, tabId: "tb-1", name: "demo", url, terminals: [] } };
        },
        post: async (url: string, body?: unknown) => {
            calls.push({ method: "post", url, body });
            return { data: { ok: true } };
        },
        delete: async (url: string) => {
            calls.push({ method: "delete", url });
            return { data: { ok: true } };
        },
    };
    return { api, calls };
}

async function connectClient(server: ReturnType<typeof createMcpServer>): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

// Helper: was a given method+url recorded?
function called(calls: Call[], method: Call["method"], url: string): boolean {
    return calls.some((c) => c.method === method && c.url === url);
}

describe("createMcpServer tool wiring", () => {
    it("get_my_terminal proxies GET /terminals/<callerId>", async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        const res: any = await client.callTool({ name: "get_my_terminal", arguments: {} });
        expect(res.isError).toBeFalsy();
        expect(called(calls, "get", "/terminals/pc-self")).toBe(true);
    });

    it('resolves "me" to the caller id in get_terminal_output', async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        const res: any = await client.callTool({ name: "get_terminal_output", arguments: { terminalId: "me", lines: 20, offset: 0 } });
        expect(res.isError).toBeFalsy();
        expect(called(calls, "get", "/terminals/pc-self/output")).toBe(true);
    });

    it('resolves "me" to the caller id in get_terminal_detail', async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        const res: any = await client.callTool({ name: "get_terminal_detail", arguments: { terminalId: "me" } });
        expect(res.isError).toBeFalsy();
        expect(called(calls, "get", "/terminals/pc-self")).toBe(true);
    });

    it("passes an explicit id through untouched even when a caller is present", async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        await client.callTool({ name: "get_terminal_output", arguments: { terminalId: "pc-other", lines: 5, offset: 0 } });
        expect(called(calls, "get", "/terminals/pc-other/output")).toBe(true);
        expect(called(calls, "get", "/terminals/pc-self/output")).toBe(false);
    });

    it('resolves "me" in execute_command and close_terminal', async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        await client.callTool({ name: "execute_command", arguments: { terminalId: "me", command: "ls" } });
        await client.callTool({ name: "close_terminal", arguments: { terminalId: "me" } });
        expect(called(calls, "post", "/terminals/pc-self/execute")).toBe(true);
        expect(called(calls, "delete", "/terminals/pc-self")).toBe(true);
    });

    it('returns an actionable error for "me" when the caller id is unknown', async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => undefined }));
        const res: any = await client.callTool({ name: "get_my_terminal", arguments: {} });
        expect(res.isError).toBe(true);
        expect(res.content[0].text).toMatch(/TERMFLOW_TERMINAL_ID/);
        // No backend call should have been attempted when identity is missing.
        expect(calls.length).toBe(0);
    });

    it("fans out execute_command to the batch endpoint for an array of ids", async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        await client.callTool({ name: "execute_command", arguments: { terminalId: ["pc-a", "pc-b"], command: "ls" } });
        const call = calls.find((c) => c.method === "post" && c.url === "/terminals/batch/execute");
        expect(call).toBeTruthy();
        expect((call!.body as any).terminalIds).toEqual(["pc-a", "pc-b"]);
        expect((call!.body as any).prompt).toBe("ls");
    });

    it("dedups repeated ids in an execute_command array", async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        await client.callTool({ name: "execute_command", arguments: { terminalId: ["pc-a", "pc-a"], command: "ls" } });
        const call = calls.find((c) => c.method === "post" && c.url === "/terminals/batch/execute");
        expect((call!.body as any).terminalIds).toEqual(["pc-a"]);
    });

    it('resolves "me" inside an execute_command array', async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        await client.callTool({ name: "execute_command", arguments: { terminalId: ["me", "pc-b"], command: "ls" } });
        const call = calls.find((c) => c.method === "post" && c.url === "/terminals/batch/execute");
        expect((call!.body as any).terminalIds).toEqual(["pc-self", "pc-b"]);
    });

    it("errors on an empty execute_command array without calling the api", async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        const res: any = await client.callTool({ name: "execute_command", arguments: { terminalId: [], command: "ls" } });
        expect(res.isError).toBe(true);
        expect(calls.some((c) => c.url.includes("batch"))).toBe(false);
    });

    it("reflects a live getCallerId change between calls (per-session refresh)", async () => {
        const { api, calls } = makeFakeApi();
        let caller: string | undefined = undefined;
        const client = await connectClient(createMcpServer({ api, getCallerId: () => caller }));
        const first: any = await client.callTool({ name: "get_my_terminal", arguments: {} });
        expect(first.isError).toBe(true); // anonymous at first
        caller = "pc-late"; // header arrives on a later request
        const second: any = await client.callTool({ name: "get_my_terminal", arguments: {} });
        expect(second.isError).toBeFalsy();
        expect(called(calls, "get", "/terminals/pc-late")).toBe(true);
    });
});

describe("execute_command fleet routing", () => {
    it("routes to /fleet/execute when targetOS is present", async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        await client.callTool({ name: "execute_command", arguments: { targetOS: "linux", command: "uname -a" } });
        const call = calls.find((c) => c.method === "post" && c.url === "/fleet/execute");
        expect(call).toBeTruthy();
        expect((call!.body as any).targetOS).toBe("linux");
        expect((call!.body as any).command).toBe("uname -a");
        expect((call!.body as any).terminalId).toBeUndefined();
        // Must NOT touch the local execute path.
        expect(calls.some((c) => c.url.includes("/execute") && c.url.startsWith("/terminals"))).toBe(false);
    });

    it("routes to /fleet/execute when machineId is present and forwards terminalId + timeoutMs", async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        await client.callTool({
            name: "execute_command",
            arguments: { machineId: "mac-123", terminalId: "pc-remote", command: "ls", timeoutMs: 120000 },
        });
        const call = calls.find((c) => c.method === "post" && c.url === "/fleet/execute");
        expect(call).toBeTruthy();
        expect((call!.body as any).machineId).toBe("mac-123");
        expect((call!.body as any).terminalId).toBe("pc-remote");
        expect((call!.body as any).timeoutMs).toBe(120000);
    });

    it("keeps the local single-terminal path unchanged when no fleet field is set", async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        await client.callTool({ name: "execute_command", arguments: { terminalId: "me", command: "ls" } });
        expect(called(calls, "post", "/terminals/pc-self/execute")).toBe(true);
        expect(calls.some((c) => c.url === "/fleet/execute")).toBe(false);
    });

    it("errors when a fleet call is given an array of terminal ids", async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        const res: any = await client.callTool({
            name: "execute_command",
            arguments: { machineId: "mac-123", terminalId: ["pc-a", "pc-b"], command: "ls" },
        });
        expect(res.isError).toBe(true);
        expect(calls.some((c) => c.url === "/fleet/execute")).toBe(false);
    });
});

describe("list_terminals fleet passthrough", () => {
    it("reads the fleet roster from GET /fleet/terminals", async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        const res: any = await client.callTool({ name: "list_terminals", arguments: {} });
        expect(res.isError).toBeFalsy();
        expect(called(calls, "get", "/fleet/terminals")).toBe(true);
        expect(called(calls, "get", "/terminals")).toBe(false);
    });
});

describe("list_machines tool", () => {
    it("reads the machine roster from GET /fleet/machines", async () => {
        const { api, calls } = makeFakeApi();
        const client = await connectClient(createMcpServer({ api, getCallerId: () => "pc-self" }));
        const res: any = await client.callTool({ name: "list_machines", arguments: {} });
        expect(res.isError).toBeFalsy();
        expect(called(calls, "get", "/fleet/machines")).toBe(true);
    });
});
