/**
 * *Wait* — hold the send, or fire on the clock (plan 032 §6.2, §6.3; mockup §03's inspector).
 *
 * **Every string here says "Wait". None says "Timer".** `AutomationCadence`'s `'timer'` is the
 * monitor's poll interval and `MonitorPanel` offers it three cards to the left as *On a timer*; two
 * controls called Timer on one screen leave the user no way to tell which is which. The DTO field,
 * the `StepKind` and the Rust enum are all still `timer` — the constraint is on what is read, not
 * on what is typed.
 *
 * **No bound is written down here.** `MIN_DELAY_MS` and `MAX_DELAY_MS` are `automationValidation`'s
 * (mirroring `automation_validation.rs`), the blocking sentences are the validator's own, and the
 * one number this panel states — the range in the help line — is computed from those constants. A
 * message that carries its own copy of a bound lies the day the bound moves, which is a finding
 * this branch has already had twice.
 *
 * **The mode is REPLACED, never merged.** `AutomationTimerMode` is externally tagged and Rust's
 * `TimerMode` is an enum, so a value carrying both keys is a blob `serde_json` refuses — a save
 * that reports success over a rule that will not load. Switching modes therefore starts the new one
 * from its own default and discards the other's fields, which is also why the delay a user typed
 * does not come back if they go to the clock and return.
 */
import React from 'react';
import type { AutomationTimerMode } from '../../../types/electron';
import type { AutomationDraft, DraftAction } from '../automationDraft';
import { DEFAULT_SCHEDULE_MODE, DEFAULT_TIMER_MODE } from '../automationDraft';
import type { PanelModel } from '../automationDerive';
import { WAIT_MODE_PHRASES, clockTime, waitSentence } from '../automationDerive';
import { MAX_DELAY_MS, MIN_DELAY_MS } from '../automationValidation';
import { AuField, AuHelp, AuRadio } from './AuFields';

/** Bits 0–6 of `dailyAt.days`, Mon..Sun (plan 032 §3.1). Bit 7 names no day and is never set here. */
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export interface TimerPanelProps {
    draft: AutomationDraft;
    model: PanelModel;
    dispatch: (action: DraftAction) => void;
}

