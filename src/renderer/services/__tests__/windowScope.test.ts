import {
  SLOT_ZERO_ID,
  currentWindowId,
  isSlotZero,
  sessionStateKey,
  sessionKeyPrefix,
  windowIdFromSessionKey,
  initWindowScope,
  __setWindowForTests,
} from '../windowScope';
import { __setProfileForTests, DEFAULT_SCOPE } from '../profileScope';

const resetProfile = () =>
  __setProfileForTests({
    name: DEFAULT_SCOPE,
    scope: DEFAULT_SCOPE,
    elevated: false,
    isDefault: true,
    key: '',
  });

describe('windowScope', () => {
  afterEach(() => {
    __setWindowForTests(SLOT_ZERO_ID);
    resetProfile();
  });

  it('starts on slot 0 so a window that never resolves shares the main session', () => {
    expect(currentWindowId()).toBe(SLOT_ZERO_ID);
    expect(isSlotZero()).toBe(true);
  });

  describe('key derivation', () => {
    it('leaves slot 0 on the original key so an existing session still loads', () => {
      expect(sessionStateKey()).toBe('auto-terminal-state');
    });

    it('leaves slot 0 of a named profile on that profile s original key', () => {
      __setProfileForTests({ name: 'work', scope: 'work', isDefault: false });
      expect(sessionStateKey()).toBe('auto-terminal-state:work');
    });

    it('gives every other window its own key', () => {
      __setWindowForTests('abc123');
      expect(sessionStateKey()).toBe('auto-terminal-state#abc123');
    });

    it('composes the profile and the window, in that order', () => {
      __setProfileForTests({ name: 'work', scope: 'work', isDefault: false });
      __setWindowForTests('abc123');
      expect(sessionStateKey()).toBe('auto-terminal-state:work#abc123');
    });

    it('gives N windows N distinct keys', () => {
      // The defect being fixed is windows COLLIDING on one key. Asserting that
      // two samples differ would pass for an implementation that collapses the
      // 3rd onward; count the distinct keys instead.
      const ids = ['w0', 'a', 'b', 'c', 'd', 'e'];
      const keys = new Set(
        ids.map(id => {
          __setWindowForTests(id);
          return sessionStateKey();
        }),
      );
      expect(keys.size).toBe(ids.length);
    });

    it('never lets a window key collide with another profile s slot-0 key', () => {
      // With one shared separator, a DEFAULT-profile window whose id happened to
      // be "work" would derive `auto-terminal-state:work` — the WORK profile's
      // slot-0 key — and the two instances would overwrite each other. The
      // distinct window separator makes that unreachable by construction rather
      // than by relying on backend ids never looking like a profile name.
      __setWindowForTests('work');
      const defaultWindowKey = sessionStateKey();
      resetProfile();
      __setProfileForTests({ name: 'work', scope: 'work', isDefault: false });
      __setWindowForTests(SLOT_ZERO_ID);
      const workSlotZeroKey = sessionStateKey();
      expect(defaultWindowKey).not.toBe(workSlotZeroKey);
    });
  });

  describe('windowIdFromSessionKey', () => {
    it('reads back the id it wrote, for every window', () => {
      for (const id of [SLOT_ZERO_ID, 'abc123', 'deadbeef']) {
        __setWindowForTests(id);
        expect(windowIdFromSessionKey(sessionStateKey())).toBe(id);
      }
    });

    it('maps the bare key to slot 0', () => {
      expect(windowIdFromSessionKey('auto-terminal-state')).toBe(SLOT_ZERO_ID);
    });

    it('refuses another profile s keys, so a sweep cannot delete them', () => {
      // Running as the DEFAULT profile, `auto-terminal-state:work#abc` is the
      // work profile's window `abc` — not a default-profile window. Getting this
      // wrong deletes a sibling instance's session.
      expect(windowIdFromSessionKey('auto-terminal-state:work#abc')).toBeNull();
      expect(windowIdFromSessionKey('auto-terminal-state:work')).toBeNull();
    });

    it('refuses keys that are not session keys at all', () => {
      expect(windowIdFromSessionKey('auto-terminal-layouts')).toBeNull();
      expect(windowIdFromSessionKey('api_token')).toBeNull();
      expect(windowIdFromSessionKey('auto-terminal-state-other')).toBeNull();
      expect(windowIdFromSessionKey('auto-terminal-state#')).toBeNull();
      expect(windowIdFromSessionKey('auto-terminal-state:')).toBeNull();
    });

    it('scopes the prefix to the running profile', () => {
      __setProfileForTests({ name: 'work', scope: 'work', isDefault: false });
      expect(sessionKeyPrefix()).toBe('auto-terminal-state:work');
      // The DEFAULT profile's own key is NOT ours while running as `work`.
      expect(windowIdFromSessionKey('auto-terminal-state')).toBeNull();
    });
  });

  describe('initWindowScope', () => {
    it('adopts the id the backend reports', async () => {
      const id = await initWindowScope(async () => 'window-7');
      expect(id).toBe('window-7');
      expect(currentWindowId()).toBe('window-7');
      expect(isSlotZero()).toBe(false);
    });

    it('falls back to slot 0 when the backend refuses', async () => {
      // The backend errors rather than guessing for an unknown label, so this
      // path is reachable. Slot 0 means "share the main session", which is
      // today's behaviour — never a lost session.
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const id = await initWindowScope(async () => {
        throw new Error('no window session id registered');
      });
      expect(id).toBe(SLOT_ZERO_ID);
      expect(sessionStateKey()).toBe('auto-terminal-state');
      warn.mockRestore();
    });

    it('falls back to slot 0 outside Tauri (browser / monitor mode)', async () => {
      expect(await initWindowScope(undefined)).toBe(SLOT_ZERO_ID);
    });

    it('ignores a malformed answer rather than keying on it', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await initWindowScope(async () => '')).toBe(SLOT_ZERO_ID);
      expect(await initWindowScope(async () => ({ id: 'x' }) as never)).toBe(SLOT_ZERO_ID);
      warn.mockRestore();
    });
  });
});
