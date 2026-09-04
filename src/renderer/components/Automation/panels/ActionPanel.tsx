/**
 * *Send to terminal* — the message, whether to press Enter, and who receives it (mockup §04).
 *
 * **`submit` is load-bearing, not cosmetic.** The *Answer a confirmation* template types `1` and
 * must NOT press Enter — a send path that always submits breaks that one template while every other
 * still passes, which is exactly the shape a test suite misses.
 */
import React, { useRef } from 'react';
import type { AutomationSendTo } from '../../../types/electron';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import type { PanelModel } from '../automationDerive';
import { AuField, AuHelp, AuRadio } from './AuFields';

/** The placeholders the engine substitutes at send time. Shown as buttons, inserted at the caret. */
const TOKENS = ['{value}', '{match}', '{terminal}', '{time}'];

export interface ActionPanelProps {
    draft: AutomationDraft;
    model: PanelModel;
    dispatch: (action: DraftAction) => void;
}

export const ActionPanel: React.FC<ActionPanelProps> = ({ draft, model, dispatch }) => {
    const { action } = draft.rule.graph;
    const inputRef = useRef<HTMLInputElement | null>(null);

    const insert = (token: string) => {
        const el = inputRef.current;
        // At the caret when there is one, at the end when there is not — never replacing the
        // message, which is what a naive `value + token` does the moment the field is focused
        // mid-word.
        const at = el && el.selectionStart !== null ? el.selectionStart : action.message.length;
        const next = action.message.slice(0, at) + token + action.message.slice(at);
        dispatch({ type: 'action', patch: { message: next } });
        window.requestAnimationFrame(() => {
            el?.focus();
            el?.setSelectionRange(at + token.length, at + token.length);
        });
    };

    return (
        <>
            <AuField label="Message">
                <input
                    ref={inputRef}
                    className={`au-finput${model.values.message.missing ? ' err' : ''}`}
                    aria-label="Message to send"
                    placeholder="e.g. prepare to do context-hand-off"
                    value={action.message}
                    onChange={(e) => dispatch({ type: 'action', patch: { message: e.target.value } })}
                />
                <AuHelp>Click to insert a value from an earlier step:</AuHelp>
                <div className="au-tokens">
                    {TOKENS.map((token) => (
                        <button
                            type="button"
                            key={token}
                            className="au-token"
                            onClick={() => insert(token)}
                        >
                            {token}
                        </button>
                    ))}
                </div>
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
                    {action.submit && <span className="au-enter">⏎</span>}
                </div>
            </AuField>
        </>
    );
};
