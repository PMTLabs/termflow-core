// A recovery create is provisional only until its first create attempt settles.
// This deliberately tracks event provenance rather than persisted pane metadata:
// `sessionKey` also occurs on ordinary migrated panes.
const provisionalRecoveryLeafIds = new Set<string>();

export function markProvisionalRecovery(leafId: string): void {
  provisionalRecoveryLeafIds.add(leafId);
}

export function takeProvisionalRecovery(leafId: string): boolean {
  return provisionalRecoveryLeafIds.delete(leafId);
}
