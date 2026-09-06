/**
 * The webhook destination inspector.
 *
 * The endpoint is a credential, not rule prose. It is bound only to a password input and becomes
 * visible only after this panel's explicit Reveal action. The request preview deliberately models
 * the BODY the sender posts, never the endpoint it posts to.
 */
import React from 'react';
import type { AutomationWebhookProvider } from '../../../types/electron';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import { compilePattern, groupsOf } from '../automationValidation';
import { previewSubstitute } from '../automationTokens';
import { sampleFromPattern } from './ActionPanel';
import { AuCheck, AuField, AuHelp } from './AuFields';

export interface WebhookPanelProps {
    draft: AutomationDraft;
    dispatch: (action: DraftAction) => void;
}

type ChipInfo = { text: string; dead: boolean };

const groupToken = (n: number): string => (n < 10 ? `$${n}` : `\${${n}}`);

/**
 * The renderer's mirror of `automation_webhook.rs`'s private `payload` function.
 *
 * Rust remains the sender authority. This shapes exactly its provider wrappers for an on-screen
 * body preview; Custom preserves the text verbatim just as the sender preserves its bytes.
 */
export function previewWebhookPayload(provider: AutomationWebhookProvider, message: string): string {
    switch (provider) {
        case 'discord':
            return JSON.stringify({ content: message });
        case 'slack':
            return JSON.stringify({ text: message });
        case 'teams':
            // serde_json's default map ordering writes these keys in this order too.
            return JSON.stringify({
                '@context': 'http://schema.org/extensions',
                '@type': 'MessageCard',
                text: message,
            });
        case 'custom':
            return message;
    }
}

export const WebhookPanel: React.FC<WebhookPanelProps> = ({ draft, dispatch }) => {
    const { parse, webhook } = draft.rule.graph;
    const bodyRef = React.useRef<HTMLTextAreaElement | null>(null);
    const [revealed, setRevealed] = React.useState(false);
    if (!webhook) return null;

    const find = parse?.find ?? '';
    const patternReady = compilePattern(find) !== null && find.trim().length > 0;
    const groups = patternReady ? groupsOf(find) : { count: 0, names: new Set<string>() };
    const substitute = webhook.substitute === true;
    const sample = parse ? sampleFromPattern(parse.find, parse.keep) : null;
    const rendered = substitute && patternReady
        ? previewSubstitute(webhook.body, groups, sample)
        : null;
    const previewMessage = rendered && rendered.ok
        ? rendered.parts.map((part) => part.kind === 'text' ? part.text : `⟨${part.token}⟩`).join('')
        : webhook.body;
    const blocked = substitute && (!patternReady || (rendered !== null && !rendered.ok));
    const blockedText = !patternReady
        ? 'Nothing would be posted — there is no pattern yet to capture values from.'
        : rendered && !rendered.ok
            ? `Nothing would be posted — ${rendered.badToken} has nothing to stand for.`
            : null;
    const preview = previewWebhookPayload(webhook.provider, previewMessage);
    const chips: ChipInfo[] = [
        { text: '$0', dead: !patternReady },
        ...Array.from({ length: groups.count }, (_, i): ChipInfo => ({ text: groupToken(i + 1), dead: false })),
        { text: groupToken(groups.count + 1), dead: true },
        { text: '$$', dead: false },
    ];
    const body = webhook.body;

    function insertToken(token: string) {
        const el = bodyRef.current;
        const value = body;
        const start = el?.selectionStart ?? value.length;
        const end = el?.selectionEnd ?? value.length;
        dispatch({ type: 'webhook', patch: { body: value.slice(0, start) + token + value.slice(end) } });
    }

    return (
        <>
            <AuField label="Provider">
                <select
                    className="au-finput"
                    aria-label="Webhook provider"
                    value={webhook.provider}
                    onChange={(e) => dispatch({
                        type: 'webhook',
                        patch: { provider: e.target.value as AutomationWebhookProvider },
                    })}
                >
                    <option value="discord">Discord</option>
                    <option value="slack">Slack</option>
                    <option value="teams">Microsoft Teams</option>
                    <option value="custom">Custom JSON</option>
                </select>
            </AuField>

            <AuField label="Webhook URL">
                <div className="au-frow">
                    <input
                        className="au-finput"
                        type={revealed ? 'text' : 'password'}
                        aria-label="Webhook URL"
                        autoComplete="off"
                        value={webhook.url}
                        onChange={(e) => dispatch({ type: 'webhook', patch: { url: e.target.value } })}
                    />
                    <button
                        className="au-mini"
                        type="button"
                        aria-label={revealed ? 'Hide webhook URL' : 'Reveal webhook URL'}
                        onClick={() => setRevealed((visible) => !visible)}
                    >
                        {revealed ? 'Hide' : 'Reveal'}
                    </button>
                </div>
                <AuHelp>
                    This URL is a password. Anyone holding it can post into that channel as this integration.
                </AuHelp>
            </AuField>

            <AuField label="Message">
                <textarea
                    ref={bodyRef}
                    className="au-finput"
                    aria-label="Webhook message"
                    value={webhook.body}
                    onChange={(e) => dispatch({ type: 'webhook', patch: { body: e.target.value } })}
                />
                <div className="au-tokens" aria-label="Available capture tokens">
                    {chips.map((chip) => (
                        <button
                            type="button"
                            key={chip.text}
                            className={`au-token${chip.dead ? ' dead' : ''}`}
                            title={chip.dead ? `${chip.text} has nothing to stand for yet` : undefined}
                            onClick={() => insertToken(chip.text)}
                        >
                            {chip.text}
                        </button>
                    ))}
                </div>
                <AuHelp>Click a token to insert it. <code>$$</code> writes a dollar sign.</AuHelp>
            </AuField>

            <AuCheck
                on={substitute}
                label="Insert captured values"
                sub="Off by default. With it off, capture tokens are posted as literal text."
                onToggle={() => dispatch({ type: 'webhook', patch: { substitute: !substitute } })}
            />

            <AuField label="Request body preview (URL masked)">
                <div className={`au-preview${blocked ? ' blocked' : ''}`} data-testid="webhook-preview">
                    {blocked ? blockedText : preview}
                </div>
            </AuField>
        </>
    );
};
