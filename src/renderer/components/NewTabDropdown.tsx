import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../store';
import { addTab } from '../store/slices/tabsSlice';
import { openSettingsTab } from '../services/openSettings';
import './NewTabDropdown.css';
import { getCachedIcon, loadIcon } from '../services/binaryIcons';
import { resolveDefaultProfile, buildNewTabFields } from '../services/newTabActions';

interface NewTabDropdownProps {
  onNewTab?: () => void;
}

/**
 * Pick an emoji for a shell profile. The backend tags profiles with an icon
 * identifier ("terminal-powershell", "terminal-cmd", "terminal-bash", …) rather
 * than an emoji, so map those (with a name fallback) to a recognisable glyph.
 */
function profileEmoji(profile: { icon?: string; name: string }): string {
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

export const NewTabDropdown: React.FC<NewTabDropdownProps> = () => {
  const dispatch = useDispatch<AppDispatch>();
  const shellProfiles = useSelector((state: RootState) => state.settings.shellProfiles);
  const defaultShellProfile = useSelector((state: RootState) => state.settings.defaultProfile);
  const tabs = useSelector((state: RootState) => state.tabs.tabs);

  const [isOpen, setIsOpen] = useState(false);
  // Bumped when a profile's real icon finishes loading, to re-render the list.
  const [, setIconTick] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Edge-aware: the menu is right-aligned to the button (so it never spills past
  // the right screen edge), but when the button sits near the LEFT edge the menu
  // gets clipped there instead. After open, shift it right just enough to stay
  // on screen, clamped so it doesn't overflow the right edge either.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const el = menuRef.current;
    if (!el) return;
    el.style.right = '';
    const rect = el.getBoundingClientRect();
    const shift = Math.min(5 - rect.left, window.innerWidth - 5 - rect.right);
    if (shift > 0) el.style.right = `${-shift}px`;
  }, [isOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Pull the real binary icon (e.g. from pwsh.exe / cmd.exe) for each profile when
  // the menu opens. Cached for the session; falls back to the emoji glyph while
  // loading or if extraction fails (e.g. non-Windows).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      let changed = false;
      for (const p of shellProfiles) {
        const path = (p as { path?: string }).path;
        if (!path || getCachedIcon(path)) continue;
        const url = await loadIcon(path);
        if (url) changed = true;
      }
      if (changed && !cancelled) setIconTick(t => t + 1);
    })();
    return () => { cancelled = true; };
  }, [isOpen, shellProfiles]);

  const handleNewTabWithDefaultProfile = () => {
    if (!shellProfiles || shellProfiles.length === 0) {
      console.warn('Shell profiles not yet loaded');
      return;
    }

    const defaultProfile = resolveDefaultProfile(shellProfiles, defaultShellProfile);

    if (defaultProfile) {
      createNewTab(defaultProfile);
    }
  };

  const handleNewTabWithProfile = (profileId: string) => {
    const profile = shellProfiles.find(p => p.id === profileId);

    if (profile) {
      createNewTab(profile);
    }
    setIsOpen(false);
  };

  const createNewTab = (profile: any) => {
    const newTab = buildNewTabFields(profile, tabs.map(tab => tab.title));

    dispatch(addTab(newTab));
  };

  const handleDropdownClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };

  return (
    <div className="new-tab-dropdown" ref={dropdownRef}>
      <div className="new-tab-buttons">
        <button
          className="new-tab-button"
          onClick={handleNewTabWithDefaultProfile}
          disabled={!shellProfiles || shellProfiles.length === 0}
          aria-label="New tab with default profile"
          title={shellProfiles?.length > 0 ? "Create new tab" : "Loading shell profiles..."}
        >
          +
        </button>
        <button
          className="dropdown-button"
          onClick={handleDropdownClick}
          disabled={!shellProfiles || shellProfiles.length === 0}
          aria-label="New tab options"
          title={shellProfiles?.length > 0 ? "Choose shell profile" : "Loading shell profiles..."}
        >
          ▼
        </button>
      </div>

      {isOpen && (
        <div className="dropdown-menu" ref={menuRef}>
          <div className="dropdown-section">
            <div className="dropdown-header">Profiles</div>
            {!shellProfiles || shellProfiles.length === 0 ? (
              <div className="dropdown-item disabled">
                <span className="profile-name">Loading shell profiles...</span>
              </div>
            ) : (
              shellProfiles.map(profile => (
                <div
                  key={profile.id}
                  className={`dropdown-item ${profile.id === defaultShellProfile ? 'default' : ''}`}
                  onClick={() => handleNewTabWithProfile(profile.id)}
                >
                  <span className="profile-icon">
                    {getCachedIcon((profile as { path?: string }).path)
                      ? <img className="profile-icon-img" src={getCachedIcon((profile as { path?: string }).path)} alt="" />
                      : profileEmoji(profile)}
                  </span>
                  <span className="profile-name">{profile.name}</span>
                  {profile.id === defaultShellProfile && (
                    <span className="default-badge">Default</span>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="dropdown-divider" />

          <div className="dropdown-section">
            <div
              className="dropdown-item"
              onClick={() => {
                // Single-instance: reuse the existing Settings tab if open.
                openSettingsTab();
                setIsOpen(false);
              }}
            >
              <span className="profile-icon">⚙️</span>
              <span className="profile-name">Settings</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};