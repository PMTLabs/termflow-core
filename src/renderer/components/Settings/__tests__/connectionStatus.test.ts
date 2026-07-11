import { connectionStatus } from '../connectionStatus';

describe('connectionStatus (P0b cross-instance conflict)', () => {
  test('conflict takes precedence over healthy/offline', () => {
    expect(connectionStatus({ healthy: false, conflict: true })).toBe('conflict');
    expect(connectionStatus({ healthy: true, conflict: true })).toBe('conflict');
  });

  test('null healthy reads as checking', () => {
    expect(connectionStatus({ healthy: null })).toBe('checking');
  });

  test('healthy true -> healthy, false -> offline', () => {
    expect(connectionStatus({ healthy: true })).toBe('healthy');
    expect(connectionStatus({ healthy: false })).toBe('offline');
  });

  test('missing health entry is offline', () => {
    expect(connectionStatus(undefined)).toBe('offline');
  });
});