export const TimerPanel: React.FC<TimerPanelProps> = ({ draft, model, dispatch }) => {
    const { timer } = draft.rule.graph;
    const setMode = (mode: AutomationTimerMode) => dispatch({ type: 'timer', mode });

    // A rule with no wait step. `selected` is free-form state and `graph.timer` is optional, so this
    // is reachable — and the words are `stepValues`', not this panel's, so the card and the panel
    // cannot describe the same absence differently.
    if (!timer) {
        return (
            <AuField label="Wait">
                <AuHelp>
                    <b>{model.values.when.text}</b> — drag <b>Wait</b> in from the palette to hold
                    the send for a while, or to fire this rule on the clock instead. Without one the
                    rule sends as soon as it matches.
                </AuHelp>
            </AuField>
        );
    }

    const delay = 'afterMatch' in timer.mode ? timer.mode.afterMatch : null;
    const schedule = 'dailyAt' in timer.mode ? timer.mode.dailyAt : null;
    const blocking = model.problems.filter((p) => p.severity === 'blocks');
    const sentence = waitSentence(timer);

    return (
        <>
            <AuField label="What kind of wait">
                <AuRadio
                    name="au-waitmode"
                    on={delay !== null}
                    title={WAIT_MODE_PHRASES.afterMatch}
                    sub="Hold, then send. Needs a Compare it before it."
                    onPick={() => setMode(DEFAULT_TIMER_MODE)}
                />
                <AuRadio
                    name="au-waitmode"
                    on={schedule !== null}
                    title={WAIT_MODE_PHRASES.dailyAt}
                    sub="Starts the rule. No terminal is read."
                    onPick={() => setMode(DEFAULT_SCHEDULE_MODE)}
                />
            </AuField>

            {delay !== null && (
                <AuField label="How long to wait">
                    <div className="au-frow">
                        <input
                            className={`au-finput${blocking.length > 0 ? ' err' : ''}`}
                            style={{ flex: '0 0 96px' }}
                            aria-label="How long to wait, in seconds"
                            inputMode="decimal"
                            placeholder="30"
                            // Zero shows as EMPTY, and an empty field reads back as zero. The field
                            // is the only place the value lives — no local draft state — so a `0`
                            // rendered into a cleared box would fight the user for the caret on
                            // every keystroke. Zero is under the floor either way, so the rule is
                            // blocked and says why rather than quietly keeping the old number.
                            value={delay.delayMs === 0 ? '' : String(delay.delayMs / 1_000)}
                            onChange={(e) => {
                                const seconds = Number(e.target.value.trim());
                                const ok = e.target.value.trim().length > 0
                                    && Number.isFinite(seconds)
                                    && seconds > 0;
                                // `NaN` has no JSON spelling and `delayMs` is a bare number on the
                                // wire, so anything unreadable becomes 0 — the same decision
                                // `CondPanel` makes with `null` for a threshold it cannot parse.
                                setMode({ afterMatch: { delayMs: ok ? Math.round(seconds * 1_000) : 0 } });
                            }}
                        />
                        <span className="au-novalue">seconds</span>
                    </div>
                    <AuHelp>
                        Between {MIN_DELAY_MS / 1_000} second and {MAX_DELAY_MS / 60_000} minutes. A
                        waiting message is held in memory and nowhere else, so quitting TermFlow
                        mid-wait loses it — that is what the upper end is for.
                    </AuHelp>
                </AuField>
            )}

            {schedule !== null && (
                <>
                    <AuField label="Time">
                        <div className="au-frow">
                            <input
                                type="time"
                                className={`au-finput${blocking.some((p) => p.code === 'timer.badMinute') ? ' err' : ''}`}
                                style={{ flex: '0 0 128px' }}
                                aria-label="Time of day"
                                // A `minuteOfDay` outside `0..1440` has no clock spelling, so the
                                // field goes blank rather than showing `-1:-5`, and
                                // `timer.badMinute` below says what is wrong with it.
                                value={clockTime(schedule.minuteOfDay) ?? ''}
                                onChange={(e) => {
                                    const [hh, mm] = e.target.value.split(':');
                                    const minutes = Number(hh) * 60 + Number(mm);
                                    if (!Number.isFinite(minutes)) return;
                                    setMode({ dailyAt: { ...schedule, minuteOfDay: minutes } });
                                }}
                            />
                            <span className="au-novalue">local time</span>
                        </div>
                        <AuHelp>
                            Local time, and it follows the clock. On the day the clocks go forward a
                            02:30 rule fires at <b>03:00</b> — late, once, rather than not at all.
                        </AuHelp>
                    </AuField>

                    <AuField label="On these days">
                        <div className="au-seg" role="group" aria-label="Days of the week">
                            {DAY_LABELS.map((label, bit) => {
                                const on = (schedule.days & (1 << bit)) !== 0;
                                return (
                                    <button
                                        type="button"
                                        key={label}
                                        className={on ? 'on' : undefined}
                                        aria-pressed={on}
                                        onClick={() =>
                                            setMode({
                                                dailyAt: {
                                                    ...schedule,
                                                    days: schedule.days ^ (1 << bit),
                                                },
                                            })}
                                    >
                                        {label}
                                    </button>
                                );
                            })}
                        </div>
                    </AuField>

                    <AuHelp>
                        If TermFlow is not running when the time passes, the rule skips that day. A
                        09:00 prompt does not arrive at 14:00 because the app started late.
                    </AuHelp>
                </>
            )}

            {/* The validator's own sentences, at the field they belong to. `AuInspector`'s problem
                list shows every problem the rule has; this shows the ones this panel can fix,
                without the user having to look up and match a step name to a card. */}
            {blocking.map((p) => (
                <AuHelp key={p.code} warn>
                    {p.message}
                </AuHelp>
            ))}

            {sentence && <div className="au-plainsay">{sentence}</div>}
        </>
    );
};
