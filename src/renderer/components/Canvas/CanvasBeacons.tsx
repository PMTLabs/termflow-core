import React from 'react';
import { Beacon, BEACON_SIZE } from './orientation';

/**
 * Edge markers for running terminals you cannot see (design 010 §10, `plan/013` Task 23).
 *
 * A fixed-size pip rather than a labelled pill, and that is a layout decision rather than a
 * styling one: a beacon is CENTRED on a point clamped `BEACON_INSET` from the viewport edge, so
 * anything whose width depends on its text is drawn partly outside the viewport as soon as the
 * title is long. The title lives in the tooltip, where it costs no width.
 *
 * The count, when a marker stands for several co-located terminals, is drawn IN the pip — see
 * `beaconLayout` for why they collapse and why the number is shown rather than the extras
 * being dropped.
 */
export const CanvasBeacons: React.FC<{
  beacons: Beacon[];
  onPick: (terminalId: string) => void;
}> = ({ beacons, onPick }) => (
  <>
    {beacons.map((b) => (
      <button
        key={b.terminalId}
        type="button"
        className="canvas-beacon"
        style={{ left: b.x, top: b.y, width: BEACON_SIZE, height: BEACON_SIZE }}
        // `pointerdown`, not `click`: `CanvasViewport` decides whether to start a pan on
        // pointerdown, and by the time a click fired the canvas would already be following the
        // cursor.
        //
        // No `stopPropagation` — `.canvas-beacon` is in `CanvasViewport`'s own bail-out list,
        // which is how every other click target on this canvas stays a click target. A second
        // guard here would make that entry untestable: it would keep working after the entry
        // was removed, and the minimap (which has no such guard) would break alone.
        onPointerDown={() => onPick(b.terminalId)}
        title={b.count > 1
          ? `${b.title} and ${b.count - 1} more running off screen — click to fly there`
          : `${b.title} is running off screen — click to fly there`}
        aria-label={`Fly to ${b.title}`}
      >
        {b.count > 1 ? b.count : ''}
      </button>
    ))}
  </>
);

export default CanvasBeacons;
