import { useLayoutEffect, useRef, useState } from 'react';

/** Keep-on-screen margin, matching every flyout panel in the app (`ContextMenu.tsx`,
 *  `SubmenuFlyoutHost.tsx`). */
const EDGE_MARGIN = 5;

/**
 * Edge-aware placement for a flyout panel hanging off a menu row: flip it to the left of its
 * host when it would leave the viewport on the right, and lift it when it would run off the
 * bottom. Shared by every panel that is `position: absolute; left: 100%` of a `position:
 * relative` host — `ContextMenu`'s own `FlyoutPanel` (the search+row list) and
 * `SubmenuFlyoutHost` (arbitrary widget content) both need exactly this measurement, so it
 * lives here once rather than twice.
 *
 * `deps` re-runs the measurement when the panel's CONTENT changes shape (a different schema
 * grid, a re-filtered row list) — the caller passes whatever it already re-renders on, the same
 * way `FlyoutPanel` keys its own effect on `[visible, parentFlippedLeft]`.
 */
export function useSubmenuEdgeFlip(open: boolean, deps: React.DependencyList = []) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState<{ left: boolean; shiftY: number }>({ left: false, shiftY: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    // The panel's own PARENT — `position: relative` submenu host — is the anchor it is
    // measured against, per `left: 100%`. Callers must render the panel as a direct child
    // of that host.
    const host = panel?.parentElement;
    if (!panel || !host) return;
    const p = panel.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    // Nothing to measure — jsdom, and the very first paint. Leave the state alone.
    if (p.width === 0 && p.height === 0) return;
    const overflowsRight = h.right + p.width > window.innerWidth - EDGE_MARGIN;
    const fitsLeft = h.left - p.width > EDGE_MARGIN;
    const overflowY = h.top + p.height - (window.innerHeight - EDGE_MARGIN);
    const next = {
      left: overflowsRight && fitsLeft,
      shiftY: overflowY > 0 ? -Math.min(overflowY, Math.max(0, h.top - EDGE_MARGIN)) : 0,
    };
    setFlip((prev) => (prev.left === next.left && prev.shiftY === next.shiftY ? prev : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps]);

  return { panelRef, flip };
}
