import {
  registerSettingsGuard,
  clearSettingsGuard,
  runSettingsGuard,
} from '../settingsNavGuard';

describe('settingsNavGuard', () => {
  afterEach(() => clearSettingsGuard());

  it('returns false and does not block when no guard registered', () => {
    let ran = false;
    expect(runSettingsGuard(() => { ran = true; })).toBe(false);
    expect(ran).toBe(false); // caller proceeds itself
  });

  it('defers proceed when the guard blocks', () => {
    let captured: (() => void) | null = null;
    registerSettingsGuard((proceed) => { captured = proceed; return true; });
    let ran = false;
    expect(runSettingsGuard(() => { ran = true; })).toBe(true);
    expect(ran).toBe(false); // deferred
    captured!(); // guard later resolves
    expect(ran).toBe(true);
  });

  it('passes through when guard declines to block', () => {
    registerSettingsGuard(() => false);
    expect(runSettingsGuard(() => {})).toBe(false);
  });

  it('clear removes the guard', () => {
    registerSettingsGuard(() => true);
    clearSettingsGuard();
    expect(runSettingsGuard(() => {})).toBe(false);
  });
});
