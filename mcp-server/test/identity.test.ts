import { describe, it, expect } from "bun:test";
import { resolveTerminalId, readTerminalIdHeader, ME_SENTINEL } from "../src/identity.js";

describe("resolveTerminalId", () => {
    it("returns the caller id when input is 'me'", () => {
        expect(resolveTerminalId("me", "pc-abc123def")).toBe("pc-abc123def");
    });
    it("passes through a concrete id unchanged (even without a caller)", () => {
        expect(resolveTerminalId("pc-xyz", undefined)).toBe("pc-xyz");
    });
    it("passes a concrete id through even when a caller is present", () => {
        expect(resolveTerminalId("pc-other", "pc-self")).toBe("pc-other");
    });
    it("throws an actionable error for 'me' with no caller id", () => {
        expect(() => resolveTerminalId("me", undefined)).toThrow(/TERMFLOW_TERMINAL_ID/);
    });
    it("exposes the sentinel value", () => {
        expect(ME_SENTINEL).toBe("me");
    });
    it("rejects an explicit id with path/query characters", () => {
        expect(() => resolveTerminalId("../etc", undefined)).toThrow(/Invalid terminalId/);
        expect(() => resolveTerminalId("a/b", undefined)).toThrow(/Invalid terminalId/);
        expect(() => resolveTerminalId("pc-1?x=2", undefined)).toThrow(/Invalid terminalId/);
        expect(() => resolveTerminalId("pc 1", undefined)).toThrow(/Invalid terminalId/);
    });
    it("rejects a hostile caller id resolved from 'me'", () => {
        expect(() => resolveTerminalId("me", "pc-../secret")).toThrow(/Invalid terminalId/);
    });
});

describe("readTerminalIdHeader", () => {
    it("reads the lowercased header", () => {
        expect(readTerminalIdHeader({ "x-termflow-terminal-id": "pc-1" })).toBe("pc-1");
    });
    it("normalizes an array to its first element", () => {
        expect(readTerminalIdHeader({ "x-termflow-terminal-id": ["pc-1", "pc-2"] })).toBe("pc-1");
    });
    it("returns undefined when absent", () => {
        expect(readTerminalIdHeader({})).toBeUndefined();
    });
    it("returns undefined when blank/whitespace", () => {
        expect(readTerminalIdHeader({ "x-termflow-terminal-id": "   " })).toBeUndefined();
    });
});
