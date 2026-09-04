/**
 * *Read a value* — the five presets, the pattern, and the plain-words paraphrase (mockup §04, §07).
 *
 * R2's promise: *"five presets mean a percentage rule needs no pattern typed at all, and the pattern
 * is paraphrased in plain words."* Both halves come from `automationPresets`, and the paraphrase is
 * derived from the pattern rather than stored beside it, so it cannot describe a pattern the engine
 * will not run.
 *
 * **The live preview is the dry run.** §04 promises the preview matches against real recent output;
 * the honest way to keep that promise is the Test button, which runs the *same evaluator the engine
 * does* against a chosen terminal. A second, renderer-side matcher over some other slice of output
 * would preview one thing and run another — which is the shape §04's own note is warning about.
 */
import React from 'react';
import type { AutomationKeep, AutomationParsePreset, DryRunReport } from '../../../types/electron';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import type { PanelModel } from '../automationDerive';
import { AUTOMATION_PRESETS, displayedPattern } from '../automationPresets';
import { AuField, AuHelp, AuRadio } from './AuFields';

export interface ParsePanelProps {
    draft: AutomationDraft;
    model: PanelModel;
    /** The last dry run, when there is one — the only real output this panel has seen. */
    report: DryRunReport | null;
    dispatch: (action: DraftAction) => void;
    onTest: () => void;
}

export const ParsePanel: React.FC<ParsePanelProps> = ({ draft, model, report, dispatch, onTest }) => {
    const { parse } = draft.rule.graph;
    const exact = parse.preset === 'exactWords';
    // A CONTROL BINDING — the input's `value`, not something this panel displays about the rule.
    const shown = displayedPattern(parse);
    // DISPLAYED, so it comes from the model like everything else this panel says out loud. It used
    // to be this component's own `sayPattern(parse.find, parse.keep)` call.
    const saying = model.saying;
    const parseStep = report?.steps.find((s) => s.kind === 'parse') ?? null;
    const bracketProblem = model.problems.find((p) => p.code === 'parse.noBrackets');

    return (
        <>
            <AuField label="What are you looking for">
                <div className="au-tokens">
                    {AUTOMATION_PRESETS.map((preset) => (
                        <button
                            type="button"
                            key={preset.id}
                            className={`au-token${parse.preset === preset.id ? ' on' : ''}`}
                            aria-pressed={parse.preset === preset.id}
                            title={preset.hint}
                            onClick={() =>
                                dispatch({
                                    type: 'preset',
                                    preset: preset.id as AutomationParsePreset,
                                })}
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>
            </AuField>

            <AuField label={exact ? 'Words to look for' : 'Find text matching'}>
                <input
                    className={`au-finput${model.problems.some((p) => p.severity === 'blocks') ? ' err' : ''}`}
                    aria-label={exact ? 'Words to look for' : 'Find text matching'}
                    placeholder={exact ? 'e.g. Do you want to proceed?' : 'e.g. ctx:(\\d+)%'}
                    value={shown}
                    onChange={(e) =>
                        dispatch(
                            exact
                                ? { type: 'literal', literal: e.target.value }
                                : { type: 'find', find: e.target.value },
                        )}
                />
                {exact ? (
                    <AuHelp>
                        Type the words exactly as they appear. Punctuation is escaped for you, so
                        this field always shows what you typed — never the escaped form.
                    </AuHelp>
                ) : (
                    <>
                        {saying ? (
                            <div className="au-plainsay">
                                In plain words:{' '}
                                {saying.words.map((seg, i) =>
                                    seg.t === 'code' ? (
                                        // eslint-disable-next-line react/no-array-index-key
                                        <code key={i}>{seg.text}</code>
                                    ) : (
                                        // eslint-disable-next-line react/no-array-index-key
                                        <React.Fragment key={i}>{seg.text}</React.Fragment>
                                    ))}
                                {saying.example && (
                                    <>
                                        {' '}
                                        Matches lines like <code>{saying.example}</code>.
                                    </>
                                )}
                            </div>
                        ) : (
                            parse.find.trim().length > 0 && (
                                <div className="au-plainsay">
                                    This pattern is more than plain words can describe. It runs
                                    exactly as written: <code>{model.values.find.text}</code>
                                </div>
                            )
                        )}
                        <AuHelp>
                            Presets fill this in for you. The round brackets mark the part that is
                            kept.
                        </AuHelp>
                    </>
                )}
            </AuField>

            <AuField label="Keep">
                <AuRadio
                    name="au-keep"
                    on={parse.keep === 'brackets'}
                    title="The number in brackets"
                    sub={parse.keep === 'brackets' && !bracketProblem ? 'Turns 63 into a number you can compare' : undefined}
                    warn={bracketProblem ? 'Once you add a pattern, it needs round brackets around the part to keep.' : undefined}
                    onPick={() => dispatch({ type: 'keep', keep: 'brackets' as AutomationKeep })}
                />
                <AuRadio
                    name="au-keep"
                    on={parse.keep === 'whole'}
                    title="The whole matched text"
                    onPick={() => dispatch({ type: 'keep', keep: 'whole' as AutomationKeep })}
                />
            </AuField>

            <AuField label="Live preview">
                <div className="au-preview">
                    {parseStep ? (
                        <span className={parseStep.status === 'ok' ? 'au-hit' : 'au-dim'}>
                            {parseStep.detail}
                        </span>
                    ) : (
                        <span className="au-dim">Nothing to match yet.</span>
                    )}
                </div>
                <AuHelp>
                    <button type="button" className="au-btn sm" onClick={onTest}>
                        ▶ Test against a terminal
                    </button>{' '}
                    reads that terminal&apos;s recent output through the same evaluator the engine
                    uses. Colour codes are removed before matching, so a pattern never has to know
                    about them.
                </AuHelp>
            </AuField>
        </>
    );
};
