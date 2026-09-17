/**
 * Plan 045 — the one place that answers *is an admin tab available*, *which
 * profiles offer it*, and *what picking one does*. All four menu surfaces
 * (`TerminalDisplay`, `PaneContextMenu`, `TabContextMenu`, `NewTabDropdown`)
 * call these instead of each re-deriving the rule — so a wrong profile list,
 * a dead pick, or a mismatched tooltip is impossible-by-construction rather
 * than caught-by-review on the fourth surface (plan 045 §4.1, AC10).
 */

import { store } from '../store';
import { addTab } from '../store/slices/tabsSlice';
import type { ShellProfile } from '../store/slices/settingsSlice';
import { generateId } from '../utils/id';
import { generateUniqueTabName } from './newTabActions';

export type AdminTabSupportReason =
  | 'ok'
  | 'not-windows'
  | 'already-elevated'
  | 'sidecar-disabled'
  | 'killed';

export interface AdminTabSupport {
  supported: boolean;
  reason: AdminTabSupportReason;
}

/** Backend unreachable/not-yet-asked default: unsupported, so a stale or
 *  pre-boot renderer never offers a menu item it cannot back up. */
const UNKNOWN_SUPPORT: AdminTabSupport = { supported: false, reason: 'not-windows' };

let cachedSupport: AdminTabSupport = UNKNOWN_SUPPORT;

/**
 * Ask the backend once at boot, next to `initProfileScope` (plan 045 §4.3 —
 * "fetch once ... and cache"). The backend re-checks on every elevated spawn
 * regardless (`ensure_elevated_host_inner`), so a stale cache here can only
 * make the menu item wrongly disabled, never wrongly enabled.
 */
export async function initAdminTabSupport(
  invoke?: (cmd: string) => Promise<unknown>,
): Promise<AdminTabSupport> {
  if (!invoke) return cachedSupport;
  try {
    const result = (await invoke('get_admin_tab_support')) as AdminTabSupport | undefined;
    if (result && typeof result.supported === 'boolean') cachedSupport = result;
  } catch (e) {
    console.warn('adminTabActions: could not resolve admin tab support; treating as unsupported', e);
  }
  return cachedSupport;
}

/** Synchronous — every menu builds its items on the same render pass that
 *  opens it (see `ContextMenu`), so this can never be a promise. */
export function adminTabSupport(): AdminTabSupport {
  return cachedSupport;
}

const REASON_TOOLTIPS: Record<Exclude<AdminTabSupportReason, 'ok'>, string> = {
  'not-windows': 'Requires Windows',
  'already-elevated': 'Already running as Administrator',
  'sidecar-disabled': 'Terminal sidecar is disabled',
  killed: 'Admin tabs are disabled',
};

/** One definition of the explanatory copy every surface shows on a disabled
 *  item (O2 ruling — disabled + tooltip, never hidden). Empty for `'ok'`,
 *  which never renders disabled. */
export function adminTabTooltip(reason: AdminTabSupportReason): string {
  return reason === 'ok' ? '' : REASON_TOOLTIPS[reason];
}

/** Native (non-WSL) profiles only — WSL distros running elevated is out of
 *  scope (plan 045 non-goal). `is_wsl` is set only by `detect_wsl_distributions`
 *  on the Rust side; a user's own custom profile that happens to launch
 *  `wsl.exe` is not excluded by this, which is a decision, not an oversight. */
export function nativeProfilesForAdmin(
  state: { settings: { shellProfiles: ShellProfile[] } },
): ShellProfile[] {
  return (state.settings.shellProfiles ?? []).filter((p) => !p.is_wsl);
}

/** Open a new elevated tab running `profile`, immediately after `afterTabId`
 *  when given (mirrors `openNewTabWithDefaultProfile`'s placement rule),
 *  otherwise appended. The pane leaf inherits `elevated: true` from the tab
 *  via `tabTreeSeed`, which is what actually routes the spawn (T8). */
export function openAdminTabWithProfile(profile: ShellProfile, afterTabId?: string): void {
  const existing = store.getState().tabs.tabs.map((t) => t.title);
  store.dispatch(addTab({
    id: generateId('tb'),
    title: generateUniqueTabName(existing, profile.name),
    shellType: profile.id,
    icon: '🖥️',
    elevated: true,
    insertAfterId: afterTabId,
  }));
}

/** True when `error` is the backend's UAC-deny sentinel (plan 045 AC6): the
 *  user declining the elevation prompt is a normal choice, not a failure, so
 *  callers use this to recognise it and undo state optimistically created
 *  before the spawn (e.g. `TerminalPane`'s create-catch) instead of showing
 *  an error. `ensure_elevated_host_inner` returns the sentinel UNWRAPPED
 *  (see `ADMIN_UAC_CANCELLED`'s own doc comment) specifically so this exact
 *  match works — mirrors `isHostSessionContended`'s error-shape handling. */
export function isAdminUacCancelled(error: unknown): boolean {
  const ADMIN_UAC_CANCELLED = 'ADMIN_UAC_CANCELLED';
  return error instanceof Error
    ? error.message === ADMIN_UAC_CANCELLED
    : typeof error === 'string' && error === ADMIN_UAC_CANCELLED;
}

/** Test seam. Production code sets this only via `initAdminTabSupport`. */
export function __setAdminTabSupportForTests(support: AdminTabSupport): void {
  cachedSupport = support;
}
