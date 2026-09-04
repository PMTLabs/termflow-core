import React, { useState } from 'react';
import { getArmedAutomations, useArmedAutomations } from '../../services/automationArmed';
import { openAutomationEditorFor } from '../../services/automationEditorHost';
import { armedEntryViews } from './automationArmedSummary';
import './automationSurfaces.css';

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
 * **An accordion, not a side flyout**, which is this app's settled answer for a menu section with
 * children: `TabContextMenu.css` says so in as many words for the Color Schema panel, and
 * `PaneContextMenu`'s own "Color scheme for …" item is built exactly this way. A hover-opening
 * flyout would need edge-aware positioning of its own in two menu systems that currently have none,
 * to show a list that is usually one row long.
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
                {views.length === 1 ? 'Automation' : `Automations (${views.length})`}
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

/** One row of the TERMINAL content menu, in the shape `Terminal/ContextMenu` takes. */
export interface AutomationContextMenuItem {
    label: string;
    icon: string;
    title: string;
    click: () => void;
}

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
 * once, above both. Only the layout differs — two lines in an accordion, one flat row here, because
 * that is all this menu can draw.
 *
 * A FLAT row per rule rather than a parent that opens a list: a menu with no submenu machinery
 * cannot nest, and an "Automations ▸" row that opened nothing would be the disabled-looking item
 * this repo keeps refusing to ship. There is usually one rule, and rules are named by their author.
 *
 * Reads the store WITHOUT subscribing, deliberately: this menu is assembled when it opens, exactly
 * as `hasSelection` and the detected agent beside it are. `getSurfaceChrome`'s doc states the same
 * split — subscribe for what a surface DRAWS continuously, read once for what a click needs.
 */
export function automationMenuItems(terminalId: string | null): AutomationContextMenuItem[] {
    if (!terminalId) return [];
    return armedEntryViews(getArmedAutomations(terminalId), Date.now()).map((view) => ({
        label: `Automation: ${view.name}`,
        icon: '⚡',
        title: `${view.stateLabel} — open this rule for editing.`,
        click: () => openAutomationEditorFor(view.ruleId),
    }));
}

export default AutomationMenuSection;
