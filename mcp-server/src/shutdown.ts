import type { Server } from "node:http";

/**
 * Private parent-to-child stdin protocol: one exact `TERMFLOW_SHUTDOWN\\n` line
 * requests shutdown. It deliberately has no HTTP/MCP equivalent.
 */
export const SHUTDOWN_COMMAND = "TERMFLOW_SHUTDOWN";

// Keep the total sidecar drain under 1.5 s, leaving the desktop's 2 s wait
// enough room for stdin delivery and scheduling on a busy machine.
export const TRANSPORT_DRAIN_TIMEOUT_MS = 750;
export const HTTP_CLOSE_TIMEOUT_MS = 750;

export function isShutdownCommand(line: string): boolean {
    return line === SHUTDOWN_COMMAND;
}

export async function withinBound<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    return Promise.race([
        work,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
}

export function closeHttpServer(server: Server | undefined): Promise<void> {
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
        try {
            server.close(() => resolve());
        } catch {
            resolve();
        }
    });
}

export async function quiesce(
    stopAdmitting: () => void,
    closeTransports: () => Promise<void>,
    closeServer: () => Promise<void>,
): Promise<void> {
    // This order matters: no new initialize can enter after the gate falls;
    // existing streams are then closed before the listener is allowed to finish.
    stopAdmitting();
    await withinBound(closeTransports(), TRANSPORT_DRAIN_TIMEOUT_MS);
    await withinBound(closeServer(), HTTP_CLOSE_TIMEOUT_MS);
}
