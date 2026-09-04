import React from 'react';
import type { ArmedAutomation } from '../../services/automationArmed';
import { useArmedAutomationCount, useArmedAutomations } from '../../services/automationArmed';
import { armedOverflow, armedTabTitle, armedTitle } from './automationArmedSummary';
import './automationSurfaces.css';

/**
 * The "this terminal is being watched" indicator (`plan/028` item D).
 *
 * ONE component for four surfaces — the pane title, the pane context menu's header, a Canvas node
 * and the tab strip — because Tam asked for shared code across them and because an indicator that
 * is redrawn per surface is an indicator that means something slightly different on each. It is the
 * `.au-tog` lesson from round 1 applied before the fact: one owner per decision.
 *
 * **Sizing is handed over, not copied.** Every sibling indicator in this app is sized by its own
 * host stylesheet — `.tab-canvas-here` is 11px, `.canvas-node-shell` is 9.5px — and a shared
 * component cannot pick one of those numbers without being wrong on the other surfaces. So the host
 * sets `--au-armed-size` and this stylesheet is the only place that reads it into a `font-size`.
 * The alternative, letting each host restate `.au-armed { font-size }`, is exactly how the toggle
 * knob ended up with two owners moving it at once.
 *
 * There are two exports rather than one because the tab asks a genuinely different question. A pane
 * names the rule watching IT; a tab reports that some terminal inside it is watched, and it takes a
 * COUNT rather than the entries so that the tab strip re-renders only when that number changes —
 * see `useArmedAutomationCount`.
 */

/**
 * The glyph, defined once.
 *
 * A bolt because the feature's verb is *fires*, and because every other per-terminal status in this
 * app is a labelled glyph rather than a colour: `⊘` exited, `◎` canvas here, `🔔` unseen. No state
 * in this app is signalled by colour alone (`automationState.ts`), and an indicator whose whole job
 * is to be noticed in 16 pixels of tab strip is the last place to start.
 */
const GLYPH = '⚡';

const AutomationArmedBadgeImpl: React.FC<{
    /** The rules armed on THIS terminal, from `useArmedAutomations`. */
    armed: readonly ArmedAutomation[];
    /**
     * Draw the glyph alone, with no rule name.
     *
     * REQUIRED at every call site rather than defaulted, because the two faces are not
     * interchangeable and the wrong one is not a visual nit: a name printed into a canvas chip —
     * where, per `CanvasNode`, "the header IS the node and there is room for a title and nothing
     * else" — pushes the title out of its own header.
     */
    compact: boolean;
}> = ({ armed, compact }) => {
    if (armed.length === 0) return null;

    const now = Date.now();
    const overflow = armedOverflow(armed);
    return (
        <span
            className={compact ? 'au-armed compact' : 'au-armed'}
            title={armedTitle(armed, now)}
            data-armed-count={armed.length}
        >
            <span className="au-armed-glyph" aria-hidden="true">{GLYPH}</span>
            {!compact && <span className="au-armed-label">{armed[0].rule.name}</span>}
            {/* The `+N` survives `compact`. Tam asked for it "because there is tight space", so the
                surface with the least space is the one that most needs to say there is more than
                one rule — dropping it there would answer the request backwards. */}
            {overflow && <span className="au-armed-more">{overflow}</span>}
        </span>
    );
};

/**
 * Memoised, and the props are why it can be.
 *
 * `armed` comes straight out of the store's index, whose identity is preserved across every
 * `automation:state` event that did not change this terminal's entries — so the equality check is
 * exact and it actually bails. Same trade, for the same reason, as `CanvasNodeAgent`: this renders
 * on every node of a canvas that re-renders on every frame of a pan.
 */
export const AutomationArmedBadge = React.memo(AutomationArmedBadgeImpl);

/**
 * The tab strip's face: the glyph and a count, never a rule name.
 *
 * A tab is armed when ANY terminal in it is, which is a different fact from a pane's and gets its
 * own sentence — `armedTabTitle`. Naming one of several rules on a tab that holds four terminals
 * would be picking one arbitrarily and printing it as though it described the tab.
 */
const AutomationArmedTabBadgeImpl: React.FC<{ count: number }> = ({ count }) => {
    if (count === 0) return null;
    return (
        <span className="au-armed compact tabstrip" title={armedTabTitle(count)}>
            <span className="au-armed-glyph" aria-hidden="true">{GLYPH}</span>
            {count > 1 && <span className="au-armed-more">{`+${count - 1}`}</span>}
        </span>
    );
};

export const AutomationArmedTabBadge = React.memo(AutomationArmedTabBadgeImpl);

const AutomationArmedForTerminalImpl: React.FC<{
    /** The pane's durable `tm-` leaf, or `null` for a pane with no terminal. */
    terminalId: string | null;
    compact: boolean;
}> = ({ terminalId, compact }) => (
    <AutomationArmedBadge armed={useArmedAutomations(terminalId)} compact={compact} />
);

/**
 * The badge, subscribing on its own behalf — for a host that has a terminal id and nothing else.
 *
 * MEMOISED, and for the same reason `CanvasNodeAgent` is: `CanvasNode` renders one of these per
 * node on a canvas that re-renders on every frame of a pan, and the props here are primitives, so
 * the equality check is exact and actually bails. Without it, every node's store subscription would
 * be re-run at pointer-event frequency for a value that changes at most once a second.
 */
export const AutomationArmedForTerminal = React.memo(AutomationArmedForTerminalImpl);

/**
 * The count badge, subscribing on its own behalf — for a host that owns a SET of terminals: a tab
 * in the strip, or its group frame on the canvas.
 *
 * Deliberately NOT memoised, unlike its sibling above. Its one prop is an array rebuilt by a tree
 * walk on every render of the host, so `React.memo` could never bail — it would be a slower render
 * wearing the word "memo", which is worse than none. The re-render is cheap because the SNAPSHOT is
 * a number: the subscription itself wakes nothing unless the count changes.
 */
export const AutomationArmedForTerminals: React.FC<{ terminalIds: readonly string[] }> = (
    { terminalIds },
) => <AutomationArmedTabBadge count={useArmedAutomationCount(terminalIds)} />;
