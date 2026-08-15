/**
 * Pure grouping step of StateManager.reconcileExistingTerminals, extracted so
 * the correlation key is testable without fetch/localStorage/Redux.
 *
 * The key is the renderer LEAF (`terminalId`), never `tabId` and never
 * `owningTabId`. Two API-created splits in one tab legitimately share an owner;
 * grouping by the owner made them look like duplicates, and the caller closes
 * every candidate but the newest — reaping a live PTY (design 011 §1.1 item 1).
 */
export interface LiveTerminal {
  processId: string;
  createdAt: number;
  promptHook: unknown;
}

export function groupLiveTerminalsByLeaf(
  list: any[],
  wanted: Set<string>,
): Map<string, LiveTerminal[]> {
  const byLeaf = new Map<string, LiveTerminal[]>();
  for (const term of list ?? []) {
    // `terminalId` is the leaf in every response shape (api_server.rs
    // `terminal_identity_json`). `tabId` is a deprecated alias of the same
    // value and is deliberately NOT read here, so a future redefinition of it
    // cannot silently change which PTYs get reaped.
    const leaf: string | undefined = term?.terminalId ?? undefined;
    const processId: string | undefined = term?.id ?? term?.processId;
    if (!leaf || !processId || !wanted.has(leaf)) continue;
    const arr = byLeaf.get(leaf) ?? [];
    arr.push({
      processId,
      createdAt: Date.parse(term?.createdAt ?? '') || 0,
      promptHook: term?.promptHook,
    });
    byLeaf.set(leaf, arr);
  }
  // Newest first — the caller reattaches to [0] and reaps the rest.
  for (const arr of byLeaf.values()) arr.sort((a, b) => b.createdAt - a.createdAt);
  return byLeaf;
}
