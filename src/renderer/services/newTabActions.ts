/**
 * Pure, unit-testable helpers for creating a new tab with a shell profile —
 * shared by the "+" button (NewTabDropdown) and the Ctrl/Cmd+Shift+T shortcut
 * (InputHandler), so both go through the same profile-resolution and
 * unique-naming logic. Kept free of React/Redux so they can be tested in
 * isolation (see __tests__/newTabActions.test.ts).
 */

import { generateId } from '../utils/id';

export interface ShellProfileLike {
  id: string;
  name: string;
}

export interface NewTabFields {
  id: string;
  title: string;
  shellType: string;
  icon: string;
}

/** The configured default profile, falling back to the first available one. */
export function resolveDefaultProfile<T extends ShellProfileLike>(
  shellProfiles: T[] | undefined,
  defaultProfileId: string | undefined,
): T | undefined {
  if (!shellProfiles || shellProfiles.length === 0) return undefined;
  return shellProfiles.find(p => p.id === defaultProfileId) || shellProfiles[0];
}

/** Appends " 1", " 2", … to baseName until it no longer collides with existingTitles. */
export function generateUniqueTabName(existingTitles: string[], baseName: string): string {
  let counter = 1;
  let uniqueName = baseName;

  while (existingTitles.includes(uniqueName)) {
    uniqueName = `${baseName} ${counter}`;
    counter++;
  }

  return uniqueName;
}

/** Builds the Tab fields for a brand-new tab using the given profile. */
export function buildNewTabFields(profile: ShellProfileLike, existingTitles: string[]): NewTabFields {
  return {
    id: generateId('tb'),
    title: generateUniqueTabName(existingTitles, profile.name),
    shellType: profile.id,
    icon: '🖥️',
  };
}
