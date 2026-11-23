export const SSH_BROWSER_DEFAULT_WIDTH = 260;
export const SSH_BROWSER_MIN_WIDTH = 200;
export const SSH_BROWSER_MAX_WIDTH = 600;
export const SSH_BROWSER_MAX_FRACTION = 0.4;

export function clampSshBrowserWidth(width: number): number {
  return Math.min(SSH_BROWSER_MAX_WIDTH, Math.max(SSH_BROWSER_MIN_WIDTH, width));
}
