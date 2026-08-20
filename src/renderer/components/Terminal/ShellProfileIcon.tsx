import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { getCachedIcon, loadIcon } from '../../services/binaryIcons';

/**
 * A shell's real binary icon (e.g. pwsh.exe / git-bash.exe), falling back to an emoji until
 * the real icon resolves (or forever, off Windows / when extraction isn't available).
 *
 * Extracted from the tab strip when the canvas sidebar needed the SAME answer (Req 6,
 * `plan/020` §3) — `shellProfiles.find(p => p.id === shellType)?.path` -> `getCachedIcon()` ->
 * emoji. One copy rather than two so the two surfaces cannot silently drift apart on what a
 * shell "looks like".
 *
 * Owns its own load, unlike the tab strip's old per-render lookup: each mounted icon asks
 * `binaryIcons.loadIcon` for its own path and re-renders itself once it resolves.
 * `binaryIcons` de-dupes concurrent requests for the same path (`pending`), so a tab and a
 * sidebar row showing the same shell never race each other for the same icon — whichever asks
 * first warms the shared cache for the other.
 *
 * `emoji` is the caller's fallback — the tab strip passes `tab.icon` (its existing, tab-level
 * default) so its look is unchanged by this extraction. Callers with nothing more specific
 * (the sidebar row) can omit it and get the same generic glyph new tabs are created with.
 */
export const ShellProfileIcon: React.FC<{
  shellType: string;
  emoji?: string;
}> = ({ shellType, emoji = '🖥️' }) => {
  const shellProfiles = useSelector((s: RootState) => s.settings.shellProfiles);
  const path = shellProfiles.find((p) => p.id === shellType)?.path;
  const [iconUrl, setIconUrl] = useState(() => getCachedIcon(path));

  useEffect(() => {
    setIconUrl(getCachedIcon(path));
    if (!path || getCachedIcon(path)) return;
    let alive = true;
    void loadIcon(path).then((url) => { if (alive && url) setIconUrl(url); });
    return () => { alive = false; };
  }, [path]);

  if (iconUrl) return <img className="shell-profile-icon tab-icon-img" src={iconUrl} alt="" />;
  return emoji ? <span className="shell-profile-icon tab-icon">{emoji}</span> : null;
};

export default ShellProfileIcon;
