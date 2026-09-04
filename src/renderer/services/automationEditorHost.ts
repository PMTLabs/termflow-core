/**
 * Opening the automation editor from OUTSIDE Settings (`plan/028` item D).
 *
 * Tam's ask: right-clicking a terminal that has a rule armed on it offers that rule, and clicking
 * it opens the edit dialog. The dialog is `AutomationEditor`, which until now was rendered only by
 * `AutomationsPanel` — so the request has to cross from a portalled context menu, or from Canvas
 * Mode's own tab, to a component mounted at the app root. Module-level rather than a prop chain,
 * for the reason `automationEditorGuard.ts` gives for the same shape: the two ends are a leaf and
 * the app shell.
 *
 * **This is only the request.** `GlobalAutomationEditor` is what renders, and it resolves the rule
 * from `automationArmed`'s live list rather than being handed a snapshot — a rule object captured
 * when a menu opened is already stale by the time it is clicked if another window saved it.
 */
import { isAutomationEditorMounted } from './automationEditorGuard';

/**
 * Toast the refusal, reaching the Redux store through a DYNAMIC import.
 *
 * A static `import { store }` here would pull the whole app graph in at module load —
 * `store/index` → `layoutsSlice` → `StateManager` → `TerminalContainer` → `TerminalDisplay` →
 * `tauri-bridge`, which calls `listen()` at import time. Anything importing this service, including
 * the shared menu section every terminal's context menu now mounts, would drag that in with it. The
 * cost is paid only on the rare refusal path, and a toast is already asynchronous to the user.
 */
async function toastRefusal(message: string): Promise<void> {
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
        void toastRefusal('An automation is already open for editing — close it first.');
        return;
    }
    openRuleId = ruleId;
    emit();
}

/** Close whatever the host is showing. */
export function closeAutomationEditor(): void {
    if (openRuleId === null) return;
    openRuleId = null;
    emit();
}

export function subscribeAutomationEditorHost(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The rule id the host should be showing, or `null`. */
export function getOpenAutomationRuleId(): string | null {
    return openRuleId;
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
    pendingLogRuleId = null;
    listeners.clear();
}
