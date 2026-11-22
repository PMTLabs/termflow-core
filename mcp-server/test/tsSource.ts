/**
 * A small source scanner for wiring censuses over TypeScript text: mask comments and
 * literals (offsets preserved), match brackets, split arguments, normalise statements.
 * It reads the real file text, so a census built on it can be checked against planted
 * mutations of that text.
 */

const REGEX_PRECEDERS = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

function blank(source: string, from: number, to: number, out: string[]): void {
    for (let i = from; i < to; i++) if (source[i] !== "\n" && source[i] !== "\r") out[i] = " ";
}

/** End (exclusive) of the template literal that starts at `start` (a backtick), nested `${}` included. */
function templateEnd(source: string, start: number): number {
    let i = start + 1;
    while (i < source.length) {
        const c = source[i];
        if (c === "\\") i += 2;
        else if (c === "`") return i + 1;
        else if (c === "$" && source[i + 1] === "{") i = braceEnd(source, i + 1);
        else i++;
    }
    return source.length;
}

/** End (exclusive) of the `{ ... }` that starts at `start`, skipping strings, templates and comments inside. */
function braceEnd(source: string, start: number): number {
    let depth = 0;
    let i = start;
    while (i < source.length) {
        const c = source[i];
        if (c === "'" || c === '"') {
            i++;
            while (i < source.length && source[i] !== c) i += source[i] === "\\" ? 2 : 1;
            i++;
        } else if (c === "`") i = templateEnd(source, i);
        else if (c === "/" && source[i + 1] === "/") {
            while (i < source.length && source[i] !== "\n") i++;
        } else if (c === "/" && source[i + 1] === "*") {
            const close = source.indexOf("*/", i + 2);
            i = close < 0 ? source.length : close + 2;
        } else {
            if (c === "{") depth++;
            if (c === "}") {
                depth--;
                if (depth === 0) return i + 1;
            }
            i++;
        }
    }
    return source.length;
}

/** The source with comments, string/template/regex literals replaced by spaces. Offsets are preserved. */
export function mask(source: string): string {
    const out = source.split("");
    let i = 0;
    let previous = "";
    while (i < source.length) {
        const c = source[i];
        if (c === "/" && source[i + 1] === "/") {
            let end = i;
            while (end < source.length && source[end] !== "\n") end++;
            blank(source, i, end, out);
            i = end;
        } else if (c === "/" && source[i + 1] === "*") {
            const close = source.indexOf("*/", i + 2);
            const end = close < 0 ? source.length : close + 2;
            blank(source, i, end, out);
            i = end;
        } else if (c === "'" || c === '"') {
            let end = i + 1;
            while (end < source.length && source[end] !== c) end += source[end] === "\\" ? 2 : 1;
            end++;
            blank(source, i, end, out);
            i = end;
            previous = "x";
        } else if (c === "`") {
            const end = templateEnd(source, i);
            blank(source, i, end, out);
            i = end;
            previous = "x";
        } else if (c === "/" && REGEX_PRECEDERS.has(previous)) {
            let end = i + 1;
            let inClass = false;
            while (end < source.length && source[end] !== "\n") {
                const d = source[end];
                if (d === "\\") end += 2;
                else {
                    if (d === "[") inClass = true;
                    else if (d === "]") inClass = false;
                    else if (d === "/" && !inClass) break;
                    end++;
                }
            }
            end++;
            while (end < source.length && /[a-z]/.test(source[end])) end++;
            blank(source, i, end, out);
            i = end;
            previous = "x";
        } else {
            if (!/\s/.test(c)) previous = c;
            i++;
        }
    }
    return out.join("");
}

/** Index just past the bracket that closes the one at `open` (in already-masked text). */
export function closeOf(masked: string, open: number): number {
    const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
    const opener = masked[open];
    const closer = pairs[opener];
    if (!closer) throw new Error(`no bracket at ${open}`);
    let depth = 0;
    for (let i = open; i < masked.length; i++) {
        if (masked[i] === opener) depth++;
        else if (masked[i] === closer) {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    throw new Error(`unclosed ${opener} at ${open}`);
}

/** Whitespace-stripped text, so formatting changes do not matter but token changes do. */
export function norm(text: string): string {
    return text.replace(/\s+/g, "");
}

/** Brace depth of every offset in masked text (the depth the character sits at, before an opener counts). */
export function depthAt(masked: string, offset: number): number {
    let depth = 0;
    for (let i = 0; i < offset; i++) {
        if (masked[i] === "{" || masked[i] === "(" || masked[i] === "[") depth++;
        else if (masked[i] === "}" || masked[i] === ")" || masked[i] === "]") depth--;
    }
    return depth;
}

/** Offsets of every occurrence of `needle` in `masked` that is not part of a longer identifier. */
export function occurrences(masked: string, needle: string): number[] {
    const hits: number[] = [];
    const wordy = /\w$/.test(needle);
    let from = 0;
    for (;;) {
        const at = masked.indexOf(needle, from);
        if (at < 0) return hits;
        const before = masked[at - 1] ?? "";
        const after = masked[at + needle.length] ?? "";
        if (!(/[\w$.]/.test(before) && /\w/.test(needle[0])) && !(wordy && /\w/.test(after))) hits.push(at);
        from = at + needle.length;
    }
}

/** The text of the call whose `(` is at `open`, split into its top-level arguments (original text). */
export function callArguments(original: string, masked: string, open: number): string[] {
    const end = closeOf(masked, open);
    const args: string[] = [];
    let depth = 0;
    let start = open + 1;
    for (let i = open + 1; i < end - 1; i++) {
        const c = masked[i];
        if (c === "(" || c === "{" || c === "[") depth++;
        else if (c === ")" || c === "}" || c === "]") depth--;
        else if (c === "," && depth === 0) {
            args.push(original.slice(start, i));
            start = i + 1;
        }
    }
    const last = original.slice(start, end - 1);
    if (last.trim() !== "") args.push(last); // a trailing comma adds no argument
    return args;
}

/** Apply a planted mutation to real text; the target must exist exactly once. */
export function mutate(source: string, from: string, to: string): string {
    const first = source.indexOf(from);
    if (first < 0 || source.indexOf(from, first + 1) >= 0) {
        throw new Error(`mutation target must occur exactly once: ${from.slice(0, 60)}`);
    }
    return source.slice(0, first) + to + source.slice(first + from.length);
}
