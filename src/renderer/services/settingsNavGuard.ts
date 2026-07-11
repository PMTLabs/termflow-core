/**
 * Module-level navigation guard decoupling the Settings screen (a tab) from the
 * tab layer. SettingsPage registers a guard while mounted; tab switch/close entry
 * points call `runSettingsGuard(proceed)`. When the guard blocks (settings dirty),
 * it returns true and owns calling `proceed` after the user resolves the
 * Save/Discard/Cancel prompt (Cancel drops `proceed`). No-op when nothing is
 * registered, so non-settings navigation is unaffected.
 */
export type SettingsGuardFn = (proceed: () => void) => boolean;

let guard: SettingsGuardFn | null = null;

export function registerSettingsGuard(fn: SettingsGuardFn): void {
  guard = fn;
}

export function clearSettingsGuard(): void {
  guard = null;
}

export function runSettingsGuard(proceed: () => void): boolean {
  if (!guard) return false;
  return guard(proceed);
}
