// Pure gating for the activity notification service (Stream 1).
//
// Notifications must stay silent until the app has settled after startup/restore, and
// during synchronized repaint bursts (resize / RDP reconnect / un-minimize) that can
// briefly look like activity. The RunningActivityTracker already suppresses those for
// the bell itself; this is a belt-and-suspenders gate for the notification channels,
// and — crucially — it compares the CAUSAL output time (the timestamp of the output
// that produced the bell, carried on the `activity:bell` event), NOT the Redux
// transition time. The bell flag flips ~2s after output settles, so a wall-clock gate
// on the transition would let a late restore burst slip through; gating on causal time
// closes that hole.

import { STARTUP_COOLDOWN_MS, UNSEEN_DEBOUNCE_MS } from './runningActivity';

/** Startup stabilization window (ms from app boot). DERIVED from the tracker's own
 *  suppression constants so it can't silently drift out of sync: it must cover the
 *  startup cooldown PLUS the unseen debounce (the bell can flip that long after the
 *  causal output) plus a margin, so restore-induced bells whose causal output landed
 *  during startup never notify. */
export const NOTIF_SETTLE_MS = STARTUP_COOLDOWN_MS + UNSEEN_DEBOUNCE_MS + 1000;

/** Whether an activity bell (with causal output time `causalTime`) may fire a
 *  notification. Suppressed if the causal output predates the startup settle window or
 *  falls within an active burst-suppression window. */
export function shouldNotify(
  causalTime: number,
  gates: { settleUntil: number; burstUntil: number },
): boolean {
  return causalTime >= gates.settleUntil && causalTime >= gates.burstUntil;
}
