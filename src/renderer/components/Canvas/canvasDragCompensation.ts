/**
 * The instant pan that keeps a grabbed rect stationary while Dynamic Spacing is either removed
 * for a real drag or restored after it. `offset` is DISPLAY minus RAW in world units; `panBy`
 * consumes screen pixels and negates them before moving the world.
 */
export function spacingTransitionPan(
  offset: { dx: number; dy: number },
  z: number,
  transition: 'toRaw' | 'toDisplay',
): { dx: number; dy: number } {
  const sign = transition === 'toRaw' ? -1 : 1;
  return {
    dx: offset.dx === 0 ? 0 : sign * offset.dx * z,
    dy: offset.dy === 0 ? 0 : sign * offset.dy * z,
  };
}
