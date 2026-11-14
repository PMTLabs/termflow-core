import { expect, it } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpServer, type ApiLike } from "../src/server.js";

it("mcp_execute_command_and_send_keys_surface_locked_refusal", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    let refusal: string | undefined = "InputLocked: private command must not be reflected";
    const api: ApiLike = {
        get: async () => { throw new Error("no GET fallback allowed"); },
        delete: async () => { throw new Error("no delete fallback allowed"); },
        post: async (url, body) => {
            requests.push({ url, body });
            if (refusal) throw Object.assign(new Error("Request failed with status code 423"), {
                response: { status: 423, data: { error: refusal } },
            });
            return { data: { status: "ok" } };
        },
    };
    const server = createMcpServer({ api, getCallerId: () => "pc-locked" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "input-gate-fixture", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
        for (const [name, args, route] of [
            ["execute_command", { terminalId: "me", command: "literal test command" }, "/terminals/pc-locked/execute"],
            ["send_keys", { terminalId: "me", keys: "Enter" }, "/terminals/pc-locked/input"],
        ] as const) {
            refusal = "InputLocked: private command must not be reflected";
            let count = requests.length;
            const locked: any = await client.callTool({ name, arguments: args });
            expect(locked.isError).toBe(true);
            expect(locked.content).toEqual([{ type: "text", text: "Error: InputLocked: SSH launch is preparing" }]);
            expect(requests.length).toBe(count + 1);
            expect(requests.at(-1)?.url).toBe(route);
            refusal = "StaleAttempt: private command must not be reflected";
            const stale: any = await client.callTool({ name, arguments: args });
            expect(stale.isError).toBe(true);
            expect(stale.content).toEqual([{ type: "text", text: "Error: StaleAttempt: terminal input lease expired" }]);
            refusal = undefined;
            count = requests.length;
            const unlocked: any = await client.callTool({ name, arguments: args });
            expect(unlocked.isError).toBeFalsy();
            expect(JSON.parse(unlocked.content[0].text)).toEqual({ status: "ok" });
            expect(requests.length).toBe(count + 1);
        }
    } finally {
        await client.close();
        await server.close();
    }
});
