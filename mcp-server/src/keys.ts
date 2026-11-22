/**
 * Named keystroke mappings to raw terminal bytes or escape sequences.
 * Case-insensitive lookup (values trimmed and lowercased).
 */
const NAMED_KEYS: Record<string, string> = {
    enter: "\r",
    return: "\r",
    cr: "\r",
    lf: "\n",
    newline: "\n",
    tab: "\t",
    space: " ",
    esc: "\x1b",
    escape: "\x1b",
    backspace: "\x7f",
    delete: "\x1b[3~",
    del: "\x1b[3~",
    up: "\x1b[A",
    arrowup: "\x1b[A",
    uparrow: "\x1b[A",
    down: "\x1b[B",
    arrowdown: "\x1b[B",
    downarrow: "\x1b[B",
    right: "\x1b[C",
    arrowright: "\x1b[C",
    rightarrow: "\x1b[C",
    left: "\x1b[D",
    arrowleft: "\x1b[D",
    leftarrow: "\x1b[D",
    home: "\x1b[H",
    end: "\x1b[F",
    pageup: "\x1b[5~",
    pgup: "\x1b[5~",
    pagedown: "\x1b[6~",
    pgdn: "\x1b[6~",
};

/**
 * Decodes C-style, hex, unicode, and control escape sequences in a string:
 * - \uXXXX (4 hex digits)
 * - \u{X...} (variable hex digits)
 * - \xXX (2 hex digits)
 * - \c<char> (control character, e.g. \cU = 0x15)
 * - \<octal> (1-3 octal digits)
 * - \r, \n, \t, \b, \f, \v, \a, \e, \0, \\
 */
export function decodeEscapeSequences(str: string): string {
    return str.replace(
        /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|c([a-zA-Z@\[\\\]^_?])|([0-7]{1,3})|([\\bfnrtvaer0]))/g,
        (match, uCodePoint, uHex, xHex, ctrlChar, octal, single) => {
            if (uCodePoint !== undefined) {
                return String.fromCodePoint(parseInt(uCodePoint, 16));
            }
            if (uHex !== undefined) {
                return String.fromCharCode(parseInt(uHex, 16));
            }
            if (xHex !== undefined) {
                return String.fromCharCode(parseInt(xHex, 16));
            }
            if (ctrlChar !== undefined) {
                if (ctrlChar === "?") return "\x7f";
                return String.fromCharCode(ctrlChar.toUpperCase().charCodeAt(0) & 0x1f);
            }
            if (octal !== undefined) {
                return String.fromCharCode(parseInt(octal, 8));
            }
            if (single !== undefined) {
                switch (single) {
                    case "r":
                        return "\r";
                    case "n":
                        return "\n";
                    case "t":
                        return "\t";
                    case "b":
                        return "\b";
                    case "f":
                        return "\f";
                    case "v":
                        return "\v";
                    case "a":
                        return "\x07";
                    case "e":
                        return "\x1b";
                    case "0":
                        return "\0";
                    case "\\":
                        return "\\";
                    default:
                        return match;
                }
            }
            return match;
        }
    );
}

/**
 * Parses user/agent input for `send_keys`.
 *
 * Supports:
 * - Empty check: throws if empty so callers (agents/LLMs) are alerted when
 *   transports or APIs strip raw control characters.
 * - Named keys: "Enter", "Return", "Esc", "Tab", "Backspace", "Up", "Down", etc.
 * - Ctrl combinations: "Ctrl+U", "ctrl-u", "<ctrl+u>", "C-u", "Ctrl+C", etc.
 * - Caret notation: "^U", "^C", "^[", etc.
 * - Escape sequences: "\u0015", "\x15", "\r", "\n", "\e[A", "\u001b[A", etc.
 * - Raw bytes/characters pass through untouched.
 */
export function parseKeys(keys: string): string {
    if (typeof keys !== "string" || keys.length === 0) {
        throw new Error(
            '"keys" must not be empty. If trying to send a control character (e.g. Ctrl+U, Ctrl+C, Esc), pass it as an escape sequence such as "\\u0015", "\\x15", "^U", or "Ctrl+U" rather than a raw control character, which is stripped by JSON transports.'
        );
    }

    const trimmed = keys.trim();

    if (trimmed.length > 0) {
        // 1. Check named keys (case-insensitive full match)
        const lower = trimmed.toLowerCase();
        if (NAMED_KEYS[lower] !== undefined) {
            return NAMED_KEYS[lower];
        }

        // 2. Check full-string Ctrl combo: Ctrl+U, ctrl-c, <ctrl+u>, C-u, etc.
        const ctrlMatch = trimmed.match(/^<?(?:ctrl|c)[+-]([a-z@\[\\\]^_?])>?$/i);
        if (ctrlMatch) {
            const ch = ctrlMatch[1];
            if (ch === "?") return "\x7f";
            return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
        }

        // 3. Check full-string caret notation: ^U, ^C, ^[, etc.
        const caretMatch = trimmed.match(/^\^([a-z@\[\\\]^_?])$/i);
        if (caretMatch) {
            const ch = caretMatch[1];
            if (ch === "?") return "\x7f";
            return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
        }
    }

    // 4. Decode escape sequences throughout the string
    return decodeEscapeSequences(keys);
}
