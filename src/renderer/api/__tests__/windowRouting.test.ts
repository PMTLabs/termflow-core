import { shouldHandleForWindow } from '../windowRouting';

// P0a: an API/MCP create-terminal event is broadcast to every window with a
// `targetWindow` label; only the matching window should act on it. A missing target
// means "any window" (backward compatible with pre-routing events).
describe('shouldHandleForWindow', () => {
  test('handles the event when target matches this window label', () => {
    expect(shouldHandleForWindow('main', 'main')).toBe(true);
    expect(shouldHandleForWindow('window-abc', 'window-abc')).toBe(true);
  });

  test('ignores the event when another window is the target', () => {
    expect(shouldHandleForWindow('window-2', 'main')).toBe(false);
    expect(shouldHandleForWindow('main', 'window-2')).toBe(false);
  });

  test('handles the event when target is missing/empty (backward compat)', () => {
    expect(shouldHandleForWindow(undefined, 'main')).toBe(true);
    expect(shouldHandleForWindow(null, 'main')).toBe(true);
    expect(shouldHandleForWindow('', 'main')).toBe(true);
  });
});
