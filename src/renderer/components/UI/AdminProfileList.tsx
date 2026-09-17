import React from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import {
  adminTabSupport,
  adminTabTooltip,
  nativeProfilesForAdmin,
  openAdminTabWithProfile,
} from '../../services/adminTabActions';
import { getCachedIcon } from '../../services/binaryIcons';
import { profileEmoji } from '../../services/shellProfileIcon';

interface AdminProfileListProps {
  /** `'menu'` renders `<button class="context-menu-item">` rows, the idiom
   *  `PaneContextMenu` and `TabContextMenu` already use inside their
   *  `context-menu-subpanel`. `'dropdown'` renders `<div class="dropdown-item">`
   *  rows, `NewTabDropdown`'s own idiom (its rows are not buttons). */
  variant: 'menu' | 'dropdown';
  /** Forwarded to `openAdminTabWithProfile` — the new tab lands immediately
   *  after this one (tab-strip menu only; absent elsewhere). */
  afterTabId?: string;
  /** Called after a pick, so the host can close its menu/dropdown/subpanel. */
  onPick?: () => void;
}

/**
 * The shared DOM profile list for the three list-rendering surfaces (plan 045
 * §4.1). `TerminalDisplay`'s flyout is the fourth surface and does not use
 * this — see `adminTabMenuItem.ts`, which maps the same data to flyout rows.
 *
 * Per the O2 ruling: when support is false, renders ONE disabled row carrying
 * the reason's tooltip in place of the profile list — never omitted, never a
 * silently empty section.
 */
export const AdminProfileList: React.FC<AdminProfileListProps> = ({ variant, afterTabId, onPick }) => {
  const shellProfiles = useSelector((s: RootState) => s.settings.shellProfiles);
  const support = adminTabSupport();

  if (!support.supported) {
    return <DisabledRow variant={variant} title={adminTabTooltip(support.reason)} label="No admin tabs available" />;
  }

  const profiles = nativeProfilesForAdmin({ settings: { shellProfiles } });
  if (profiles.length === 0) {
    return <DisabledRow variant={variant} title="No native shell profiles available" label="No native shell profiles" />;
  }

  const pick = (profileId: string) => {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;
    openAdminTabWithProfile(profile, afterTabId);
    onPick?.();
  };

  if (variant === 'menu') {
    return (
      <>
        {profiles.map((profile) => (
          <button
            key={profile.id}
            type="button"
            className="context-menu-item"
            onClick={() => pick(profile.id)}
          >
            <span className="menu-icon">{profileIcon(profile)}</span>
            {profile.name}
          </button>
        ))}
      </>
    );
  }

  return (
    <>
      {profiles.map((profile) => (
        <div key={profile.id} className="dropdown-item" onClick={() => pick(profile.id)}>
          <span className="profile-icon">{profileIcon(profile)}</span>
          <span className="profile-name">{profile.name}</span>
        </div>
      ))}
    </>
  );
};

function profileIcon(profile: { path?: string; icon?: string; name: string }): React.ReactNode {
  const cached = getCachedIcon(profile.path);
  return cached
    ? <img className="profile-icon-img" src={cached} alt="" />
    : profileEmoji(profile);
}

const DisabledRow: React.FC<{ variant: 'menu' | 'dropdown'; title: string; label: string }> = ({
  variant,
  title,
  label,
}) => (
  variant === 'menu'
    ? (
      <button type="button" className="context-menu-item" disabled title={title}>
        <span className="menu-icon">🛡️</span>
        {label}
      </button>
    )
    : (
      <div className="dropdown-item disabled" title={title}>
        <span className="profile-icon">🛡️</span>
        <span className="profile-name">{label}</span>
      </div>
    )
);
