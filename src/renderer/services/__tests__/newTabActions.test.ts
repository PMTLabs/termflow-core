import { resolveDefaultProfile, generateUniqueTabName, buildNewTabFields } from '../newTabActions';

describe('resolveDefaultProfile', () => {
  const profiles = [
    { id: 'bash', name: 'Bash' },
    { id: 'zsh', name: 'Zsh' },
  ];

  it('returns the profile matching defaultProfileId', () => {
    expect(resolveDefaultProfile(profiles, 'zsh')).toEqual({ id: 'zsh', name: 'Zsh' });
  });

  it('falls back to the first profile when defaultProfileId does not match', () => {
    expect(resolveDefaultProfile(profiles, 'missing')).toEqual(profiles[0]);
  });

  it('falls back to the first profile when defaultProfileId is undefined', () => {
    expect(resolveDefaultProfile(profiles, undefined)).toEqual(profiles[0]);
  });

  it('returns undefined when there are no profiles', () => {
    expect(resolveDefaultProfile([], 'bash')).toBeUndefined();
    expect(resolveDefaultProfile(undefined, 'bash')).toBeUndefined();
  });
});

describe('generateUniqueTabName', () => {
  it('returns baseName unchanged when there is no collision', () => {
    expect(generateUniqueTabName(['Other'], 'Bash')).toBe('Bash');
  });

  it('appends an incrementing suffix on collision', () => {
    expect(generateUniqueTabName(['Bash'], 'Bash')).toBe('Bash 1');
    expect(generateUniqueTabName(['Bash', 'Bash 1'], 'Bash')).toBe('Bash 2');
  });
});

describe('buildNewTabFields', () => {
  it('builds fields from the profile and a unique title', () => {
    const fields = buildNewTabFields({ id: 'bash', name: 'Bash' }, ['Bash']);

    expect(fields.title).toBe('Bash 1');
    expect(fields.shellType).toBe('bash');
    expect(fields.icon).toBe('🖥️');
    expect(fields.id).toMatch(/^tb-/);
  });
});
