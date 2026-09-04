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
    /**
     * Persist the draft. Resolves `true` when it is safely stored, `false` when it is not — and the
     * navigation only proceeds on `true`.
     *
     * **It returns a promise, and it can refuse, because the save it performs can do both.** The
     * first version was `save(): void`: the caller could neither await it nor hear it decline, so a
     * `save_automation` that was rejected by the enable-path validation, refused by a disabled
     * store, or lost to a busy SQLite would still have let the category change, unmounted the
     * editor, and destroyed the draft — reintroducing the exact blocker this guard exists to
     * prevent, through its own remedy. Compare `settingsNavGuard.ts`, the shape this file copies:
     * it returns a boolean precisely so it CAN decline.
     */
    save(): Promise<boolean>;
    /** Throw the draft away. The navigation follows; discarding cannot fail. */
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

/**
 * Ask the editor to save. `true` means the navigation may proceed.
 *
 * With no guard registered there is no draft, so there is nothing to lose and nothing to refuse:
 * `true` is the honest answer, not a default.
 */
export function saveAutomationEditorDraft(): Promise<boolean> {
    return guard ? guard.save() : Promise.resolve(true);
}

export function discardAutomationEditorDraft(): void {
    guard?.discard();
}
