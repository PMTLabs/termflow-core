import React, { useState } from 'react';
import {
    getArmedAutomations,
    getAutomationOrigin,
    getAutomationRules,
    refreshAutomationArmed,
    useArmedAutomations,
    useAutomationRules,
} from '../../services/automationArmed';
import {
    openAutomationEditorFor,
    openAutomationEditorForDraft,
    toastAutomationNotice,
} from '../../services/automationEditorHost';
import { blankDraft } from '../Settings/Automations/automationTemplates';
import { armedEntryViews, armedMenuLabel } from './automationArmedSummary';
import './automationSurfaces.css';
// Type-only, so no part of `Terminal/ContextMenu` — least of all its stylesheet — is pulled into
// `PaneContextMenu` or `CanvasNodeMenu`, which import this module for the component above and have
// their own menu implementation. Erased at compile time.
import type { ContextMenuFlyoutRow, ContextMenuItem } from '../Terminal/ContextMenu';
import type { AutomationRule } from '../../types/electron';

/**
 * The two footer actions' words, shared by the accordion below and `automationMenuItems`'s flyout
 * so a user who right-clicks a pane title and then the terminal an inch below it reads the same
 * thing in both places — the exact drift `armedMenuLabel` already exists to prevent, one level up.
 */
const NEW_AUTOMATION_LABEL = 'New automation for this terminal';
const ADD_TO_EXISTING_LABEL = 'Add to an existing automation';
/** Why the "add to an existing automation" list can come up empty even when rules exist: a
 *  `'rule'`-mode automation picks its terminals by criterion and ignores `targetIds` outright, so
 *  "adding" a terminal to one would be a control that visibly does nothing — the failure
 *  `PaneContextMenu`'s Find item, and `openAutomationEditorFor` above, both already refuse to ship. */
const NO_PINNED_RULES_MESSAGE =
    'No automations can be added to — criterion-based rules choose their own terminals.';

/**
 * A fresh, unsaved rule already pointed at `terminalId` — "New automation for this terminal".
 *
 * `blankDraft()` is the same starting point the Settings gallery's own "blank" card uses, so a rule
 * created from a terminal's context menu and one created from Settings are the same shape of thing,
 * not a second constructor for "new rule" that could drift from the first. Only the targeting is
 * overwritten: `'pinned'` + this one terminal, so the editor opens already pointed at the terminal
 * the user right-clicked rather than at "every terminal" (`blankDraft`'s own default, meant for the
 * gallery entry point where there is no terminal to point at yet). `enabled` is left at `blankDraft`'s
 * `false` — every new rule starts off, and that safety property belongs to `automationTemplates.ts`,
 * not to this call site.
 */
function newDraftFor(terminalId: string): AutomationRule {
    const draft = blankDraft();
    draft.targetMode = 'pinned';
    draft.targetIds = [terminalId];
    return draft;
}

/**
 * The rules `terminalId` could be ADDED to via "Add to an existing automation".
 *
 * Two filters, both load-bearing:
 * - `targetMode === 'pinned'` — a `'rule'`-mode automation ignores `targetIds`, so listing one here
 *   would offer an action that changes a column nothing reads (see `NO_PINNED_RULES_MESSAGE`).
 * - `!targetIds.includes(terminalId)` — a rule already watching this terminal is not something to
 *   offer "adding" it to again; that is the same defect one level down; skip rather than mark it,
 *   since a disabled row is a worse answer to "why is this here" than not showing it at all.
 *
 * Ordered the way the Settings list and the armed index already order rules — `sortOrder`, then
 * name — so which rule appears first here does not depend on object key order or fetch timing.
 */
