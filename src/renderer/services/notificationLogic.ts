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

/** Default startup stabilization window (ms from app boot). Covers the tracker's 3s
 *  startup cooldown + its 2s unseen-debounce + margin, so restore-induced bells whose
 *  causal output landed during startup never notify. */
export const NOTIF_SETTLE_MS = 6000;

/** Whether an activity bell (with causal output time `causalTime`) may fire a
 *  notification. Suppressed if the causal output predates the startup settle window or
 *  falls within an active burst-suppression window. */
export function shouldNotify(
  causalTime: number,
  gates: { settleUntil: number; burstUntil: number },
): boolean {
  return causalTime >= gates.settleUntil && causalTime >= gates.burstUntil;
}
