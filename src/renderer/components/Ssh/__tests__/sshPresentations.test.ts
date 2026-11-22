/**
 * Plan 070 §4.1 A / D51: the Canvas-visible registry is token-owned. An outgoing node's
 * `visible = false` publish must never clear a successor's live entry (review 347 F4).
 */
import { __resetSshPresentationsForTest, publishSshCanvasVisible, useSshCanvasVisible } from '../sshPresentations';

// The hook reads the same store React would; outside a component, read it directly.
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useCallback: (fn: unknown) => fn,
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));

const T = 'tm-ssh-a';
const isVisible = () => useSshCanvasVisible(T);

afterEach(() => __resetSshPresentationsForTest());

test('sshCanvasVisible_hiddenPublisher_neverClearsASuccessorsToken', () => {
  // Positive control: a visible publisher is seen, and its own retraction clears it.
  const first = publishSshCanvasVisible(T, true);
  expect(isVisible()).toBe(true);
  first();
  expect(isVisible()).toBe(false);

  // The successor node publishes visible; the outgoing node then publishes hidden.
  const successor = publishSshCanvasVisible(T, true);
  const outgoing = publishSshCanvasVisible(T, false);
  expect(isVisible()).toBe(true);
  outgoing();
  expect(isVisible()).toBe(true);
  successor();
  expect(isVisible()).toBe(false);
});

test('sshCanvasVisible_staleRetraction_doesNotClearANewerEntry', () => {
  const older = publishSshCanvasVisible(T, true);
  const newer = publishSshCanvasVisible(T, true);
  older();
  expect(isVisible()).toBe(true);
  newer();
  expect(isVisible()).toBe(false);
});
