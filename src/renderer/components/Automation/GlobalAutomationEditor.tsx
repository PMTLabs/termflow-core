import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { JUST_FIRED_MS } from '../Settings/Automations/automationState';
import {
    getAutomationOrigin,
    refreshAutomationArmed,
    useAutomationRules,
    useAutomationRuntimeState,
} from '../../services/automationArmed';
import {
    closeAutomationEditor,
    getOpenAutomationDraft,
    getOpenAutomationRuleId,
    requestAutomationLog,
    subscribeAutomationEditorHost,
} from '../../services/automationEditorHost';
import { openSettingsTab } from '../../services/openSettings';
import { AutomationEditor } from './AutomationEditor';

/**
 * The automation editor's second home — the app root (`plan/028` item D).
 *
 * Item D lets a rule be opened from a pane's context menu and from Canvas Mode, neither of which is
 * inside the Settings page. This mounts one editor beside `GlobalPeerRequests` and `EulaAcceptModal`
 * so those surfaces have somewhere to open it, and renders nothing at all until they ask.
 *
 * **It is the same component, not a second editor**, which is what makes the two homes safe: round
 * 2 extracted `auToggle.css` out of `AutomationsPanel.css` for exactly this moment, so the dialog
 * carries every style it needs (`AutomationEditor.css` + `auToggle.css`, both imported by the
 * editor itself) and inherits nothing from the panel that is not on screen here.
 *
 * `openAutomationEditorFor` refuses while any editor is mounted, so this and the Settings one can
 * never both hold the single dirty-guard slot — see `automationEditorHost.ts`.
 *
 * **A second request shape, since "Automation is always available" added one.** `openRuleId` names
 * an existing rule to resolve out of the live list, exactly as before. `openDraft` carries a whole
 * unsaved `AutomationRule` (from `blankDraft()`, seeded with this terminal) for "New automation for
 * this terminal" — there is no id yet for a lookup to resolve. The two are mutually exclusive at
 * the host (`automationEditorHost.ts`), so reading both here and letting the draft win when present
 * cannot pick the wrong one.
 */
export const GlobalAutomationEditor: React.FC = () => {
    const ruleId = useSyncExternalStore(
        subscribeAutomationEditorHost,
        getOpenAutomationRuleId,
        getOpenAutomationRuleId,
    );
    const draft = useSyncExternalStore(
        subscribeAutomationEditorHost,
        getOpenAutomationDraft,
        getOpenAutomationDraft,
    );
    const rules = useAutomationRules();
    const runtime = useAutomationRuntimeState();

    // `Just fired` is the one state that expires on its own rather than arriving as an event, so a
    // rule that fires and then goes quiet would sit on the receipt forever. This is the narrow half
    // of `AutomationsPanel`'s `tick`: one timer, for THIS rule's most recent fire.
    const [, setTick] = useState(0);
    const rule = draft ?? (ruleId === null ? null : rules.find((r) => r.id === ruleId) ?? null);
    const pairs = rule ? runtime.rules[rule.id] : undefined;
    const lastFiredAt = pairs
        ? Object.values(pairs).reduce<number | null>(
            (latest, pair) => (pair.lastFiredAt !== null && (latest === null || pair.lastFiredAt > latest)
                ? pair.lastFiredAt
                : latest),
            null,
        )
        : null;
    useEffect(() => {
        if (lastFiredAt === null) return undefined;
        const due = lastFiredAt + JUST_FIRED_MS + 50 - Date.now();
        if (due <= 0) return undefined;
        const id = setTimeout(() => setTick((n) => n + 1), due);
        return () => clearTimeout(id);
    }, [lastFiredAt]);

    // The request outlived its rule — deleted in another window, or from the Settings list while
    // the menu that named it was open. Closing is the honest response; rendering the editor with a
    // blank draft would silently offer to create a NEW rule under the name of one the user asked to
    // edit. Guarded on `ruleId !== null` alone, which a draft request never sets, so this never
    // fires for "New automation for this terminal" — a draft's id (`''`) is never in `rules` by
    // definition, and that must not read as "outlived".
    useEffect(() => {
        if (ruleId !== null && rule === null && rules.length > 0) closeAutomationEditor();
    }, [ruleId, rule, rules.length]);

    if (!rule) return null;

    return (
        <AutomationEditor
            rule={rule}
            // **`'seeded'`, not the gallery's `'blank'`** — the two used to be the same call, and
            // that is what made "New automation for this terminal" open on an empty canvas with the
            // terminal it had just pinned nowhere on screen, and let Escape throw that pick away
            // without a prompt. `draft !== null` is exactly "this open request came from
            // `openAutomationEditorForDraft`, not from resolving an existing id", and every such
            // request is seeded: `newDraftFor` is its only producer and it always pins a terminal.
            // See `CanvasOpening`.
            opening={draft !== null ? 'seeded' : 'saved'}
            runtime={runtime}
            now={Date.now()}
            origin={getAutomationOrigin()}
            onClose={closeAutomationEditor}
            onOpenFullLog={(id) => {
                // The panel is in a tab that may not exist yet, so the scope travels through the
                // same race-free hand-off `openSettingsTab`'s own category does.
                requestAutomationLog(id);
                closeAutomationEditor();
                openSettingsTab('automations');
            }}
            onChanged={refreshAutomationArmed}
        />
    );
};

export default GlobalAutomationEditor;
