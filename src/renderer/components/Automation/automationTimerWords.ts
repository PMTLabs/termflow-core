/**
 * Pure words for a `TimerStep`'s two modes — the clock and the weekday mask (plan 032 §3.1, §6.3).
 *
 * **Why this is its own module, not part of `automationDerive.ts`.** `automationDerive.ts` already
 * imports `automationRowState`/`describeCadence`/`describeCriterion` FROM
 * `Settings/Automations/automationState.ts`, for the node face's runtime pill and its Watch row.
 * Task 25 (plan 032 §7) needs `automationState.ts`'s own `describeCadence` to say a schedule rule's
 * *"at 09:00, weekdays"* — the same two facts `describeRule` and `TimerPanel`'s sentence already
 * read — and `clockTime`/`describeDays` lived in `automationDerive.ts`, which would have made that a
 * straight import cycle (`automationDerive` → `automationState` → `automationDerive`).
 *
 * Pulling the two pure formatters out to a leaf module both sides can import is the fix: no cycle,
 * and — the reason it beats writing a second clock/day formatter in `automationState.ts` — still
 * ONE vocabulary for what a schedule's time and days mean in words, which is the same reason
 * `condSentence` exists at all (`automationDerive.ts`'s own header).
 */

/** Bits 0–6 of a `dailyAt` mask are Mon..Sun (plan 032 §3.1). Bit 7 names no day. */
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAY_MASK = 0b0001_1111;
const WEEKEND_MASK = 0b0110_0000;
const EVERY_DAY_MASK = 0b0111_1111;

/** Which days a mask selects, in order. Exported so a caller building its own list can agree. */
export function daysOf(mask: number): string[] {
    return DAY_NAMES.filter((_, i) => (mask & (1 << i)) !== 0);
}

/**
 * A weekday mask in words — `every day`, `weekdays`, `weekends`, or the days themselves.
 *
 * The three named sets are not a convenience: `Mon, Tue, Wed, Thu, Fri` is 25 characters and the
 * node's value column holds about 23 to a line (see `AU_NODE_W`), so the common case would wrap the
 * one row the card gives this step. Returns `''` for a mask that selects nothing, which is
 * `timer.noDays` and is reported as a missing value rather than as a set of no days.
 */
export function describeDays(mask: number): string {
    const picked = mask & EVERY_DAY_MASK;
    if (picked === 0) return '';
    if (picked === EVERY_DAY_MASK) return 'every day';
    if (picked === WEEKDAY_MASK) return 'weekdays';
    if (picked === WEEKEND_MASK) return 'weekends';
    return daysOf(picked).join(', ');
}

/**
 * A minute-of-day as a 24-hour clock time, or `null` when it is not a time of day at all.
 *
 * `minuteOfDay` is a bare number on both sides of the wire and `timer.badMinute` is what refuses an
 * out-of-range one — but validation runs beside this, not before it, so a caller can be asked to
 * draw a rule that is blocked. `null` is the honest answer for `-5`; `-1:-5` is not.
 */
export function clockTime(minuteOfDay: number): string | null {
    if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= 24 * 60) return null;
    const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
    const mm = String(minuteOfDay % 60).padStart(2, '0');
    return `${hh}:${mm}`;
}
