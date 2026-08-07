import {
  stateKeyFor,
  layoutsKeyFor,
  apiTokenKeyFor,
  initProfileScope,
  currentProfile,
  __setProfileForTests,
  DEFAULT_SCOPE,
} from '../profileScope';

describe('profileScope', () => {
  afterEach(() => {
    __setProfileForTests({ name: DEFAULT_SCOPE, scope: DEFAULT_SCOPE, elevated: false, isDefault: true });
  });

  it('keeps the default profile on the original keys so existing state loads', () => {
    expect(stateKeyFor('default')).toBe('auto-terminal-state');
    expect(layoutsKeyFor('default')).toBe('auto-terminal-layouts');
    expect(apiTokenKeyFor('default')).toBe('api_token');
  });

  it('gives a named profile its own keys', () => {
    expect(stateKeyFor('work')).toBe('auto-terminal-state:work');
    expect(layoutsKeyFor('work')).toBe('auto-terminal-layouts:work');
    expect(apiTokenKeyFor('work')).toBe('api_token:work');
  });

  it('separates an elevated instance from a normal one of the same name', () => {
    // Both windows share one localStorage; only the scope tells them apart.
    expect(stateKeyFor('work.high')).not.toBe(stateKeyFor('work'));
  });

  it('adopts the scope the backend reports', async () => {
    const info = await initProfileScope(async () => ({
      name: 'work',
      elevated: false,
      scope: 'work',
      isDefault: false,
    }));
    expect(info.scope).toBe('work');
    expect(currentProfile().name).toBe('work');
  });

  it('falls back to the default keys when the backend cannot answer', async () => {
    // The browser/monitor build has no such command. Falling back to a *new*
    // scope would silently orphan the user's saved tabs.
    const info = await initProfileScope(async () => {
      throw new Error('no such command');
    });
    expect(info.scope).toBe(DEFAULT_SCOPE);
    expect(stateKeyFor(info.scope)).toBe('auto-terminal-state');
  });

  it('falls back to the default keys with no invoke at all', async () => {
    const info = await initProfileScope(undefined);
    expect(info.scope).toBe(DEFAULT_SCOPE);
  });
});