function addableRules(terminalId: string, rules: readonly AutomationRule[]): AutomationRule[] {
    return rules
        .filter((rule) => rule.targetMode === 'pinned' && !rule.targetIds.includes(terminalId))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * Add `terminalId` to the watched targets of the rule with `ruleId`, and save — "Add to an existing
 * automation", picked.
 *
 * **Takes an ID and re-resolves the rule HERE, at click time; it is never handed the row's copy.**
 * Both hosts build their rows when the menu opens, so a rule object captured there is a snapshot of
 * menu-assembly time — and `save_automation` is an unconditional upsert with no version token
 * (`automation_commands.rs` says that is deliberate: the log entry, not concurrency control, is what
 * that path was built for). Writing the captured copy back therefore had two reachable failure
 * modes. *Clobber:* another window edits this rule's message, and the whole stale object goes back
 * over it, silently reverting the edit. *Resurrection:* a rule DELETED in another window is
 * re-INSERTED by the upsert the moment a stale row is clicked. `openAutomationEditorFor` was built
 * to resolve an id out of the live list for exactly this reason — see `automationEditorHost.ts`'s
 * header — so the one write path in this module resolves too rather than doing the opposite of its
 * neighbour. Resurrection is closed outright: a missing id saves nothing and says so. The clobber
 * window narrows from "however long the menu stayed open" to the one tick between this lookup and
 * the save, which is as far as it can be taken without a version token — a protocol decision that
 * belongs with the store, not with a context menu.
 *
 * Appends and saves ONLY `targetIds`; every other field of the LIVE rule rides through untouched,
 * via the spread. `refreshAutomationArmed()` is called explicitly rather than left to the
 * `automation:changed` event this same save will emit, for the reason `GlobalAutomationEditor`'s
 * `onChanged` prop already is: the menu that triggered this has just closed, so there is nobody
 * left to notice a live event land a moment later, and the pane's own armed badge should update as
 * promptly as a save from inside the editor does.
 *
 * **No in-flight guard, and none is needed.** Both call sites are `void addTerminalToRule(…)`, so a
 * row clicked twice would run this twice — except that neither row survives the first click. The
 * accordion calls `onDismiss()` (its host's `onClose`) BEFORE this, and the flyout row carries
 * `closeMenuOnSelect`, which `ContextMenu` honours in the same handler on the line after
 * `onSelect?.()`. Both are synchronous React state updates inside one discrete event, so the row is
 * unmounted before the browser can dispatch a second click at it. Even a hypothetical second call
 * would append the same id to the same resolved `targetIds` and upsert an identical payload. A
 * guard here would be a mechanism with no input.
 */
async function addTerminalToRule(ruleId: string, terminalId: string): Promise<void> {
    const rule = getAutomationRules().find((candidate) => candidate.id === ruleId);
    if (!rule) {
        // Deleted while the menu was open. Silence here would be the worst of the three outcomes:
        // the user clicks a named rule, nothing is written, and nothing says why.
        void toastAutomationNotice(
            'Could not add this terminal — that automation no longer exists.',
        );
        return;
    }
    if (rule.targetIds.includes(terminalId)) return;
    const api = typeof window === 'undefined' ? undefined : window.electronAPI;
    if (!api?.saveAutomation) return;
    try {
        await api.saveAutomation(
            { ...rule, targetIds: [...rule.targetIds, terminalId] },
            getAutomationOrigin(),
        );
    } catch (err) {
        // **A refused write must be heard.** Both call sites invoke this as `void addTerminalToRule(…)`
        // from a menu row that dismisses itself, so a rejection here has nowhere to surface: the user
        // clicks "Add to <rule>", the menu closes, and the terminal is simply not watched — a control
        // that reports success it did not have. `save_automation` genuinely can refuse (a `SQLITE_BUSY`
        // against the 30 s scrollback flush is called routine by the store's own docs, and the backend
        // re-validates an ENABLED rule on every save), so this is not a theoretical path.
        //
        // A toast rather than a rethrow: the caller is a fire-and-forget click handler, and an
        // unhandled rejection is exactly the silence this is fixing.
        void toastAutomationNotice(
            `Could not add this terminal to “${rule.name}” — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
    }
    void refreshAutomationArmed();
}

/**
 * The `Automation ▸` section of a terminal's context menu (`plan/028` item D; extended by Tam's
 * follow-up: *"Update the terminal right-click context menu so that Automation is always
 * available, whether or not the terminal is currently armed by an automation rule. For terminals
 * not armed by any rule, the Automation menu must provide actions to: create a new automation rule
 * for the terminal; add the terminal to an existing automation rule's watched targets."*
 *
 * ONE component, mounted by `PaneContextMenu` and by `CanvasNodeMenu`, rather than the same JSX
 * written twice. That is buildable because `CanvasMenu` renders `pane-context-menu canvas-menu` and
 * imports `PaneContextMenu.css`, so `context-menu-item`, `context-menu-expand-arrow` and
 * `context-menu-subpanel` all mean the same thing in both hosts — the two menus already share their
 * markup vocabulary, and this section just uses it.
 *
 * **An accordion in THESE two hosts, a hover flyout in the terminal's own menu.** The app has two
 * menu systems and they answer "a section with children" differently. `PaneContextMenu` and
 * `CanvasNodeMenu` have no positioning machinery at all, and the accordion is their settled
 * answer — `TabContextMenu.css` says so in as many words for the Color Schema panel, and
 * `PaneContextMenu`'s own "Color scheme for …" item is built exactly this way. `Terminal/ContextMenu`
 * grew an edge-aware flyout in `plan/029`, so `automationMenuItems` below opens one. Same rules, in
 * the same order, in the same words; only the shape follows the host.
 *
 * **Always rendered for a terminal, armed or not.** The original cut hid the whole section when
 * nothing was armed, on the reasoning that it was "not an action on this terminal that is
 * temporarily unavailable, it is a list of rules that do not exist" — true when the only thing the
 * section could do was list rules. It is no longer true: an unarmed terminal can still create a new
 * rule or join an existing one, so there is something to do here even at zero, and hiding the
 * section would hide the only way to reach either action. `terminalId === null` still renders
 * nothing — a pane with no terminal has nothing to automate, armed or not.
 */
export const AutomationMenuSection: React.FC<{
    /**
     * The terminal whose rules to list — its durable `tm-` leaf, or `null` for a pane that has no
     * terminal. A primitive rather than the entries, so that BOTH hosts stay what they already are:
     * `CanvasNodeMenu` is documented as "pure and props-only, so its label/state table is a render
     * test", and threading an array of rules through it would end that.
     */
    terminalId: string | null;
    /**
     * Dismiss the host menu. REQUIRED, and called before the editor opens rather than after: the
     * two menus close by different mechanisms (`onClose` here, `onDismiss` there) and neither
     * closes itself when a portalled dialog appears on top of it.
     */
    onDismiss: () => void;
}> = ({ terminalId, onDismiss }) => {
    const [expanded, setExpanded] = useState(false);
    // A second, nested toggle for "Add to an existing automation" — this host has no folder/flyout
    // machinery, so the list it would otherwise open in a submenu is a second collapsible level of
    // the same accordion instead.
    const [addExpanded, setAddExpanded] = useState(false);
    // LIVE rather than read once when the menu opened: a rule can be switched on, complete, or stop
    // matching this terminal while the menu is up, and a row that outlives its rule opens an editor
    // on something the engine has already dropped. Same reasoning as `useSurfaceChromeAvailable`
    // in `PaneContextMenu`'s Find item.
    const armed = useArmedAutomations(terminalId);
    /**
     * SUBSCRIBED, not read bare — and specifically on the case this section exists for.
     *
     * `useArmedAutomations` above cannot stand in for this. Its snapshot for a terminal with
     * nothing armed on it is `automationArmed`'s module-constant `EMPTY`, whose identity is stable
     * *by design* (a fresh `[]` per call would re-render every unarmed consumer on every store
     * tick). So on an UNARMED terminal a `reindex()` → `emit()` hands `useSyncExternalStore` the
     * same array it already had, `Object.is` says nothing changed, and this component does not
     * re-render — which is exactly the terminal for which "Add to an existing automation" is the
     * whole point of the section. A bare `getAutomationRules()` there would freeze the list at the
     * render that opened the menu, and a rule created, deleted or retargeted in another window
     * would be invisible to it for as long as the menu stayed up. `useAutomationRules` is the same
     * store and the same listener set, but its snapshot is the rule ARRAY, whose identity a refetch
     * really does replace — which is why `GlobalAutomationEditor` resolves its rule through it too.
     */
    const rules = useAutomationRules();

    if (terminalId === null) return null;

    // One clock for the whole section, so two rows cannot disagree about whether a fire was
    // "just now" — the same rule `AutomationsPanel` states for its list.
    const views = armedEntryViews(armed, Date.now());
    const addable = addableRules(terminalId, rules);

    return (
        <>
            <div className="context-menu-divider" />
            <button
                type="button"
                className="context-menu-item"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
            >
                <span className="menu-icon">⚡</span>
                {armedMenuLabel(views.length)}
                <span className="context-menu-expand-arrow">{expanded ? '▾' : '▸'}</span>
            </button>
            {expanded && (
                <div className="context-menu-subpanel">
                    {views.length === 0 && (
                        <div className="au-menu-empty">No automation is armed on this terminal.</div>
                    )}
                    {views.map((view) => (
                        <button
                            type="button"
                            key={view.ruleId}
                            className="context-menu-item au-menu-rule"
                            onClick={() => {
                                onDismiss();
                                openAutomationEditorFor(view.ruleId);
                            }}
                            title={`Edit “${view.name}”`}
                        >
                            <span className="au-menu-rule-name">{view.name}</span>
                            <span className="au-menu-rule-state">{view.stateLabel}</span>
                        </button>
                    ))}
                    <div className="context-menu-divider" />
                    <button
                        type="button"
                        className="context-menu-item au-menu-action"
                        onClick={() => {
                            onDismiss();
                            openAutomationEditorForDraft(newDraftFor(terminalId));
                        }}
                    >
                        <span className="menu-icon">➕</span>
                        {NEW_AUTOMATION_LABEL}
                    </button>
                    <button
                        type="button"
                        className="context-menu-item au-menu-action"
                        onClick={() => setAddExpanded((v) => !v)}
                        aria-expanded={addExpanded}
                    >
                        <span className="menu-icon">📌</span>
                        {ADD_TO_EXISTING_LABEL}
                        <span className="context-menu-expand-arrow">{addExpanded ? '▾' : '▸'}</span>
                    </button>
                    {addExpanded && (
                        <div className="context-menu-subpanel">
                            {addable.length === 0 && (
                                <div className="au-menu-empty">{NO_PINNED_RULES_MESSAGE}</div>
                            )}
                            {addable.map((rule) => (
                                <button
                                    type="button"
                                    key={rule.id}
                                    className="context-menu-item au-menu-rule"
                                    onClick={() => {
                                        onDismiss();
                                        void addTerminalToRule(rule.id, terminalId);
                                    }}
                                    title={`Add this terminal to “${rule.name}”`}
                                >
                                    <span className="au-menu-rule-name">{rule.name}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </>
    );
};

/**
 * The same rules, for the menu that cannot take a component (Tam, follow-up to item D: *"ensure
 * right click context on terminal area has the Automations item, same as the user r-click on the
 * pane title"*).
 *
 * The terminal's own content menu — Copy, Paste, Clear, Selection mode — is `Terminal/ContextMenu`,
 * which renders from an ITEM ARRAY and has no notion of a child section or an accordion. So this is
 * the third host, and it takes the data instead of the JSX.
 *
 * **`armedEntryViews` is still the single source**, which is what stops the two menus drifting:
 * which rules are offered, in what order, and the words describing each one's state are decided
 * once, above both — down to the row that opens the list, whose text is `armedMenuLabel` in both.
 * Only the layout differs: two lines in an accordion there, a hover flyout here, because those are
 * the shapes the two menu systems actually have.
 *
 * **A flyout parent, now that `plan/029` has given this menu one** (Tam: *"we need to do the same
 * submenu on hover on the automations item"*). Until Snippets and Command History landed there was
 * no submenu machinery in this host at all, so the rules were spread in as one flat
 * `Automation: <name>` row each — which put a terminal's automations in among Copy/Paste/Clear and
 * grew the menu by a row per rule. They nest now, exactly as the pane title's do.
 *
 * **Exactly one item for a real terminal, never a parent over a dead-end panel.** That was already
 * true when the item existed only to list armed rules — an `Automations ▸` row over nothing was the
 * item that looks live and does nothing, which is what `PaneContextMenu`'s Find item is documented
 * as refusing to be. It stays true now that the panel always has the two footer actions: the item
 * itself is always offered for a real terminal (`terminalId !== null`), because there is always
 * something behind it, and it stays absent for `null` because a pane with no terminal has nothing
 * to automate.
 *
 * Reads the store WITHOUT subscribing, deliberately: this menu is assembled when it opens, exactly
 * as `hasSelection` and the detected agent beside it are. `getSurfaceChrome`'s doc states the same
 * split — subscribe for what a surface DRAWS continuously, read once for what a click needs.
 */
export function automationMenuItems(terminalId: string | null): ContextMenuItem[] {
    if (!terminalId) return [];
    const armed = getArmedAutomations(terminalId);
    // One clock for every row, so two of them cannot disagree about whether a fire was "just now"
    // — the rule `AutomationsPanel` states for its list, and the accordion above follows.
    const views = armedEntryViews(armed, Date.now());
    const addable = addableRules(terminalId, getAutomationRules());

    // "Add to an existing automation" is itself a folder (`children`), so a rule name never has to
    // compete with "New automation for this terminal" in one flat list — the same folder shape
    // `snippetsHistoryMenu.ts` nests a snippet folder in. Empty is a NAMED reason, not a blank
    // panel: `NO_PINNED_RULES_MESSAGE` says why nothing is offered rather than leaving the folder
    // looking broken.
    const addToExistingRows: ContextMenuFlyoutRow[] = addable.length > 0
        ? addable.map((rule): ContextMenuFlyoutRow => ({
            id: `add-to-${rule.id}`,
            label: rule.name,
            title: `Add this terminal to “${rule.name}” and save.`,
            onSelect: () => { void addTerminalToRule(rule.id, terminalId); },
            closeMenuOnSelect: true,
        }))
        : [{ id: 'no-pinned-rules', label: NO_PINNED_RULES_MESSAGE, disabled: true }];

    return [{
        label: armedMenuLabel(views.length),
        icon: '⚡',
        title: 'Automations watching this terminal, plus actions to arm a new one.',
        submenu: {
            searchPlaceholder: 'Search automations…',
            // The ARRAY form, so `ContextMenu`'s own case-insensitive filter over `label` +
            // `detail` does the searching. Snippets takes the function form because
            // `filterSnippets` also owns #tag matching and the flatten-on-search rule; there is no
            // equivalent here — a handful of rules, named by whoever wrote them.
            rows: views.map((view): ContextMenuFlyoutRow => ({
                id: `automation-${view.ruleId}`,
                label: view.name,
                // The state pill's words, in the dimmed right-hand column: the flyout's rows are
                // one line, and this is the half the accordion prints underneath the name.
                detail: view.stateLabel,
                title: `${view.name} — ${view.stateLabel}. Opens this rule for editing.`,
                onSelect: () => openAutomationEditorFor(view.ruleId),
                // §4.5, and the behaviour the flat rows already had: `ContextMenu` closes after
                // any plain item's `click`. Said per row because the flyout's default is to keep
                // the menu up, and an editor opening behind a menu that stayed is two surfaces
                // both believing they have the keyboard.
                closeMenuOnSelect: true,
            })),
            // The two cases used to collapse into one, back when this parent could not exist with
            // nothing armed: reaching an empty `rows` list meant a query had been typed. Now the
            // parent is always here, so an untouched search box (`query === ''`) reaching this means
            // nothing is armed on this terminal at all — a different fact from "you typed something
            // that matched nothing" and worded accordingly.
            emptyRow: (query: string): ContextMenuFlyoutRow => {
                const q = query.trim();
                return q
                    ? { id: 'no-automation-matches', label: `No automations match '${q}'`, disabled: true }
                    : { id: 'no-automation-armed', label: 'No automation is armed on this terminal', disabled: true };
            },
            // Always rendered, never filtered — the home of the two actions that must stay
            // reachable from every state, armed or not, matched or not (§4.5's own rule for
            // Snippets' "Add New Snippet", applied here for the same reason).
            footerRows: [
                {
                    id: 'new-automation',
                    label: NEW_AUTOMATION_LABEL,
                    icon: '➕',
                    title: 'Open a new, unsaved automation already pointed at this terminal.',
                    onSelect: () => openAutomationEditorForDraft(newDraftFor(terminalId)),
                    closeMenuOnSelect: true,
                },
                {
                    id: 'add-to-existing',
                    label: ADD_TO_EXISTING_LABEL,
                    icon: '📌',
                    title: 'Add this terminal to a rule that already exists.',
                    children: addToExistingRows,
                },
            ],
        },
    }];
}

export default AutomationMenuSection;
