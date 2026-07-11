/** Self-reference sentinel: a terminalId of "me" means the caller's own terminal. */
export const ME_SENTINEL = "me" as const;

/** Header an MCP client forwards (mapped from the TERMFLOW_TERMINAL_ID env var). */
export const TERMINAL_ID_HEADER = "x-termflow-terminal-id";

/**
 * Allowed terminal-id alphabet. Backend ids are `pc-<hex>` (and tab ids `tb-…`);
 * this allowlist accepts those while rejecting anything that could manipulate a
 * REST path once interpolated (`/`, `..`, `?`, `#`, `%`, whitespace, …).
 */
const SAFE_TERMINAL_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Resolve a tool's terminalId argument. "me" resolves to the caller's own
 * terminal (captured from the request header). A concrete id passes through,
 * so explicitly passing $TERMFLOW_TERMINAL_ID always works even for clients
 * that don't forward the header.
 *
 * The resolved id is then validated against SAFE_TERMINAL_ID before any tool
 * splices it into a backend URL. This is defense-in-depth, NOT a trust boundary
 * — an authenticated client can already target any terminal by its explicit id;
 * the check only prevents a malformed/hostile value from rewriting the path.
 */
export function resolveTerminalId(input: string, callerId: string | undefined): string {
    let resolved: string;
    if (input === ME_SENTINEL) {
        if (!callerId) {
            throw new Error(
                'Cannot resolve "me": this terminal\'s identity was not received. Your MCP ' +
                    "client may not forward the X-Termflow-Terminal-Id header. Read " +
                    "$TERMFLOW_TERMINAL_ID from your shell and pass it as an explicit terminalId."
            );
        }
        resolved = callerId;
    } else {
        resolved = input;
    }
    if (!SAFE_TERMINAL_ID.test(resolved)) {
        throw new Error(
            `Invalid terminalId ${JSON.stringify(resolved)}: expected only [A-Za-z0-9_-] ` +
                '(e.g. "pc-xxxxxxxxx").'
        );
    }
    return resolved;
}

/** Read the caller's terminal id from request headers (Express lowercases keys). */
export function readTerminalIdHeader(
    headers: Record<string, string | string[] | undefined>
): string | undefined {
    const raw = headers[TERMINAL_ID_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
