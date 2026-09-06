/**
 * The left rail: the four steps you can drag on, and what this rule currently says (mockup §03).
 *
 * The *This rule* summary is `ruleSummary(draft.rule)` — derived, like everything else — so the rail
 * cannot summarise a rule the canvas is not drawing.
 */
import React from 'react';
import type { StepKind, TimerShape } from './automationSteps';
import { STEP_LABELS, STEP_ORDER, STEP_SUBTITLES, canAddStep } from './automationSteps';
import { STEP_GLYPHS } from './AuNode';

export interface AuPaletteProps {
    present: readonly StepKind[];
    /**
     * Which mode the rule's wait step is in, from `timerShapeOf` — the one thing `canAddStep` needs
     * that the step NAMES cannot tell it. Passed rather than read here, so the palette keeps
     * knowing nothing about the DTO and `canAddStep` stays testable as a table.
     */
    timerShape: TimerShape;
    summary: string;
    onBeginDrag: (step: StepKind, e: React.PointerEvent) => void;
    /** Keyboard equivalent of the drag — a palette that only answers to a pointer is unreachable. */
    onAdd: (step: StepKind) => void;
}

export const AuPalette: React.FC<AuPaletteProps> = ({
    present,
    timerShape,
    summary,
    onBeginDrag,
    onAdd,
}) => (
    <div className="au-palette">
        <div className="au-palhead">Steps</div>
        <div className="au-palhint">
            Drag onto the canvas to add. Steps only connect in an order that makes sense.
        </div>
        <div className="au-palitems">
            {STEP_ORDER.map((step) => {
                const refusal = canAddStep(present, step, timerShape);
                return (
                    <button
                        type="button"
                        key={step}
                        className={`au-palitem ${step}${refusal ? ' spent' : ''}`}
                        // Disabled would take it out of the tab order, and the reason is the
                        // interesting part — §07's own lesson about a control that refuses without
                        // saying why. It stays focusable and explains itself instead.
                        aria-disabled={refusal !== null}
                        title={refusal?.reason ?? `Add ${STEP_LABELS[step]}`}
                        // `canAddStep` above decides how this LOOKS. It does not decide whether the
                        // add happens: both routes call through to the editor's one `onAdd`, which
                        // is where the refusal is made and reported. A gate in one of two callers
                        // is a gate the other opts out of by existing
                        // (`gate-in-the-caller-lets-new-callers-opt-out`) — and that is exactly what
                        // happened here: the DRAG asked, the CLICK on the same item did not, so
                        // clicking *Compare it* on an empty canvas added it with nothing to compare.
                        onPointerDown={(e) => onBeginDrag(step, e)}
                        onClick={() => onAdd(step)}
                    >
                        <span className="au-palico" aria-hidden="true">
                            {STEP_GLYPHS[step]}
                        </span>
                        <span className="au-paltext">
                            <span className="au-paltitle">{STEP_LABELS[step]}</span>
                            <span className="au-palsub">{STEP_SUBTITLES[step]}</span>
                        </span>
                    </button>
                );
            })}
        </div>

        <div className="au-paldiv" />
        <div className="au-palhead">This rule</div>
        <div className="au-palhint au-palsummary">{summary}</div>
    </div>
);
