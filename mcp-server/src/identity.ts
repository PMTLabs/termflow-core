/** Self-reference sentinel: a terminalId of "me" means the caller's own terminal. */
export const ME_SENTINEL = "me" as const;

/** Header an MCP client forwards (mapped from the TERMFLOW_TERMINAL_ID env var). */
export const TERMINAL_ID_HEADER = "x-termflow-terminal-id";

/**
 * Allowed terminal-id alphabet. Backend ids are the pane leaf (`tm-…`) and this
 * run's process id (`pc-…`); this allowlist accepts every form while rejecting
 * anything that could manipulate a REST path once interpolated (`/`, `..`, `?`,
 * `#`, `%`, whitespace, …).
 */
const SAFE_TERMINAL_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Reject an id from a space that does not name a terminal.
 *
 * Design 014 gave each identity its own prefix, so the prefix IS the type:
 * `tm-` terminal (durable), `pc-` process (this run only), `tb-` tab, `pn-` pane.
 * Before that a renderer-created tab's root leaf WAS its tab id, so `tb-…` was a
 * valid terminal reference for some panes and meaningless for others — an agent
 * in a two-pane tab had no way to say which terminal it meant, and this file
 * carried 25 lines of prose trying to explain the ambiguity instead.
 *
 * Enforced HERE rather than only at the REST layer because this is where the
 * agent reads the error. The REST layer stays deliberately tolerant so a client
 * holding a legacy id still works (design 014 §A3).
 *
 * Rejection is by SHAPE, not by liveness: a tab id that happens to match no live
 * terminal must still be told it is a tab id, or the caller retries the same
 * mistake with no idea why.
 */
export function assertTerminalRef(id: string): void {
    if (id.startsWith("tb-")) {
        throw new Error(
            `${JSON.stringify(id)} is a TAB id, not a terminal. Pass a terminal id ` +
                '("tm-…", from a response\'s `terminalId`) or a process id ("pc-…"). ' +
                "To name a tab — e.g. to open a pane in it — use the `owningTabId` field."
        );
    }
    if (id.startsWith("pn-")) {
        throw new Error(
            `${JSON.stringify(id)} is a PANE id, not a terminal. Pass a terminal id ` +
                '("tm-…", from a response\'s `terminalId`). `paneId` is only for naming ' +
                "which pane to split."
        );
    }
}

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
                '(e.g. "tm-xxxxxxxxx").'
        );
    }
    // Shape check AFTER the alphabet check, so a hostile value is rejected for
    // being hostile rather than for its prefix.
    assertTerminalRef(resolved);
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
