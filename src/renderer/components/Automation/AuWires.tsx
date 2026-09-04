/**
 * The wires, and the chips that ride on them (mockup §03).
 *
 * *"n8n makes you open a step to see what it passes. Here the value rides on the wire:
 * `"ctx:63%"` → `63` → `yes`. Data flow and direction of execution end up being the same drawing."*
 *
 * The chip text is **derived from the draft**, like everything else the editor draws — so a wire can
 * never claim a value the rule would not produce. When the engine has a live value for this rule the
 * chip shows that instead, which is the one place the editor draws something that is not in the
 * draft, and it is labelled as live rather than blended in.
 */
import React from 'react';
import type { Wire } from './automationSteps';
import type { NodePos } from './automationDraft';
import { auWirePath, portAnchor, sideOf } from './automationDraft';
import type { PortSide } from './automationDraft';

export interface AuWiresProps {
    wires: Wire[];
    layout: Record<string, NodePos>;
    /** What each wire is carrying, keyed `${fromStep}.${fromPort}`. Missing = no chip. */
    chips: Record<string, string>;
    /** The wire being dragged right now, from an anchor to the pointer. */
    dragging: { from: NodePos; to: NodePos; fromSide: PortSide } | null;
    /**
     * Which edge each port sits on, from `portSides`. Passed in rather than computed here so that
     * this component and `AuNode` anchor to the same edge — the dot and the line are one decision.
     */
    sides: Record<string, PortSide>;
    onRemove: (wire: Wire) => void;
}

const key = (w: Wire) => `${w.from.step}.${w.from.port}->${w.to.step}.${w.to.port}`;

export const AuWires: React.FC<AuWiresProps> = ({ wires, layout, chips, dragging, sides, onRemove }) => (
    <>
        <svg className="au-wires" width="100%" height="100%" aria-hidden="true">
            <defs>
                <marker
                    id="au-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                >
                    <path d="M0,0 L10,5 L0,10 z" fill="#59606b" />
                </marker>
            </defs>
            {wires.map((wire) => {
                const fromSide = sideOf(sides, wire.from.step, wire.from.port);
                const toSide = sideOf(sides, wire.to.step, wire.to.port);
                const from = portAnchor(wire.from.step, wire.from.port, layout[wire.from.step], fromSide);
                const to = portAnchor(wire.to.step, wire.to.port, layout[wire.to.step], toSide);
                return (
                    <path
                        key={key(wire)}
                        className="au-wire"
                        d={auWirePath(from, to, fromSide, toSide)}
                        markerEnd="url(#au-arrow)"
                    />
                );
            })}
            {dragging && (
                // A wire being dragged has a real source side and no target yet, so it enters the
                // pointer from whichever side the pointer is on. Without that the preview kinks
                // backwards the moment you drag left of the card you started from.
                <path
                    className="au-wire dragging"
                    d={auWirePath(
                        dragging.from,
                        dragging.to,
                        dragging.fromSide,
                        dragging.to.x >= dragging.from.x ? 'l' : 'r',
                    )}
                />
            )}
        </svg>

        {wires.map((wire) => {
            const from = portAnchor(
                wire.from.step, wire.from.port, layout[wire.from.step],
                sideOf(sides, wire.from.step, wire.from.port),
            );
            const to = portAnchor(
                wire.to.step, wire.to.port, layout[wire.to.step],
                sideOf(sides, wire.to.step, wire.to.port),
            );
            const chip = chips[`${wire.from.step}.${wire.from.port}`];
            return (
                <button
                    type="button"
                    key={key(wire)}
                    className="au-chip"
                    style={{ left: (from.x + to.x) / 2, top: (from.y + to.y) / 2 }}
                    // The chip is the wire's own affordance: it is the only part of a wire big
                    // enough to hit, and a wire with nothing to carry still gets one so that every
                    // wire can be removed the same way.
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove(wire);
                    }}
                    title="Remove this connection"
                >
                    {chip ?? '·'}
                </button>
            );
        })}
    </>
);
