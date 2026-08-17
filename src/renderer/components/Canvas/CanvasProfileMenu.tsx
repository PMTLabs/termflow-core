import React from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { CanvasMenu, CanvasMenuItem } from './CanvasMenu';
import { profileEmoji } from '../../services/shellProfileIcon';
import { getCachedIcon } from '../../services/binaryIcons';
import { ShellProfileLike } from '../../services/newTabActions';

/**
 * "Which shell?" — the list behind both of Tam's spawn gestures: right-click the canvas
 * background (item 3), and click a connector port (item 4).
 *
 * One component with two call sites rather than two menus, because the only thing that differs
 * between them is where the terminal lands and whether a wire is drawn with it — neither of
 * which is a property of the list. A second copy would be the one that drifts when a profile
 * field changes.
 *
 * Profiles come from the store, the same `state.settings.shellProfiles` the "+" dropdown reads,
 * so the canvas offers exactly what the tab strip offers.
 */
export const CanvasProfileMenu: React.FC<{
  x: number;
  y: number;
  /** What this spawn will do, e.g. "New terminal" or "Connect a new terminal". */
  header: string;
  onPick: (profile: ShellProfileLike) => void;
  onClose: () => void;
}> = ({ x, y, header, onPick, onClose }) => {
  const shellProfiles = useSelector((s: RootState) => s.settings.shellProfiles);
  const defaultProfile = useSelector((s: RootState) => s.settings.defaultProfile);

  return (
    <CanvasMenu x={x} y={y} onClose={onClose} className="canvas-profile-menu">
      <div className="context-menu-header">{header}</div>
      <div className="context-menu-divider" />
      {!shellProfiles?.length ? (
        // Profiles are fetched from the backend at startup. Saying so beats an empty box that
        // looks like a broken menu — and it is reachable, because the canvas can be open
        // before that call returns.
        <div className="context-menu-header">Loading shell profiles…</div>
      ) : (
        shellProfiles.map((profile) => {
          // The extracted binary icon when the session has already resolved it (the "+"
          // dropdown warms this cache), the emoji otherwise. No loader here on purpose: this
          // menu is opened and dismissed in a second, and an icon that fades in after the
          // click has landed is movement for nothing.
          const icon = getCachedIcon((profile as { path?: string }).path);
          return (
            <CanvasMenuItem
              key={profile.id}
              icon={icon
                ? <img className="canvas-menu-icon-img" src={icon} alt="" />
                : profileEmoji(profile as { icon?: string; name: string })}
              onClick={() => { onClose(); onPick(profile); }}
            >
              {profile.name}
              {profile.id === defaultProfile && <span className="canvas-menu-default">Default</span>}
            </CanvasMenuItem>
          );
        })
      )}
    </CanvasMenu>
  );
};

export default CanvasProfileMenu;
