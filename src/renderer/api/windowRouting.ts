/**
 * P0a — active-window routing for API/MCP-created terminals.
 *
 * The backend BROADCASTS `api:createTerminalTab` to every window (a bare `emit_to`
 * is documented as unreliable in this app) and stamps the routing target into the
 * payload as `targetWindow`. Each window must ignore the event unless it is the
 * target. A missing/empty target means "any window" so events that predate routing
 * (or come from other code paths) still work.
 */
export function shouldHandleForWindow(
  targetWindow: string | undefined | null,
  myLabel: string,
): boolean {
  if (!targetWindow) return true;
  return targetWindow === myLabel;
}
