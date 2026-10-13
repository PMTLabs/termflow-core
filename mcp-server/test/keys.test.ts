import { describe, expect, it } from "bun:test";
import { decodeEscapeSequences, parseKeys } from "../src/keys.js";

describe("parseKeys", () => {
    it("throws an actionable error on empty string", () => {
        expect(() => parseKeys("")).toThrow('"keys" must not be empty');
    });

    it("decodes unicode escape sequences (e.g. \\u0015 for Ctrl+U, \\u0003 for Ctrl+C)", () => {
        const ctrlU = parseKeys("\\u0015");
        expect(ctrlU).toBe("\x15");
        expect(ctrlU.charCodeAt(0)).toBe(0x15);

        const ctrlC = parseKeys("\\u0003");
        expect(ctrlC).toBe("\x03");
        expect(ctrlC.charCodeAt(0)).toBe(0x03);

        const esc = parseKeys("\\u001b");
        expect(esc).toBe("\x1b");
        expect(esc.charCodeAt(0)).toBe(0x1b);
    });

    it("decodes unicode code point escapes (e.g. \\u{15})", () => {
        const ctrlU = parseKeys("\\u{15}");
        expect(ctrlU).toBe("\x15");
        expect(ctrlU.charCodeAt(0)).toBe(0x15);
    });

    it("decodes hex escape sequences (e.g. \\x15, \\x1b)", () => {
        const ctrlU = parseKeys("\\x15");
        expect(ctrlU).toBe("\x15");
        expect(ctrlU.charCodeAt(0)).toBe(0x15);

        const esc = parseKeys("\\x1b");
        expect(esc).toBe("\x1b");
        expect(esc.charCodeAt(0)).toBe(0x1b);
    });

    it("decodes C-style escapes (\\r, \\n, \\t, \\b, \\e, \\\\)", () => {
        expect(parseKeys("\\r")).toBe("\r");
        expect(parseKeys("\\n")).toBe("\n");
        expect(parseKeys("\\t")).toBe("\t");
        expect(parseKeys("\\b")).toBe("\b");
        expect(parseKeys("\\e")).toBe("\x1b");
        expect(parseKeys("\\\\")).toBe("\\");
    });

    it("decodes cursor arrows with escape prefixes (\\u001b[A, \\x1b[B, \\e[A)", () => {
        expect(parseKeys("\\u001b[A")).toBe("\x1b[A");
        expect(parseKeys("\\x1b[B")).toBe("\x1b[B");
        expect(parseKeys("\\e[A")).toBe("\x1b[A");
    });

    it("decodes named keys (case-insensitive)", () => {
        expect(parseKeys("Enter")).toBe("\r");
        expect(parseKeys("enter")).toBe("\r");
        expect(parseKeys("Return")).toBe("\r");
        expect(parseKeys("Esc")).toBe("\x1b");
        expect(parseKeys("escape")).toBe("\x1b");
        expect(parseKeys("Tab")).toBe("\t");
        expect(parseKeys("Backspace")).toBe("\x7f");
        expect(parseKeys("Up")).toBe("\x1b[A");
        expect(parseKeys("Down")).toBe("\x1b[B");
        expect(parseKeys("Right")).toBe("\x1b[C");
        expect(parseKeys("Left")).toBe("\x1b[D");
        expect(parseKeys("Space")).toBe(" ");
    });

    it("decodes Ctrl combinations (Ctrl+U, ctrl-c, <ctrl+u>, C-u)", () => {
        expect(parseKeys("Ctrl+U")).toBe("\x15");
        expect(parseKeys("ctrl+u")).toBe("\x15");
        expect(parseKeys("Ctrl-U")).toBe("\x15");
        expect(parseKeys("ctrl-u")).toBe("\x15");
        expect(parseKeys("<ctrl+u>")).toBe("\x15");
        expect(parseKeys("C-u")).toBe("\x15");

        expect(parseKeys("Ctrl+C")).toBe("\x03");
        expect(parseKeys("ctrl+c")).toBe("\x03");
        expect(parseKeys("Ctrl+D")).toBe("\x04");
        expect(parseKeys("Ctrl+Z")).toBe("\x1a");
    });

    it("decodes caret notation (^U, ^C, ^[)", () => {
        expect(parseKeys("^U")).toBe("\x15");
        expect(parseKeys("^u")).toBe("\x15");
        expect(parseKeys("^C")).toBe("\x03");
        expect(parseKeys("^c")).toBe("\x03");
        expect(parseKeys("^D")).toBe("\x04");
        expect(parseKeys("^[")).toBe("\x1b");
        expect(parseKeys("^?")).toBe("\x7f");
    });

    it("decodes \\c control escape sequences (\\cU, \\cC)", () => {
        expect(parseKeys("\\cU")).toBe("\x15");
        expect(parseKeys("\\cu")).toBe("\x15");
        expect(parseKeys("\\cC")).toBe("\x03");
    });

    it("preserves raw bytes and unescaped characters verbatim", () => {
        expect(parseKeys("\r")).toBe("\r");
        expect(parseKeys("\n")).toBe("\n");
        expect(parseKeys("\x15")).toBe("\x15");
        expect(parseKeys("\x1b")).toBe("\x1b");
        expect(parseKeys(" ")).toBe(" ");
    });

    it("decodes composite text with escapes (e.g. y\\r, :q!\\r)", () => {
        expect(parseKeys("y\\r")).toBe("y\r");
        expect(parseKeys(":q!\\r")).toBe(":q!\r");
        expect(parseKeys("hello\\nworld")).toBe("hello\nworld");
    });
});
