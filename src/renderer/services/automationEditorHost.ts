/**
 * Opening the automation editor from OUTSIDE Settings (`plan/028` item D, extended for "Automation
 * is always available").
 *
 * Tam's original ask: right-clicking a terminal that has a rule armed on it offers that rule, and
 * clicking it opens the edit dialog. The dialog is `AutomationEditor`, which until now was rendered
 * only by `AutomationsPanel` — so the request has to cross from a portalled context menu, or from
 * Canvas Mode's own tab, to a component mounted at the app root. Module-level rather than a prop
 * chain, for the reason `automationEditorGuard.ts` gives for the same shape: the two ends are a leaf
 * and the app shell.
 *
 * **This is only the request.** `GlobalAutomationEditor` is what renders. For an EXISTING rule it
 * resolves the id out of `automationArmed`'s live list rather than being handed a snapshot — a rule
 * object captured when a menu opened is already stale by the time it is clicked if another window
 * saved it. A rule that does not exist yet has no id to resolve, which is what
 * `openAutomationEditorForDraft` below is for: the menu hands over the whole draft, because there is
 * nothing live to look up.
 */
import type { AutomationRule } from '../types/electron';
import { isAutomationEditorMounted } from './automationEditorGuard';

/**
 * Toast a one-line notice, reaching the Redux store through a DYNAMIC import.
 *
 * Exported, because the editor's "one at a time" refusal is no longer the only thing in this
 * feature that has to speak up from inside a context menu: `AutomationMenuSection`'s "Add to an
 * existing automation" writes to the store and can be refused too. One implementation, so the
 * dynamic-import reasoning below is stated once and cannot be half-copied.
 *
 * A static `import { store }` here would pull the whole app graph in at module load —
 * `store/index` → `layoutsSlice` → `StateManager` → `TerminalContainer` → `TerminalDisplay` →
 * `tauri-bridge`, which calls `listen()` at import time. Anything importing this service, including
 * the shared menu section every terminal's context menu now mounts, would drag that in with it. The
 * cost is paid only on the rare refusal path, and a toast is already asynchronous to the user.
 */
export async function toastAutomationNotice(message: string): Promise<void> {
    try {
        const [{ store }, { addToast }] = await Promise.all([
            import('../store'),
            import('../store/slices/uiSlice'),
        ]);
        store.dispatch(addToast({ message, type: 'info' }));
    } catch {
        // No store (a unit test, or the browser host). The refusal itself still stands.
    }
}

let openRuleId: string | null = null;
/**
 * A draft rule the host should open instead of an existing one — set by
 * `openAutomationEditorForDraft` for "New automation for this terminal". Mutually exclusive with
 * `openRuleId`: only one request is ever pending, because only one editor may ever be mounted (see
 * the guard below), so there is nothing to disambiguate between the two fields at read time.
 */
let openDraft: AutomationRule | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    listeners.forEach((listener) => listener());
}

/**
 * Ask the app-level host to open `ruleId`.
 *
 * **Refused, out loud, while any editor is already mounted.** There is one dirty guard slot
 * (`isAutomationEditorMounted`), and one editor's draft is not something another open may discard.
 * Refusing silently would be worse than refusing: a menu item that visibly does nothing reads as a
 * broken build, which is the "an item that looks live and calls nothing" rule `PaneContextMenu`'s
 * Find item already states.
 */
export function openAutomationEditorFor(ruleId: string): void {
    if (isAutomationEditorMounted()) {
        void toastAutomationNotice('An automation is already open for editing — close it first.');
        return;
    }
    openDraft = null;
    openRuleId = ruleId;
    emit();
}

/**
 * Ask the app-level host to open a brand-new, UNSAVED rule — "New automation for this terminal" in
 * `AutomationMenuSection` / `automationMenuItems`.
 *
 * Same refusal as `openAutomationEditorFor`, for the same reason: there is one dirty-guard slot,
 * and a second open — new draft or existing rule, it does not matter which — cannot be allowed to
 * take it over while the first editor's unsaved work is still sitting in it.
 */
export function openAutomationEditorForDraft(draft: AutomationRule): void {
    if (isAutomationEditorMounted()) {
        void toastAutomationNotice('An automation is already open for editing — close it first.');
        return;
    }
    openRuleId = null;
    openDraft = draft;
    emit();
}

/** Close whatever the host is showing. */
export function closeAutomationEditor(): void {
    if (openRuleId === null && openDraft === null) return;
    openRuleId = null;
    openDraft = null;
    emit();
}

export function subscribeAutomationEditorHost(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The rule id the host should be showing, or `null` — including while a DRAFT is open, since a
 *  draft has no id yet. Callers that also need the draft itself read `getOpenAutomationDraft`. */
export function getOpenAutomationRuleId(): string | null {
    return openRuleId;
}

/** The unsaved draft the host should be showing, or `null` when the open request (if any) named an
 *  existing rule id instead. */
export function getOpenAutomationDraft(): AutomationRule | null {
    return openDraft;
}

/**
 * A rule whose FULL LOG the Automations panel should show as soon as it mounts.
 *
 * The editor's "open the full log" link has to work from outside Settings too, and the panel it
 * needs is in a tab that may not exist yet. This is the same race-free hand-off
 * `openSettings.ts`'s `pendingSettingsCategory` uses, and for the same reason: a freshly opened
 * Settings tab is not rendered when `openSettingsTab()` returns, so a DOM event would beat the
 * mount. Consumed exactly once.
 *
 * Without it the link would land the user on the rule LIST while promising one rule's history —
 * a control that does something adjacent to what it says, which is the class of defect this
 * feature's own docs keep catching.
 */
let pendingLogRuleId: string | null = null;

export function requestAutomationLog(ruleId: string): void {
    pendingLogRuleId = ruleId;
}

export function consumePendingAutomationLog(): string | null {
    const id = pendingLogRuleId;
    pendingLogRuleId = null;
    return id;
}

/** Test-only: forget the open request and every subscriber. */
export function __resetAutomationEditorHostForTest(): void {
    openRuleId = null;
    openDraft = null;
    pendingLogRuleId = null;
    listeners.clear();
}
