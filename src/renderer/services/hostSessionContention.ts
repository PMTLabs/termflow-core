const HOST_SESSION_CONTENDED = 'host-session-contended';

/** True when an error has the backend's host-session-contention wire prefix. */
export function isHostSessionContended(error: unknown): boolean {
  return error instanceof Error
    ? error.message.startsWith(`${HOST_SESSION_CONTENDED}: `)
    : typeof error === 'string' && error.startsWith(`${HOST_SESSION_CONTENDED}: `);
}
