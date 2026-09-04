/**
 * *Send to terminal* — the message, whether to press Enter, and who receives it (mockup §04).
 *
 * **`submit` is load-bearing, not cosmetic.** The *Answer a confirmation* template types `1` and
 * must NOT press Enter — a send path that always submits breaks that one template while every other
 * still passes, which is exactly the shape a test suite misses.
 */
import React from 'react';
import type { AutomationSendTo } from '../../../types/electron';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import type { PanelModel } from '../automationDerive';
import { SEND_PHRASES } from '../automationDerive';
import { AuField, AuRadio } from './AuFields';


export interface ActionPanelProps {
    draft: AutomationDraft;
    model: PanelModel;
    dispatch: (action: DraftAction) => void;
}

export const ActionPanel: React.FC<ActionPanelProps> = ({ draft, model, dispatch }) => {
    const { action } = draft.rule.graph;

    return (
        <>
            <AuField label="Message">
                <input
                    className={`au-finput${model.values.message.missing ? ' err' : ''}`}
                    aria-label="Message to send"
                    placeholder="e.g. prepare to do context-hand-off"
                    value={action.message}
                    onChange={(e) => dispatch({ type: 'action', patch: { message: e.target.value } })}
                />
            </AuField>

            <AuField label="How to send it">
                <AuRadio
                    name="au-submit"
                    on={action.submit}
                    title="Type it and press Enter"
                    sub="Lands on the terminal's prompt and runs"
                    onPick={() => dispatch({ type: 'action', patch: { submit: true } })}
                />
                <AuRadio
                    name="au-submit"
                    on={!action.submit}
                    title="Type it, don't press Enter"
                    sub="Leaves it on the prompt for you to confirm"
                    onPick={() => dispatch({ type: 'action', patch: { submit: false } })}
                />
            </AuField>

            <AuField label="Send to">
                <AuRadio
                    name="au-sendto"
                    on={action.sendTo === 'matched'}
                    title="The terminal that matched"
                    sub="Each watched terminal keeps its own re-arm state"
                    onPick={() =>
                        dispatch({ type: 'action', patch: { sendTo: 'matched' as AutomationSendTo } })}
                />
                <AuRadio
                    name="au-sendto"
                    on={action.sendTo === 'all'}
                    title="Every watched terminal"
                    onPick={() =>
                        dispatch({ type: 'action', patch: { sendTo: 'all' as AutomationSendTo } })}
                />
            </AuField>

            <AuField label="Preview">
                <div className="au-preview">
                    &gt; <span className="au-cap">{model.values.message.text}</span>
                    {/* From the MODEL, like the message beside it. `stepValues(rule,'action').send`
                        exists for exactly this fact, and a panel reading `action.submit` directly
                        for something it draws is the shape `automationDerive` is here to keep out —
                        one renderer describing the rule from a second source. */}
                    {model.values.send.text === SEND_PHRASES.submit && (
                        <span className="au-enter">⏎</span>
                    )}
                </div>
            </AuField>
        </>
    );
};
