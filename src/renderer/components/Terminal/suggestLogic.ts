// Pure popup geometry/selection logic (backlog 011) — unit-testable without DOM.

export function moveSelection(count: number, index: number, dir: 'up' | 'down'): number {
  if (count <= 0) return 0;
  if (dir === 'down') return Math.min(count - 1, index + 1);
  return Math.max(0, index - 1);
}

export interface PopupAnchor {
  left: number;
  top: number;
  cellHeight: number;
}

/** Position the popup just below the cursor line; flip above when it would
 *  overflow the pane; clamp horizontally. Fixed corner fallback without anchor. */
export function placePopup(
  anchor: PopupAnchor | null,
  popupWidth: number,
  popupHeight: number,
  paneWidth: number,
  paneHeight: number,
): { left: number; top: number } {
  if (!anchor) {
    return { left: 8, top: Math.max(8, paneHeight - popupHeight - 8) };
  }
  const gap = 2;
  let top = anchor.top + anchor.cellHeight + gap;
  if (top + popupHeight > paneHeight) {
    top = Math.max(0, anchor.top - popupHeight - gap);
  }
  const left = Math.max(0, Math.min(anchor.left, paneWidth - popupWidth));
  return { left, top };
}
