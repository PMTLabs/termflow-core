import { isHostOwnershipPending, isLifecycleBusy } from '../hostOwnershipPending';

describe.each([
  [isHostOwnershipPending, 'host-ownership-pending:', 'host-session-contended: busy'],
  [isLifecycleBusy, 'LIFECYCLE_BUSY', 'host-ownership-pending: slow'],
])('retryable wire prefixes', (predicate, prefix, other) => {
  it.each([`${prefix} host unavailable`, new Error(`${prefix} host unavailable`)])('recognizes string and Error forms', error => {
    expect(predicate(error)).toBe(true);
  });
  it.each([undefined, null, {}, 42, other, new Error(`embedded ${prefix} failure`)])('rejects non-prefixes', error => {
    expect(predicate(error)).toBe(false);
  });
});
