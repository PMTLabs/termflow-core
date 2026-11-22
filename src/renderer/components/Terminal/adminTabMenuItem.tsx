// Plan 045 §4.1 — the flyout adapter for the one surface with a real submenu
// system (`TerminalDisplay`'s right-click menu). Maps the same
// `adminTabSupport`/`nativeProfilesForAdmin` data every other surface reads to a
// `ContextMenuItem`, exactly as `snippetsHistoryMenu.ts` does for its two items.
// The other three surfaces use `AdminProfileList` instead — they have no flyout
// system of their own (PaneContextMenu/TabContextMenu's hand-rolled subpanel,
// NewTabDropdown's flat sections).

import React from 'react';
import type { ContextMenuFlyoutRow, ContextMenuItem } from './ContextMenu';
import {
  adminTabSupport,
  adminTabTooltip,
  nativeProfilesForAdmin,
  openAdminTabWithProfile,
} from '../../services/adminTabActions';
import type { ShellProfile } from '../../store/slices/settingsSlice';
import { profileEmoji } from '../../services/shellProfileIcon';
import { ShellProfileIcon } from './ShellProfileIcon';

/**
 * Build the "Open admin Tab" item. Per the O2 ruling, this is ALWAYS returned
 * — never `null`/omitted — so the caller can splice it into the menu
 * unconditionally; when support is false it carries `enabled: false` and the
 * reason's tooltip, with no submenu (a disabled item's flyout can never open).
 *
 * `shellProfiles` MUST come from a live store read in the caller, matching the
 * convention `buildSnippetsMenuItem` documents for `snippets`.
 */
export function adminTabMenuItem(shellProfiles: ShellProfile[]): ContextMenuItem {
  const support = adminTabSupport();
  if (!support.supported) {
    return {
      label: 'Open admin Tab',
      icon: '🛡️',
      title: adminTabTooltip(support.reason),
      enabled: false,
    };
  }

  const profiles = nativeProfilesForAdmin({ settings: { shellProfiles } });
  // The same real-binary icon the tab strip and the other three admin surfaces
  // show — `ShellProfileIcon` owns the cache lookup AND the load, so a profile
  // no tab has opened yet (git-bash) still resolves instead of staying an emoji.
  const rows: ContextMenuFlyoutRow[] = profiles.map((p) => ({
    id: `admin-${p.id}`,
    label: p.name,
    icon: <ShellProfileIcon shellType={p.id} emoji={profileEmoji(p)} />,
    onSelect: () => openAdminTabWithProfile(p),
    closeMenuOnSelect: true,
  }));

  return {
    label: 'Open admin Tab',
    icon: '🛡️',
    title: 'Open a new tab running the chosen shell profile as Administrator (UAC prompt on first use).',
    submenu: {
      rows,
      emptyRow: { id: 'no-native-profiles', label: 'No native shell profiles', disabled: true },
    },
  };
}
