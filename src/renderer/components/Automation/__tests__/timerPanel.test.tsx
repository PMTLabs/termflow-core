/**
 * @jest-environment jsdom
 *
 * **The Wait inspector** (plan 032 §6.2, §6.3, §9; mockup §03's third panel).
 *
 * Mounted through the real `AuInspector` rather than as a bare component, for the reason
 * `automationPanelsRender` gives one file over: the thing worth pinning is *what a panel puts on
 * screen*, and a panel that is never reached from the inspector's `step === …` chain puts nothing
 * on screen however well it renders in isolation.
 *
 * Two rules this file exists to hold:
 *
 * - **No bound is ever restated.** `MIN_DELAY_MS` and `MAX_DELAY_MS` live in `automationValidation`
 *   (mirroring `automation_validation.rs`), and the message the user reads is the validator's own.
 *   Every assertion here compares against `problems(rule)`'s output rather than against a sentence
 *   typed into the test, so a bound that moves on either side of the wire moves here too instead of
 *   turning this file into a second, stale copy of it.
 * - **"Wait", never "Timer".** `AutomationCadence`'s `'timer'` already means the monitor's poll
 *   interval. The last test in this file reads every string the panel renders and every
 *   `aria-label` it sets, so the collision cannot come back through a control nobody re-read.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AuInspector } from '../AuInspector';
import { draftFromRule } from '../automationDraft';
import type { DraftAction } from '../automationDraft';
import { MAX_DELAY_MS, MIN_DELAY_MS, problems } from '../automationValidation';
import { blankDraft } from '../../Settings/Automations/automationTemplates';
import type { AutomationRule, AutomationTimerMode } from '../../../types/electron';

/** Mon..Fri — bits 0–6 are Mon..Sun (plan 032 §3.1). */
const WEEKDAYS = 0b0001_1111;

const ruleWith = (mode: AutomationTimerMode): AutomationRule => {
    const rule = blankDraft();
    return {
        ...rule,
        graph: {
            ...rule.graph,
            parse: { preset: 'custom', literal: null, find: 'API error', keep: 'whole' },
            action: { ...rule.graph.action, message: 'resume' },
            timer: { mode },
        },
    };
};

const delayed = (delayMs: number) => ruleWith({ afterMatch: { delayMs } });
const scheduled = (minuteOfDay: number, days: number) => ruleWith({ dailyAt: { minuteOfDay, days } });

