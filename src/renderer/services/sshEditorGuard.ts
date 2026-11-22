/** Registry for the SSH draft owner. Settings remains the single tab guard. */
export interface SshEditorGuard { isDirty(): boolean; save(): Promise<boolean>; discard(): void }
let guard: SshEditorGuard | null = null;
export function registerSshEditorGuard(next: SshEditorGuard): () => void {
  guard = next;
  return () => { if (guard === next) guard = null; };
}
export function isSshEditorDirty(): boolean { return guard?.isDirty() ?? false; }
export function saveSshEditorDraft(): Promise<boolean> { return guard ? guard.save().catch(() => false) : Promise.resolve(true); }
export function discardSshEditorDraft(): void { guard?.discard(); }
