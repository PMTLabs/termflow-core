export const ADMIN_UAC_CANCELLED = 'ADMIN_UAC_CANCELLED';

/**
 * True when `error` is the backend's UAC-deny sentinel (plan 045 AC6): the
 * user declining the elevation prompt is a normal choice, not a failure.
 */
export function isAdminUacCancelled(error: unknown): boolean {
  return error instanceof Error
    ? error.message === ADMIN_UAC_CANCELLED
    : typeof error === 'string' && error === ADMIN_UAC_CANCELLED;
}