describe('the Wait inspector', () => {
    let container: HTMLDivElement;
    let root: Root;
    let sent: DraftAction[];

    beforeAll(() => {
        (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        sent = [];
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    async function show(rule: AutomationRule) {
        const draft = { ...draftFromRule(rule), selected: 'timer' as const };
        await act(async () => {
            root.render(
                <AuInspector
                    draft={draft}
                    problems={problems(rule)}
                    now={1_700_000_000_000}
                    terminals={[]}
                    terminalsError={null}
                    terminalsLoading={false}
                    report={null}
                    onRearm={null}
                    onTest={() => {}}
                    onFocusStep={() => {}}
                    dispatch={(a) => sent.push(a)}
                />,
            );
        });
    }

    const byLabel = <T extends HTMLElement>(label: string) =>
        container.querySelector<T>(`[aria-label="${label}"]`);
    const dayButtons = () =>
        [...(byLabel('Days of the week')?.querySelectorAll('button') ?? [])] as HTMLButtonElement[];
    const modeRadio = (title: string) =>
        [...container.querySelectorAll('label.au-radio')].find((l) => l.textContent?.startsWith(title))
            ?.querySelector('input') as HTMLInputElement | undefined;
    const sentence = () => container.querySelector('.au-plainsay')?.textContent ?? '';

    /** React owns `value`, so a controlled input is driven through the prototype setter. */
    const type = async (el: HTMLInputElement, text: string) => {
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value',
            )!.set!;
            setter.call(el, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };

    /** The one timer action the panel dispatches, or `undefined`. */
    const sentMode = (): AutomationTimerMode | undefined =>
        sent.find((a): a is { type: 'timer'; mode: AutomationTimerMode } => a.type === 'timer')?.mode;

    // ---------------------------------------------------------------------------------- the radio

    it('shows the wait length in delay mode and the clock controls in schedule mode', async () => {
        await show(delayed(30_000));
        expect(byLabel<HTMLInputElement>('How long to wait, in seconds')?.value).toBe('30');
        expect(byLabel('Time of day')).toBeNull();
        expect(byLabel('Days of the week')).toBeNull();

        await show(scheduled(9 * 60, WEEKDAYS));
        expect(byLabel<HTMLInputElement>('Time of day')?.value).toBe('09:00');
        expect(dayButtons().map((b) => b.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
        expect(byLabel('How long to wait, in seconds')).toBeNull();
    });

    it('marks the mode the rule is actually in', async () => {
        await show(delayed(30_000));
        expect(modeRadio('After the comparison passes')?.checked).toBe(true);
        expect(modeRadio('At a time of day')?.checked).toBe(false);

        await show(scheduled(9 * 60, WEEKDAYS));
        expect(modeRadio('At a time of day')?.checked).toBe(true);
        expect(modeRadio('After the comparison passes')?.checked).toBe(false);
    });

    /**
     * **The mode is REPLACED, never merged.**
     *
     * `AutomationTimerMode` is externally tagged — `{"afterMatch":{…}}` or `{"dailyAt":{…}}` — and
     * Rust's `TimerMode` is an enum, so a mode object carrying both keys is not a rule with a
     * leftover field in it: it is a blob `serde_json` refuses, on a save that reports success. A
     * radio that spread the previous mode instead of replacing it would produce exactly that, and
     * every other assertion in this file would still pass, because the key the panel reads is the
     * one it just wrote.
     */
    it('replaces the whole mode when the radio changes, leaving no key of the old one behind', async () => {
        await show(delayed(30_000));
        await act(async () => {
            modeRadio('At a time of day')!.click();
        });
        const toSchedule = sentMode();
        expect(Object.keys(toSchedule ?? {})).toEqual(['dailyAt']);

        sent = [];
        await show(scheduled(9 * 60, WEEKDAYS));
        await act(async () => {
            modeRadio('After the comparison passes')!.click();
        });
        expect(Object.keys(sentMode() ?? {})).toEqual(['afterMatch']);
    });

    // ------------------------------------------------------------------------------- the bounds

    /**
     * The blocking message, **as the validator words it**. Compared against `problems()`'s own
     * output: a literal sentence here would be a third copy of a bound that already lives in two
     * places, and it would still pass on the day the bound moved and the copy did not.
     */
    it.each([
        ['under the floor', MIN_DELAY_MS - 1, 'timer.delayTooShort'],
        ['at the cap', MAX_DELAY_MS, 'timer.delayTooLong'],
    ])('refuses a wait %s, in the validator\'s own words', async (_name, delayMs, code) => {
        const rule = delayed(delayMs);
        const expected = problems(rule).find((p) => p.code === code);
        expect(expected).toBeDefined();

        await show(rule);
        expect(container.textContent).toContain(expected!.message);
        // And the field itself is marked, not just the prose beside it.
        expect(byLabel('How long to wait, in seconds')?.className).toContain('err');
    });

    /**
     * **The range in the help line is DERIVED too**, and this is what keeps it honest rather than
     * merely commented — the same shape `automation_validation.rs`'s own message test uses. The
     * expectation is built from the constants and the panel is not, so a literal typed into the
     * panel goes red the day either bound moves. A third copy of a bound is a third sentence that
     * can go quietly false, and this branch has already had two.
     */
    it('states the range from the constants, never from a number typed into the panel', async () => {
        await show(delayed(30_000));
        expect(container.textContent).toContain(
            `Between ${MIN_DELAY_MS / 1_000} second and ${MAX_DELAY_MS / 60_000} minutes`,
        );
    });

    it('accepts a wait inside the range, and says nothing about it', async () => {
        const rule = delayed(MAX_DELAY_MS - 1);
        expect(problems(rule).filter((p) => p.field === 'timer')).toEqual([]);
        await show(rule);
        expect(byLabel('How long to wait, in seconds')?.className).not.toContain('err');
    });

    it('reports a schedule with no day picked, and one whose time is not a time', async () => {
        for (const rule of [scheduled(9 * 60, 0), scheduled(24 * 60, WEEKDAYS)]) {
            const blocking = problems(rule).filter((p) => p.field === 'timer');
            expect(blocking.length).toBeGreaterThan(0);
            await show(rule);
            for (const p of blocking) expect(container.textContent).toContain(p.message);
        }
    });

    // ---------------------------------------------------------------------------- the controls

    it('writes the seconds the field holds, and reads an empty field as no wait at all', async () => {
        await show(delayed(30_000));
        const field = byLabel<HTMLInputElement>('How long to wait, in seconds')!;
        await type(field, '90');
        expect(sentMode()).toEqual({ afterMatch: { delayMs: 90_000 } });

        sent = [];
        await type(field, '');
        // Zero, not the previous value silently kept: an empty wait is not a wait, and `problems`
        // says so under the floor. `null` has no home — `delayMs` is a bare number on the wire.
        expect(sentMode()).toEqual({ afterMatch: { delayMs: 0 } });
    });

    it('writes the clock time the field holds', async () => {
        await show(scheduled(9 * 60, WEEKDAYS));
        const field = byLabel<HTMLInputElement>('Time of day')!;
        await type(field, '07:30');
        expect(sentMode()).toEqual({ dailyAt: { minuteOfDay: 7 * 60 + 30, days: WEEKDAYS } });
    });

    it('toggles exactly the day that was clicked, and leaves the time alone', async () => {
        await show(scheduled(9 * 60, WEEKDAYS));
        const buttons = dayButtons();
        expect(buttons.map((b) => b.getAttribute('aria-pressed')))
            .toEqual(['true', 'true', 'true', 'true', 'true', 'false', 'false']);

        await act(async () => buttons[5].click());
        expect(sentMode()).toEqual({ dailyAt: { minuteOfDay: 9 * 60, days: WEEKDAYS | 0b0010_0000 } });

        sent = [];
        await act(async () => buttons[0].click());
        expect(sentMode()).toEqual({ dailyAt: { minuteOfDay: 9 * 60, days: WEEKDAYS & ~1 } });
    });

    // ---------------------------------------------------------------------------- the sentence

    it('says what the rule will do, in words, and the words follow the fields', async () => {
        await show(delayed(30_000));
        expect(sentence()).toContain('30 seconds');

        await show(delayed(90_000));
        expect(sentence()).toContain('90 seconds');
        expect(sentence()).not.toContain('30 seconds');

        await show(scheduled(9 * 60, WEEKDAYS));
        expect(sentence()).toContain('09:00');
        expect(sentence()).toContain('weekdays');

        await show(scheduled(7 * 60 + 30, 0b0111_1111));
        expect(sentence()).toContain('07:30');
        expect(sentence()).toContain('every day');
        expect(sentence()).not.toContain('weekdays');
    });

    /**
     * A rule with no wait step still has a card drawn for it the moment the palette adds one — but
     * `selected` is free-form state and the DTO's `timer` is optional, so the panel must answer for
     * a rule that has none rather than dereferencing it. It reports the same *not in this rule*
     * `stepValues` gives the node face, so the two cannot word it differently.
     */
    it('says the step is not in the rule when the rule has no wait', async () => {
        await show(blankDraft());
        expect(container.textContent).toContain('not in this rule');
        expect(byLabel('How long to wait, in seconds')).toBeNull();
        expect(byLabel('Time of day')).toBeNull();
    });

    // ------------------------------------------------------------------------------- the naming

    /**
     * **No user-visible string says "Timer".** `AutomationCadence`'s `'timer'` is the monitor's poll
     * interval and `MonitorPanel` shows it as *On a timer*, three cards to the left — two controls
     * called Timer on one screen and the user has no way to tell which is which. Identifiers stay
     * `timer`; strings do not.
     */
    it('never uses the word Timer, in text or in a label', async () => {
        for (const rule of [delayed(30_000), scheduled(9 * 60, WEEKDAYS), blankDraft()]) {
            await show(rule);
            expect(container.textContent ?? '').not.toMatch(/timer/i);
            for (const el of container.querySelectorAll('[aria-label]')) {
                expect(el.getAttribute('aria-label') ?? '').not.toMatch(/timer/i);
            }
        }
    });
});
