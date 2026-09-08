const HOST_SESSION_CONTENDED = 'host-session-contended';

/** True when this recovery pane lost registration to another recovered pane. */
export function isHostSessionContended(error: unknown): boolean {
  return error instanceof Error
    ? error.message.includes(HOST_SESSION_CONTENDED)
    : typeof error === 'string' && error.includes(HOST_SESSION_CONTENDED);
}
