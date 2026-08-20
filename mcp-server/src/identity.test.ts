import { describe, expect, it } from "bun:test";
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
