/**
 * *Send to terminal* — the message, whether to press Enter, and who receives it (mockup §04).
 *
 * **`submit` is load-bearing, not cosmetic.** The *Answer a confirmation* template types `1` and
 * must NOT press Enter — a send path that always submits breaks that one template while every other
 * still passes, which is exactly the shape a test suite misses.
 *
 * **Task 7 adds the substitute checkbox, the token chips, and a live preview** (plan 032 §4.2,
 * mockup §04's *"Using what you read"*). `ActionStep.substitute` is opt-in — `awk '{print $1}'`
 * is a message somebody may already have written, and substituting by default would rewrite it
 * silently — so this panel is what turns it on, shows which tokens the pattern can supply, and
 * previews the result **before** a save, using the same grammar `automationValidation.ts` blocks a
 * save against. Nothing here re-derives that grammar: `groupsOf` says which groups exist,
 * `previewSubstitute` (built on the SAME scanner `tokensUsed` uses) says whether the message's
 * tokens are all in range and, if so, what they resolve to.
 */
import React from 'react';
import type { AutomationKeep, AutomationSendTo } from '../../../types/electron';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import type { PanelModel } from '../automationDerive';
import { SEND_PHRASES } from '../automationDerive';
import { compilePattern, groupsOf } from '../automationValidation';
import { previewSubstitute } from '../automationTokens';
import { sayPattern } from '../automationPresets';
import { AuCheck, AuField, AuHelp, AuRadio } from './AuFields';

export interface ActionPanelProps {
    draft: AutomationDraft;
    model: PanelModel;
    dispatch: (action: DraftAction) => void;
    /**
     * A worked example's captured values for the live preview below — keyed the way `groupsOf`
     * reports groups: a numbered group by its number as a string (`'0'`, `'1'`, …), a named one by
     * its name. Optional: with none given, the panel derives one itself from the pattern's own
     * worked example (`sayPattern`'s `example`, the same string *Read a value* already shows under
     * "Matches lines like …"), so the preview has something honest to resolve against before a real
     * dry run has ever been made. Tests pass a literal sample to pin exact values.
     */
    sample?: Record<string, string>;
}

type ChipInfo = { text: string; dead: boolean };

/**
 * A default sample, when the caller does not supply one: run the pattern's OWN worked example back
 * through the SAME pattern. Never invents a value beyond what `ParsePanel` already shows the user
 * for this rule, so the two panels cannot disagree about what a match here would look like.
 */
function sampleFromPattern(find: string, keep: AutomationKeep): Record<string, string> {
    const re = compilePattern(find);
    if (!re) return {};
    const worked = sayPattern(find, keep)?.example ?? null;
    const m = worked ? re.exec(worked) : null;
    if (!m) return {};
    const out: Record<string, string> = {};
    m.forEach((g, i) => {
        if (g !== undefined) out[String(i)] = g;
    });
    if (m.groups) {
        for (const [k, v] of Object.entries(m.groups)) {
            if (v !== undefined) out[k] = v;
        }
    }
    return out;
}

export const ActionPanel: React.FC<ActionPanelProps> = ({ draft, model, dispatch, sample }) => {
    const { parse, action } = draft.rule.graph;
    const messageRef = React.useRef<HTMLInputElement | null>(null);

    const compiled = compilePattern(parse.find);
    const patternReady = compiled !== null && parse.find.trim().length > 0;
    const groups = patternReady ? groupsOf(parse.find) : { count: 0, names: new Set<string>() };
    const effectiveSample = sample ?? sampleFromPattern(parse.find, parse.keep);
    const substitute = action.substitute === true;

    const preview = !substitute
        ? { blocked: false as const, text: action.message }
        : !patternReady
            ? {
                blocked: true as const,
                text: 'Nothing would be sent — there is no pattern yet to capture values from.',
            }
            : (() => {
                const result = previewSubstitute(action.message, groups, effectiveSample);
                return result.ok
                    ? { blocked: false as const, text: result.text }
                    : {
                        blocked: true as const,
                        text: `Nothing would be sent — ${result.badToken} has nothing to stand for.`,
                    };
            })();

    // One chip per group the pattern declares, plus $0 (the whole match) and $$ (the escape), plus
    // ONE extra chip past the last real group — marked `.dead` — so the boundary itself is visible
    // rather than merely implied by the live chips stopping (mockup §04).
    const chips: ChipInfo[] = [
        { text: '$0', dead: !patternReady },
        ...Array.from({ length: groups.count }, (_, i): ChipInfo => ({ text: `$${i + 1}`, dead: false })),
        { text: `$${groups.count + 1}`, dead: true },
        { text: '$$', dead: false },
    ];

    function insertToken(token: string) {
        const el = messageRef.current;
        const value = action.message;
        const start = el?.selectionStart ?? value.length;
        const end = el?.selectionEnd ?? value.length;
        const next = value.slice(0, start) + token + value.slice(end);
        dispatch({ type: 'action', patch: { message: next } });
        const restoreCaret = () => {
            const input = messageRef.current;
            if (!input) return;
            const pos = start + token.length;
            input.focus();
            input.setSelectionRange(pos, pos);
        };
        // Best-effort only: restoring the caret is a convenience for the NEXT keystroke, not
        // something any assertion depends on, so an environment without rAF just runs it inline.
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restoreCaret);
        else restoreCaret();
    }

    return (
        <>
            <AuField label="Message">
                <input
                    ref={messageRef}
                    className={`au-finput${model.values.message.missing ? ' err' : ''}`}
                    aria-label="Message to send"
                    placeholder="e.g. prepare to do context-hand-off"
                    value={action.message}
                    onChange={(e) => dispatch({ type: 'action', patch: { message: e.target.value } })}
                />
                <div className="au-tokens" aria-label="Available tokens">
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
                <AuHelp>
                    Click a token to insert it. <code>$$</code> types a real dollar sign.
                </AuHelp>
            </AuField>

            <AuCheck
                on={substitute}
                label="Insert captured values"
                sub={
                    "Off for every rule that already existed. With it off, $1 types as the literal "
                    + "characters $1 — the same message a script like awk '{print $1}' already expects."
                }
                onToggle={() => dispatch({ type: 'action', patch: { substitute: !substitute } })}
            />

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
                <div
                    className={`au-preview${preview.blocked ? ' blocked' : ''}`}
                    data-testid="action-preview"
                >
                    {preview.blocked ? (
                        <span>{preview.text}</span>
                    ) : (
                        <>
                            &gt; <span className="au-cap">{preview.text}</span>
                            {/* From the MODEL, like the message beside it. `stepValues(rule,'action').send`
                                exists for exactly this fact, and a panel reading `action.submit` directly
                                for something it draws is the shape `automationDerive` is here to keep out —
                                one renderer describing the rule from a second source. */}
                            {model.values.send.text === SEND_PHRASES.submit && (
                                <span className="au-enter">⏎</span>
                            )}
                        </>
                    )}
                </div>
            </AuField>
        </>
    );
};
