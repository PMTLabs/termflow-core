import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertTerminalRef, resolveTerminalId } from "./identity";

/**
 * Design 014 §A3 — each identity owns one prefix, so the prefix IS the type.
 *
 * Enforced here, at the MCP layer, because this is where the agent that made the
 * mistake reads the error. The REST layer stays deliberately tolerant so a
 * client holding a legacy id still works.
 */
describe("assertTerminalRef", () => {
    it("accepts a terminal id", () => {
        expect(() => assertTerminalRef("tm-9f2c1a4b7")).not.toThrow();
    });

    it("accepts a process id", () => {
        expect(() => assertTerminalRef("pc-abc123def")).not.toThrow();
    });

    // THE reported failure: an agent in a two-pane tab holding a tb- id had no
    // way to say which of the two terminals it meant. Before 014 this could not
    // even be detected, because a tab's root leaf WAS its tab id.
    it("rejects a tab id and names the field to use instead", () => {
        expect(() => assertTerminalRef("tb-4e8d0c2f1")).toThrow(/TAB id/);
        expect(() => assertTerminalRef("tb-4e8d0c2f1")).toThrow(/owningTabId/);
    });

    it("rejects a pane id and names the field to use instead", () => {
        expect(() => assertTerminalRef("pn-4k2j9x1qa")).toThrow(/PANE id/);
        expect(() => assertTerminalRef("pn-4k2j9x1qa")).toThrow(/paneId/);
    });

    // Rejection is by SHAPE, not liveness — otherwise a caller passing a tab id
    // that matches nothing learns only "not found" and retries the same mistake.
    it("rejects a tab id even when it could never match anything", () => {
        expect(() => assertTerminalRef("tb-doesnotexist")).toThrow(/TAB id/);
    });

    // An id minted before the prefixes existed must still pass, or clients
    // holding older ids break.
    it("accepts an unprefixed legacy id", () => {
        expect(() => assertTerminalRef("legacy-id-0001")).not.toThrow();
    });

    it("does not reject ids that merely start similarly", () => {
        for (const id of ["tbx-0000", "pnx-0000", "tmx-0000"]) {
            expect(() => assertTerminalRef(id)).not.toThrow();
        }
    });
});

describe("resolveTerminalId enforces the id space", () => {
    it("passes a terminal id through", () => {
        expect(resolveTerminalId("tm-9f2c1a4b7", undefined)).toBe("tm-9f2c1a4b7");
    });

    it("rejects a tab id passed as a terminal", () => {
        expect(() => resolveTerminalId("tb-4e8d0c2f1", undefined)).toThrow(/TAB id/);
    });

    // "me" resolves from the header, which carries TERMFLOW_TERMINAL_ID. That
    // variable used to hold a TAB id (verified live: tb-oxz741k0q), so this is
    // exactly where an agent running under a pre-014 build surfaces — it must
    // fail loudly rather than silently address the wrong terminal.
    it("rejects a tab id arriving via the me sentinel", () => {
        expect(() => resolveTerminalId("me", "tb-oxz741k0q")).toThrow(/TAB id/);
    });

    it("resolves me to a terminal id from the header", () => {
        expect(resolveTerminalId("me", "tm-9f2c1a4b7")).toBe("tm-9f2c1a4b7");
    });

    it("still rejects a path-manipulating value for being hostile, not for its prefix", () => {
        expect(() => resolveTerminalId("../../etc/passwd", undefined)).toThrow(/expected only/);
    });
});

/**
 * Every tool that accepts a `terminalId` must run it through `resolveTerminalId`.
 *
 * `get_terminal_screen` did not: it passed the raw argument to `/fleet/screen`, so the
 * `"me"` sentinel was sent literally, the alphabet check never ran, and a `tb-`/`pn-` id
 * came back as a bare not-found instead of the message naming the right field. Ten tools
 * were correct and one was not, which is precisely the shape a per-call-site gate has —
 * so this asserts the RULE over the whole file rather than adding an eleventh example.
 *
 * Review 170, finding 5.
 */
describe("no MCP tool addresses a terminal without resolving the id", () => {
    const SRC = readFileSync(join(import.meta.dir, "server.ts"), "utf8").replace(/\r\n/g, "\n");

    /** Each `server.registerTool("name", …)` block, sliced to the next registration. */
    function toolBlocks(): Array<{ name: string; body: string }> {
        const starts = [...SRC.matchAll(/server\.registerTool\(\s*\n?\s*"([a-z_]+)"/g)];
        return starts.map((m, i) => ({
            name: m[1],
            body: SRC.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : SRC.length),
        }));
    }

    it("found the tool registrations it is reading", () => {
        // Or every assertion below passes vacuously.
        expect(toolBlocks().length).toBeGreaterThanOrEqual(10);
    });

    it("resolves terminalId in every tool that declares one", () => {
        const offenders = toolBlocks()
            .filter((t) => /terminalId: z\./.test(t.body))
            .filter((t) => !/resolveTerminalId\(/.test(t.body))
            .map((t) => t.name);
        expect(offenders).toEqual([]);
    });

    /**
     * ...and the RESOLVED value is the one forwarded.
     *
     * The test above only proves the call is present. A tool that resolves and then
     * forwards the raw argument anyway passes it — verified by mutation, which is how
     * this second assertion came to exist. After the resolve, the raw `terminalId` may
     * appear only as a property KEY (`terminalId: id`); any bare use means the
     * unresolved value is still reaching the backend.
     */
    it("never forwards the RAW argument to the backend", () => {
        // Two precise shapes, because a loose "is `terminalId` mentioned after the
        // resolve" rule false-positives on execute_command, which legitimately
        // re-reads the argument to choose between its fleet / array / single
        // branches (and resolves on all three).
        //   - a payload shorthand line `terminalId,`  -> the raw value as a property
        //   - `${terminalId}` in a template path      -> the raw value in the URL
        const offenders = toolBlocks()
            .filter((t) => /terminalId: z\./.test(t.body))
            .filter((t) => /^\s*terminalId,\s*$/m.test(t.body) || t.body.includes("${terminalId}"))
            .map((t) => t.name);
        expect(offenders).toEqual([]);
    });
});
