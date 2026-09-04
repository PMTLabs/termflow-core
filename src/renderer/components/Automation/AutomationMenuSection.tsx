import React, { useState } from 'react';
import { getArmedAutomations, useArmedAutomations } from '../../services/automationArmed';
import { openAutomationEditorFor } from '../../services/automationEditorHost';
import { armedEntryViews, armedMenuLabel } from './automationArmedSummary';
import './automationSurfaces.css';
// Type-only, so no part of `Terminal/ContextMenu` — least of all its stylesheet — is pulled into
// `PaneContextMenu` or `CanvasNodeMenu`, which import this module for the component above and have
// their own menu implementation. Erased at compile time.
import type { ContextMenuFlyoutRow, ContextMenuItem } from '../Terminal/ContextMenu';

/**
 * The `Automation ▸` section of a terminal's context menu (`plan/028` item D).
 *
 * Tam: *"when user right click on pane/terminal, if there is an automation rule armed, then show
 * the Automation -> rules in sub-flyout-menu and user can click the rule to open the edit dialog to
 * edit. Apply the same for tab overlay in the Canvas mode, so ensure to have good shared code."*
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
 * **Renders nothing when nothing is armed**, per the ask ("if there is an automation rule armed").
 * That is the one case where hiding beats disabling here: the section is not an action on this
 * terminal that is temporarily unavailable, it is a list of rules that do not exist.
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
    // LIVE rather than read once when the menu opened: a rule can be switched on, complete, or stop
    // matching this terminal while the menu is up, and a row that outlives its rule opens an editor
    // on something the engine has already dropped. Same reasoning as `useSurfaceChromeAvailable`
    // in `PaneContextMenu`'s Find item.
    const armed = useArmedAutomations(terminalId);

    if (armed.length === 0) return null;

    // One clock for the whole section, so two rows cannot disagree about whether a fire was
    // "just now" — the same rule `AutomationsPanel` states for its list.
    const views = armedEntryViews(armed, Date.now());

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
 * **Zero or one item, never a parent over an empty panel.** The array is how "nothing is armed" is
 * said to a host that spreads: an `Automations ▸` row that opened onto nothing is the item that
 * looks live and does nothing, which is what `PaneContextMenu`'s Find item is documented as
 * refusing to be.
 *
 * Reads the store WITHOUT subscribing, deliberately: this menu is assembled when it opens, exactly
 * as `hasSelection` and the detected agent beside it are. `getSurfaceChrome`'s doc states the same
 * split — subscribe for what a surface DRAWS continuously, read once for what a click needs.
 */
export function automationMenuItems(terminalId: string | null): ContextMenuItem[] {
    if (!terminalId) return [];
    const armed = getArmedAutomations(terminalId);
    if (armed.length === 0) return [];
    // One clock for every row, so two of them cannot disagree about whether a fire was "just now"
    // — the rule `AutomationsPanel` states for its list, and the accordion above follows.
    const views = armedEntryViews(armed, Date.now());

    return [{
        label: armedMenuLabel(views.length),
        icon: '⚡',
        title: 'Automations watching this terminal. Pick one to open it for editing.',
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
            // Reachable ONLY by typing a query that matches nothing: the parent does not exist
            // when there is nothing armed, so "no automations at all" never renders here.
            emptyRow: (query: string): ContextMenuFlyoutRow => ({
                id: 'no-automation-matches',
                label: `No automations match '${query.trim()}'`,
                disabled: true,
            }),
        },
    }];
}

export default AutomationMenuSection;
