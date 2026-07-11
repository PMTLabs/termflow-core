import { peerStatus } from '../peerStatus';

describe('peerStatus', () => {
  test('pending takes precedence over online/offline', () => {
    expect(peerStatus({ online: true, pending: true })).toBe('pending');
    expect(peerStatus({ online: false, pending: true })).toBe('pending');
  });

  test('online true -> online', () => {
    expect(peerStatus({ online: true })).toBe('online');
  });

  test('online false -> offline', () => {
    expect(peerStatus({ online: false })).toBe('offline');
  });
});
