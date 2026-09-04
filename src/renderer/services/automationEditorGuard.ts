/**
 * The unsaved-automation-draft guard (plan 028 §5.2) — the cross-area blocker **two independent
 * verifiers found from different directions**, which is the whole reason the boundary audit exists.
 *
 * Automations is excluded from the settings dirty tracker on purpose: `settingsDirty.ts` snapshots a
 * subset of the settings **Redux slice** and undoes by re-dispatching settings setters, and
 * automation rules live in SQLite and have neither. But being excluded means `requestCategoryChange`
 * saw nothing dirty, so clicking any other sidebar category while the editor held an unsaved draft
 * **silently discarded it**. Not a shortcut, not an edge case — one ordinary click. The tray
 * deep-link and closing the Settings tab had the same effect.
 *
 * So the editor answers for itself, through this registry. Module-level rather than a prop chain
 * because the two ends are a leaf component and the page's navigation callbacks, which is exactly
 * the shape `settingsNavGuard.ts` already solves for the tab layer.
 *
 * **Nothing registers a guard until the editor exists (M5).** Until then `isAutomationEditorDirty()`
 * is false and every navigation proceeds as it always did — the hook-up is inert, not absent, and
 * its own test registers a fake guard so the wiring is proved before its only real caller is
 * written.
 */
export interface AutomationEditorGuard {
    /** Is there an unsaved draft right now? */
    isDirty(): boolean;
    /** Persist the draft. The navigation the user asked for follows. */
    save(): void;
    /** Throw the draft away. The navigation follows. */
    discard(): void;
}

let guard: AutomationEditorGuard | null = null;

export function registerAutomationEditorGuard(g: AutomationEditorGuard): void {
    guard = g;
}

export function clearAutomationEditorGuard(): void {
    guard = null;
}

export function isAutomationEditorDirty(): boolean {
    return guard?.isDirty() ?? false;
}

export function saveAutomationEditorDraft(): void {
    guard?.save();
}

export function discardAutomationEditorDraft(): void {
    guard?.discard();
}
