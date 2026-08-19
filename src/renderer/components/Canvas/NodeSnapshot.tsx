import React, { useEffect, useMemo, useRef, useState } from 'react';
import { terminalService } from '../../services/TerminalService';
import { snapshotCache, isUsableSnapshot, stripAnsi, SNAPSHOT_TTL_MS } from './snapshotCache';

/** How often the loop WAKES. `shouldRefresh` decides whether it actually fetches, so this is
 *  only the granularity of the TTL, not the request rate. Cheap: a wake with nothing due is two
 *  Map lookups. */
const POLL_MS = 500;

/**
 * A frozen picture of a terminal's screen, for the `snapshot` tier.
 *
 * Small enough that a live engine would be wasted, large enough that the user still wants to see
 * what is on screen. Costs no WebGL context, which is what lets this tier scale past `MAX_GPU`.
 *
 * **Mount this only for nodes that are BOTH at the snapshot tier AND on screen.** `assignTiers`
 * labels an off-screen node `snapshot`; it does not omit it. Mounting here for off-screen nodes
 * leaves their polling loops running forever, and `snapshotCache.evictAllBut` cannot help —
 * a still-mounted component simply refills the cache on its next tick. `CanvasMode` owns that
 * decision; see its `snapshotIds`.
 *
 * Note this is the opposite of `CanvasNode`'s rule, and deliberately: the NODE mounts for every
 * terminal all session (`012` §6.5 RC4) because unmounting it would relocate a live terminal at
 * pan frequency. What is culled here is this component and its timer, never the node.
 *
 * **Scope (design/010 §4.5 deviation, recorded in `plan/013` Task 10).** The spec paints the
 * ANSI blob through a pooled offscreen xterm and caches the raster. This ships the simpler
 * thing — ANSI-stripped monochrome text — because a pooled offscreen xterm is a second terminal
 * lifecycle mechanism, and landing two of those in one phase is how this gets away from us. The
 * upgrade is additive and does not change this component's interface: a `snapshotPool.ts` turns
 * `SnapshotEntry.ansi` into a data URL behind the same props. The cache already stores the raw
 * ANSI for exactly that reason.
 */
const NodeSnapshotImpl: React.FC<{ terminalId: string }> = ({ terminalId }) => {
  // Seeded from the cache so a node panned back into view paints immediately rather than
  // flashing empty for up to a tick.
  const [ansi, setAnsi] = useState<string | null>(
    () => snapshotCache.get(terminalId)?.ansi ?? null,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Re-seed on a terminalId change: this effect re-runs, but `useState`'s initialiser does
    // not, so without this the node would keep showing the PREVIOUS terminal's screen until the
    // first successful fetch.
    setAnsi(snapshotCache.get(terminalId)?.ansi ?? null);

    const schedule = () => {
      if (cancelled) return;
      timer.current = setTimeout(tick, POLL_MS);
    };

    const tick = async () => {
      if (cancelled) return;
      if (!snapshotCache.shouldRefresh(terminalId, Date.now())) return schedule();

      // `/snapshot` is keyed by BACKEND PROCESS ID, and handing it a renderer id fails
      // SILENTLY — HTTP 200, empty blob, rows/cols 0. `isUsableSnapshot` is what turns that
      // into a failure instead of a cached blank frame.
      const processId = terminalService.getProcessId(terminalId);
      if (!processId) {
        // Normal and temporary during spawn, so back off rather than treating it as an error.
        snapshotCache.markFailed(terminalId, Date.now());
        return schedule();
      }

      // Optional on the API surface, and guarded the same way `MainBridge` guards it — the
      // browser bridge and older hosts may not provide it. Going through `electronAPI` rather
      // than `fetch` is what carries the bearer token and the EFFECTIVE API port; this is the
      // same call `TerminalBridge.getSnapshot` makes, without standing up a bridge object per
      // node for one method.
      const getSnapshot = window.electronAPI?.getTerminalSnapshot;
      if (!getSnapshot) {
        snapshotCache.markFailed(terminalId, Date.now());
        return schedule();
      }

      try {
        const snap = await getSnapshot(processId);
        if (cancelled) return;
        if (!isUsableSnapshot(snap)) {
          snapshotCache.markFailed(terminalId, Date.now());
          return schedule();
        }
        snapshotCache.put(terminalId, {
          ansi: snap.snapshot, rows: snap.rows, cols: snap.cols, fetchedAt: Date.now(),
        });
        setAnsi(snap.snapshot);
      } catch {
        // The last good frame is deliberately kept: a stale screen on a node this small reads
        // as fine, where a blank one reads as broken.
        if (!cancelled) snapshotCache.markFailed(terminalId, Date.now());
      }
      schedule();
    };

    tick();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [terminalId]);

  // Stripping is O(screen) and the blob only changes every SNAPSHOT_TTL_MS, while this component
  // re-renders on every pan and zoom.
  const text = useMemo(() => (ansi === null ? null : stripAnsi(ansi)), [ansi]);

  return (
    <div className="canvas-node-snapshot" aria-hidden="true">
      {text === null ? null : <pre>{text}</pre>}
    </div>
  );
};

/**
 * Memoised, and the props are why it can be.
 *
 * Canvas Mode re-renders on every frame of a pan or zoom — `setViewport` fires per pointer
 * event — and without this every node's polling snapshot re-ran with it, for the whole workspace
 * including the nodes culled off screen. The props here are primitives, so the equality
 * check is exact and cheap; `CanvasNode` itself is deliberately NOT memoised, because it
 * takes `children` and seven per-node closures that are rebuilt each render, and a memo
 * that never bails is only a slower render.
 */
export const NodeSnapshot = React.memo(NodeSnapshotImpl);

export { SNAPSHOT_TTL_MS };
export default NodeSnapshot;
