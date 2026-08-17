/**
 * A recognisable glyph for a shell profile.
 *
 * The backend tags profiles with an icon IDENTIFIER ("terminal-powershell", "terminal-cmd",
 * "terminal-bash", …) rather than an emoji, so this maps those — with a name fallback, because
 * a user-defined profile carries whatever the user typed and often no icon key at all.
 *
 * Extracted from `NewTabDropdown` when Canvas Mode's profile menu needed the same list. It is
 * the FALLBACK path in both: where the profile names a real binary, both callers prefer its
 * extracted icon (`binaryIcons.getCachedIcon`) and only come here when that is unavailable —
 * non-Windows, an unresolvable path, or a cache that has not been warmed yet.
 */
export function profileEmoji(profile: { icon?: string; name: string }): string {
  const key = (profile.icon || '').toLowerCase();
  const name = (profile.name || '').toLowerCase();
  if (key.includes('powershell') || name.includes('powershell')) return '🔷';
  if (key.includes('cmd') || name.includes('command prompt')) return '⬛';
  if (name.includes('git')) return '🌿';
  if (key.includes('linux') || name.includes('wsl') || name.includes('ubuntu')
    || name.includes('mint') || name.includes('debian')) return '🐧';
  if (key.includes('fish')) return '🐟';
  if (key.includes('zsh') || key.includes('bash') || name.includes('bash')) return '🐚';
  return '🖥️';
}
