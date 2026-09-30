/** Retryable create refusals, identified only by the backend's wire prefix. */
export function isHostOwnershipPending(error: unknown): boolean {
  const message = error instanceof Error ? error.message : error;
  return typeof message === 'string' && message.startsWith('host-ownership-pending:');
}

export function isLifecycleBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : error;
  return typeof message === 'string' && message.startsWith('LIFECYCLE_BUSY');
}
