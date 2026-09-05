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
 *
 * The first is a FUNCTION because the row now names the terminal it would pin (Tam: *"add terminal
 * id to: New automation for this terminal (<id>)"*), and that is worth more than a shorter label:
 * the three hosts draw this row over three different things — a pane title, a canvas node, the
 * terminal surface itself — and a window with several panes open offers the identical sentence in
 * each of them. The id is the one string that says WHICH, and it is the same id the picker ticks
 * and the activity log prints, so the label and the editor it opens name the terminal the same way
 * rather than each in their own words.
 */
function newAutomationLabel(terminalId: string): string {
    return `New automation for this terminal (${terminalId})`;
}
const ADD_TO_EXISTING_LABEL = 'Add to an existing automation';
/**
 * The glyph in front of a RULE's name, wherever one is offered as a row (Tam: *"add icon before
 * the automation name in the submenu"*).
 *
 * The same bolt the parent item carries, deliberately: it is the mark for *an automation*, and a
 * second glyph invented for the child rows would say the children are a different kind of thing
 * from the item they hang under. Stated once and used by every rule row in this file — the armed
 * list and the "add to an existing automation" list, in both the accordion and the flyout — so a
 * fourth list of rules cannot arrive wearing a fifth icon.
 */
const AUTOMATION_ROW_ICON = '⚡';
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
 * Add `terminalId` to the watched targets of the rule with `ruleId` — "Add to an existing
 * automation", picked.
 *
 * **The existence check belongs to the STORE, and this is the whole reason the row does not go
 * through `saveAutomation`.** Both hosts build their rows when the menu opens, so a rule object
 * captured there is a snapshot of menu-assembly time, and `save_automation` is an unconditional
 * upsert with no version token (`automation_commands.rs` says that is deliberate: the log entry,
 * not concurrency control, is what that path was built for). Writing a captured rule back therefore
 * had two reachable failure modes. *Clobber:* another window edits this rule's message, and the
 * whole stale object goes back over it, silently reverting the edit. *Resurrection:* a rule DELETED
 * in another window is re-INSERTED by the upsert the moment a stale row is clicked.
 *
 * Re-resolving the id against the renderer's own cached list before writing — which this function
 * used to do, under a comment claiming that closed resurrection outright — closes neither. It
 * cannot: `automation:changed` starts a refresh nobody awaits, so the cache may still be a commit
 * behind at click time, and even a perfectly fresh cache leaves the delete free to commit in the
 * gap between the read and the write. A read that DECIDES a write has to happen on that write's own
 * transaction, which is a thing only the store can do.
 *
 * So it does. `add_automation_target` evaluates *does this rule still exist* and appends the target
 * in one SQLite transaction, and sends back the answer: `false` = the rule is gone and **nothing
 * was written** — no rule row, no orphan target row. Both failure modes go with it. The row the
 * store writes back is the one it READ inside that same transaction, with the appended target and
 * `updated_at` the only two things this path changes on it; no captured copy of the rule crosses
 * the wire at all, so there is nothing left to clobber a concurrent edit with.
 *
 * `true` also covers an id the rule already watches — the rule watches this terminal, which is what
 * the click asked for — so the pre-flight `targetIds.includes` check this function used to make is
 * gone too, rather than being kept as a second, staler copy of a decision the store now owns.
 *
 * `ruleName` is passed in from the row rather than resolved here, and it is used for ONE thing: the
 * text of a failure toast. The row is where the name the user actually clicked is known, and after
 * the change above there is no local lookup left to take it from anyway.
 *
 * `refreshAutomationArmed()` is called explicitly rather than left to the `automation:changed` event
 * this same write emits, for the reason `GlobalAutomationEditor`'s `onChanged` prop already is: the
 * menu that triggered this has just closed, so there is nobody left to notice a live event land a
 * moment later, and the pane's own armed badge should update as promptly as a save from inside the
 * editor does. It runs on the WRITTEN path only, and the two branches that skip it are not the same
 * kind of skip. A rejection wrote nothing and announced nothing, so there is no new state to read
 * and no event coming either — re-indexing there would only tell the pane badge that something
 * happened, which is the false report the toast beside it exists to avoid. A `false` also wrote
 * nothing, but `add_automation_target` announces `automation:changed` UNCONDITIONALLY — outside its
 * `if added`, deliberately, because that branch is exactly the one where the calling window is
 * holding a rule that no longer exists — and `automationArmed`'s app-lifetime listener answers that
 * event with this very refetch. So the stale list is repaired on that branch regardless; a call here
 * would be a second copy of a refetch already on its way.
 *
 * **No in-flight guard, and none is needed** — but not for the reason this paragraph used to
 * give. Both call sites are `void addTerminalToRule(…)`, so a row clicked twice would run this
 * twice; what stops that is that neither row survives the first click. The accordion calls
 * `onDismiss()` (its host's `onClose`) on the line before this one, and the flyout row carries
 * `closeMenuOnSelect`, which `ContextMenu.activate` honours in a `finally` on the line *after*
 * `onSelect?.()`. Those are opposite orders, and it makes no difference here: both are React state
 * updates inside one discrete event, so both commit together and the row is unmounted before the
 * browser can dispatch a second click at it. The claim that used to stand here — that the guard was
 * unnecessary *because* the dismissal came first — named a cause that does no work, and was wrong
 * about the flyout besides. Even a hypothetical second call would be the no-op the store already
 * answers `true` to.
 */
async function addTerminalToRule(
    ruleId: string,
    terminalId: string,
    ruleName: string,
): Promise<void> {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI;
    if (!api?.addAutomationTarget) return;
    let added: boolean;
    try {
        added = await api.addAutomationTarget(ruleId, terminalId, getAutomationOrigin());
    } catch (err) {
        // **A refused write must be heard.** Both call sites invoke this as `void addTerminalToRule(…)`
        // from a menu row that dismisses itself, so a rejection here has nowhere to surface: the user
        // clicks "Add to <rule>", the menu closes, and the terminal is simply not watched — a control
        // that reports success it did not have. The command genuinely can refuse (a `SQLITE_BUSY`
        // against the 30 s scrollback flush is called routine by the store's own docs, and
        // `add_target_to_rule` re-applies the save gate to an already-ENABLED rule), so this is not a
        // theoretical path.
        //
        // A toast rather than a rethrow: the caller is a fire-and-forget click handler, and an
        // unhandled rejection is exactly the silence this is fixing.
        void toastAutomationNotice(
            `Could not add this terminal to “${ruleName}” — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
    }
    if (!added) {
        // Deleted between the moment this menu was built and this write — the race the store-side
        // check exists to lose safely. Silence here would be the worst of the three outcomes: the
        // user clicks a named rule, nothing is written, and nothing says why.
        //
        // Returns rather than falling through to the re-index: `false` means nothing was committed,
        // so there is nothing new to read back, and the command announces `automation:changed` on
        // this branch anyway — which refetches the list that still holds the ghost rule. See the
        // header for why that is the whole repair rather than half of one.
        void toastAutomationNotice(
            `Could not add this terminal to “${ruleName}” — that automation no longer exists.`,
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
     * Dismiss the host menu. REQUIRED, and in THIS component called before the action the row was
     * clicked for — the editor open, or the target write — rather than after.
     *
     * **What that ordering buys is a failed action, not a keyboard.** This paragraph used to argue
     * that a menu still on screen and an editor mounted under it are two surfaces both believing
     * they own the keyboard, and that dismissing first made that impossible. Measured, it does not:
     * every host's dismissal is a parent `setState`, React does not flush it until the end of the
     * discrete event, and so the menu is still mounted with its handlers live at the moment the
     * editor mounts — whichever order the two calls are in. The real guarantee is narrower and
     * still worth having: if the action raises, the dismissal has already been queued, so the menu
     * does not strand itself on screen over a surface that failed to open.
     *
     * **The third host reaches that guarantee by the opposite road, and deliberately.** Its rows
     * are data, so they say `closeMenuOnSelect: true` and `ContextMenu.activate` runs `onSelect`
     * first with the dismissal in a `finally` — same protection against a throwing action, without
     * moving a close callback that does synchronous DOM work ahead of the row that guards it. See
     * that field's own note; do not "align" the two by moving either one.
     *
     * Every one of this component's three action rows is pinned to that order by a click-driven
     * test in `automationArmedSurfaces.test.tsx` (armed rule, "New automation…", and an
     * "Add to an existing automation" target), each asserting the SEQUENCE rather than that both
     * calls happened — a pair of counters is satisfied by either order, which is how the flyout
     * host ran backwards for a round with a green suite.
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
                            {/* The icon and the name share a LINE, which is why they are wrapped:
                                `.au-menu-rule` is `flex-direction: column` so that a rule can be a
                                name over its state, and an icon dropped in as a third child of that
                                would stack on top of the name rather than sit before it. The state
                                line is indented to match by the stylesheet, so the two lines read
                                as one row. */}
                            <span className="au-menu-rule-head">
                                <span className="menu-icon">{AUTOMATION_ROW_ICON}</span>
                                <span className="au-menu-rule-name">{view.name}</span>
                            </span>
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
                        {newAutomationLabel(terminalId)}
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
                                        void addTerminalToRule(rule.id, terminalId, rule.name);
                                    }}
                                    title={`Add this terminal to “${rule.name}”`}
                                >
                                    {/* Same head wrapper as an armed row above, for the same
                                        column-layout reason — and the same icon, because these are
                                        the same kind of thing: a rule, offered by name. */}
                                    <span className="au-menu-rule-head">
                                        <span className="menu-icon">{AUTOMATION_ROW_ICON}</span>
                                        <span className="au-menu-rule-name">{rule.name}</span>
                                    </span>
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
            icon: AUTOMATION_ROW_ICON,
            title: `Add this terminal to “${rule.name}” and save.`,
            onSelect: () => { void addTerminalToRule(rule.id, terminalId, rule.name); },
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
                icon: AUTOMATION_ROW_ICON,
                // The state pill's words, in the dimmed right-hand column: the flyout's rows are
                // one line, and this is the half the accordion prints underneath the name.
                detail: view.stateLabel,
                title: `${view.name} — ${view.stateLabel}. Opens this rule for editing.`,
                onSelect: () => openAutomationEditorFor(view.ruleId),
                // §4.5, and the behaviour the flat rows already had, when each rule was a plain
                // menu item. Said per row because the flyout's own default is to keep the menu up,
                // and a row that opens an editor and leaves the menu behind it has left a live
                // outside-click trap over the surface it just opened.
                //
                // The ORDER here is the opposite of the accordion's, and both are deliberate:
                // `ContextMenu.activate` runs `onSelect` first with the dismissal in a `finally`.
                // This comment used to claim it dismissed first and call that "the same close,
                // then open" the accordion states — it never did, and after the measurement in
                // `closeMenuOnSelect`'s own note it must not: closing first fires the host's
                // terminal refocus in the gap before the editor mounts. Read that field before
                // touching either side.
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
                    label: newAutomationLabel(terminalId),
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
