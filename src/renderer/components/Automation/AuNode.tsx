/**
 * One step, as a card on the editor's canvas (mockup §03, §07).
 *
 * **Not `CanvasNode`.** That component's own header says its structure is permanent *because it
 * hosts a live PTY*: unmounting relocates `term.element` and SIGWINCHes every ratatui process behind
 * it. This card holds text. It has no level-of-detail ladder, no never-unmount contract and no
 * terminal, and borrowing the one that does would have brought all three along for nothing.
 *
 * Everything it draws comes from `automationDerive` — the same record the inspector panel reads, so
 * the two cannot describe different rules.
 */
import React from 'react';
import type { NodeFace, NodeState } from './automationDerive';
import type { PortRef, StepKind } from './automationSteps';
import { STEP_PORTS } from './automationSteps';
import { AU_NODE_H, AU_NODE_W } from './automationDraft';

/** The four accents, from the mockup's own palette. */
export const STEP_GLYPHS: Record<StepKind, string> = {
    monitor: '◉',
    parse: '⌥',
    cond: '◆',
    action: '▶',
};

export interface AuNodeProps {
    step: StepKind;
    x: number;
    y: number;
    face: NodeFace;
    state: NodeState;
    selected: boolean;
    /** Which of this node's ports is a legal target for the wire currently being dragged. */
    dropPorts?: ReadonlySet<string>;
    onSelect: () => void;
    onPointerDown: (e: React.PointerEvent) => void;
    onPortPointerDown: (port: PortRef, e: React.PointerEvent) => void;
    onPortPointerUp: (port: PortRef, e: React.PointerEvent) => void;
}

export const AuNode: React.FC<AuNodeProps> = ({
    step,
    x,
    y,
    face,
    state,
    selected,
    dropPorts,
    onSelect,
    onPointerDown,
    onPortPointerDown,
    onPortPointerUp,
}) => (
    <div
        className={`au-node ${step}${selected ? ' on' : ''}${state.tone === 'error' ? ' invalid' : ''}`}
        style={{ left: x, top: y, width: AU_NODE_W, height: AU_NODE_H }}
        data-step={step}
        role="group"
        aria-label={`${face.title} step`}
        onPointerDown={onPointerDown}
        onClick={onSelect}
    >
        <span className="au-nrail" aria-hidden="true" />
        <div className="au-nhead">
            <span className="au-nico" aria-hidden="true">
                {STEP_GLYPHS[step]}
            </span>
            <span className="au-ntitle">{face.title}</span>
            <span className={`au-nstate ${state.tone}`} title={state.title} aria-label={state.title} />
        </div>
        <div className="au-nbody">
            {face.rows.map((row) => (
                <div className="au-nrow" key={row.label}>
                    <span className="au-nlabel">{row.label}</span>
                    <span className={`au-nval${row.value.missing ? ' warn' : ''}`} title={row.value.text}>
                        {row.value.text}
                    </span>
                </div>
            ))}
        </div>
        {face.foot !== null && (
            <div className="au-nfoot">
                <span className={`au-nbadge ${face.footTone ?? ''}`}>{face.foot}</span>
            </div>
        )}

        {STEP_PORTS[step].map((port, _index, all) => {
            // Spread down the node's edge in the same arithmetic `portAnchor` uses, so the dot the
            // user sees and the point a wire is drawn to are one number, not two that agree today.
            const side = all.filter((p) => p.dir === port.dir);
            const offset = (AU_NODE_H * (side.indexOf(port) + 1)) / (side.length + 1);
            const droppable = dropPorts?.has(port.id) ?? false;
            return (
                <button
                    type="button"
                    key={port.id}
                    className={`au-port ${port.dir}${droppable ? ' droppable' : ''}`}
                    style={{ top: offset }}
                    // The dots are the drag handles for wires; a pointerdown here must not also
                    // start a node drag, and a pointerup here is a drop rather than a click.
                    onPointerDown={(e) => {
                        e.stopPropagation();
                        onPortPointerDown({ step, port: port.id }, e);
                    }}
                    onPointerUp={(e) => {
                        e.stopPropagation();
                        onPortPointerUp({ step, port: port.id }, e);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`${face.title} ${port.dir === 'in' ? 'input' : 'output'}: ${port.label}`}
                >
                    <span className="au-portlabel" aria-hidden="true">
                        {port.label}
                    </span>
                </button>
            );
        })}
    </div>
);
