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
import { auWirePath, portAnchor } from './automationDraft';

export interface AuWiresProps {
    wires: Wire[];
    layout: Record<string, NodePos>;
    /** What each wire is carrying, keyed `${fromStep}.${fromPort}`. Missing = no chip. */
    chips: Record<string, string>;
    /** The wire being dragged right now, from an anchor to the pointer. */
    dragging: { from: NodePos; to: NodePos } | null;
    onRemove: (wire: Wire) => void;
}

const key = (w: Wire) => `${w.from.step}.${w.from.port}->${w.to.step}.${w.to.port}`;

export const AuWires: React.FC<AuWiresProps> = ({ wires, layout, chips, dragging, onRemove }) => (
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
                const from = portAnchor(wire.from.step, wire.from.port, layout[wire.from.step]);
                const to = portAnchor(wire.to.step, wire.to.port, layout[wire.to.step]);
                return (
                    <path
                        key={key(wire)}
                        className="au-wire"
                        d={auWirePath(from, to)}
                        markerEnd="url(#au-arrow)"
                    />
                );
            })}
            {dragging && (
                <path className="au-wire dragging" d={auWirePath(dragging.from, dragging.to)} />
            )}
        </svg>

        {wires.map((wire) => {
            const from = portAnchor(wire.from.step, wire.from.port, layout[wire.from.step]);
            const to = portAnchor(wire.to.step, wire.to.port, layout[wire.to.step]);
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
