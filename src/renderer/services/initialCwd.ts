// Transient hand-off of an inherited CWD from a pane split to the new pane's
// FIRST spawn. Keyed by the NEW terminalId. Deliberately NOT stored in the pane
// tree or detach payloads (those must stay free of spawn-only data — see design
// §3.2 / risks): it is consumed exactly once when TerminalPane mounts.
const pending = new Map<string, string>();

export function setInitialCwd(terminalId: string, cwd: string): void {
  pending.set(terminalId, cwd);
}

/** Get-and-remove the inherited cwd for a terminal (undefined if none). */
export function takeInitialCwd(terminalId: string): string | undefined {
  const cwd = pending.get(terminalId);
  if (cwd !== undefined) pending.delete(terminalId);
  return cwd;
}
