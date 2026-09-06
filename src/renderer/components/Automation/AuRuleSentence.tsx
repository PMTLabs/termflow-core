/**
 * The rule as one sentence, rendered — **one implementation, two surfaces**.
 *
 * `describeRule` has always been the single source of the WORDS (§1.1: two surfaces on one screen
 * must not make opposite claims about one rule), but the markup around them was written twice: the
 * Settings list row and the template gallery's card each spread the `RuleSentence` fields out field
 * by field. A returned field nobody reads is invisible to `tsc`, so when §6.2 added `waitClause` the
 * row picked it up and the gallery silently did not — the same rule, described two ways, one screen
 * apart. `two-implementations-one-fix`: the fix is not to add the field in the second place, it is
 * to stop there being a second place, while exactly one field is missing and the merge is cheap.
 *
 * The one thing the two surfaces genuinely disagree about is the LINE BREAK — a card stacks the
 * condition over the send, a row runs on — so that is an argument, and it is the only one.
 */
import React from 'react';
import type { RuleSentence } from './automationDerive';

export interface AuRuleSentenceProps {
    sentence: RuleSentence;
    /**
     * Break the line before the send. The gallery card is a narrow box and stacks the two halves;
     * the list row has the width to run on.
     */
    stacked?: boolean;
}

export const AuRuleSentence: React.FC<AuRuleSentenceProps> = ({ sentence, stacked = false }) => (
    <>
        {sentence.lead} <b>{sentence.subject}</b>
        {sentence.verb && (
            <>
                {' '}
                <span className="au-arrow">{sentence.verb}</span> <b>{sentence.detail}</b>
            </>
        )}
        {sentence.waitClause && (
            <>
                {' '}
                <span className="au-arrow">→</span> {sentence.waitClause}
            </>
        )}
        {stacked ? <br /> : ' '}
        <span className="au-arrow">→</span> {sentence.verbSend}{' '}
        <span className="au-msg">&quot;{sentence.message}&quot;</span>
        {sentence.sendNote && <span className="au-arrow">{sentence.sendNote}</span>}
    </>
);
