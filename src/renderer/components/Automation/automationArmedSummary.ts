/**
 * The words every "this terminal is automated" surface says (`plan/028` item D).
 *
 * Four surfaces show the same fact — the tab strip, the pane title, the pane context menu and
 * Canvas Mode — and Tam asked for shared code across them by name. This is the half that is pure:
 * given the armed entries, what is written. `AutomationArmedBadge` renders it and the two context
 * menus list it, so a rule cannot be called one thing on a pane header and another eight pixels
 * away in the menu that opens from it — the failure `automationState.ts`'s own header describes
 * from the mockup's rev 1.
 *
 * **Nothing here invents vocabulary.** The state words come from `automationRowState`, the same
 * function the Settings list and the editor header use, indexed down to the ONE terminal being
 * described. A pane says *Armed · waiting* because that is what the rule's row says about it, not
 * because this module has an opinion.
 */
import type { ArmedAutomation } from '../../services/automationArmed';
import { automationRowState } from '../Settings/Automations/automationState';

/** One rule's line, in a menu or a tooltip. */
export interface ArmedEntryView {
    ruleId: string;
    /** The rule's own name. */
    name: string;
    /** *Armed · waiting*, *Just fired*, … — this terminal's state, not the rule's across all of them. */
    stateLabel: string;
}

/**
 * One line per armed rule, in the order the store indexed them.
 *
 * The pair is wrapped in a single-entry record because `automationRowState` folds a rule's state
 * across every terminal it watches, and here exactly one of them is being described. Handing it the
 * whole rule's pairs would let a rule that is merely *armed* on this pane read *Error* because some
 * OTHER terminal it watches has gone missing — the same "evidence from outside the bucket" defect
 * that module's `everFired` doc already records one level down.
 */
export function armedEntryViews(armed: readonly ArmedAutomation[], now: number): ArmedEntryView[] {
    return armed.map((entry) => ({
        ruleId: entry.rule.id,
        name: entry.rule.name,
        stateLabel: automationRowState(entry.rule, { one: entry.pair }, now).pillText,
    }));
}

/**
 * The badge's `+N` — how many armed rules are NOT the one whose name is shown.
 *
 * `null` for one rule, because a `+0` is a control that appears only to say nothing. Tam asked for
 * a `+` "because there is tight space", and the count is carried with it: knowing there are two
 * more rules is the difference between opening the menu and not.
 */
export function armedOverflow(armed: readonly ArmedAutomation[]): string | null {
    return armed.length > 1 ? `+${armed.length - 1}` : null;
}

/**
 * The hover text, listing every armed rule and this terminal's state under each.
 *
 * The tooltip is where the `+N` is cashed in — it is the only place a pane can name the rules it
 * has no room to print, and it is why the badge carries a `title` rather than relying on the menu.
 */
export function armedTitle(armed: readonly ArmedAutomation[], now: number): string {
    const views = armedEntryViews(armed, now);
    if (views.length === 0) return '';
    const head = views.length === 1
        ? 'Automation armed on this terminal:'
        : `${views.length} automations armed on this terminal:`;
    return [head, ...views.map((view) => `• ${view.name} — ${view.stateLabel}`)].join('\n');
}

/**
 * The tab strip's hover text, which counts rather than names.
 *
 * A tab is armed when ANY of its terminals is, so its indicator answers a different question from a
 * pane's and must not borrow the pane's sentence: a split tab with one automated pane would
 * otherwise claim every terminal in it was being watched.
 */
export function armedTabTitle(count: number): string {
    return count === 1
        ? '1 automation is armed on a terminal in this tab'
        : `${count} automations are armed on terminals in this tab`;
}
