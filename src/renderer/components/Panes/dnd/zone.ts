import { DropZone } from './types';

/** Fraction of each dimension treated as an edge band. Inner region = center (swap). */
const EDGE = 0.3;

export interface ZoneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Map a cursor position within a pane's rect to an iTerm2-style drop zone.
 * The outer 30% on each side is an edge zone; the inner region is `center`.
 * Near a corner, the closer edge wins.
 */
export function computeZone(rect: ZoneRect, x: number, y: number): DropZone {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const distL = fx;
  const distR = 1 - fx;
  const distT = fy;
  const distB = 1 - fy;
  const min = Math.min(distL, distR, distT, distB);
  if (min > EDGE) return 'center';
  if (min === distL) return 'left';
  if (min === distR) return 'right';
  if (min === distT) return 'top';
  return 'bottom';
}
