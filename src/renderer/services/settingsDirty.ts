/**
 * Pure, dependency-free dirty detection for the settings screen (Approach 1).
 * A baseline snapshot of a category's *tracked* fields is captured on entry;
 * `isCategoryDirty` compares the current values against it. Connections is NOT a
 * tracked category — it owns a separate apply/restart flow.
 */
export type TrackedCategory = 'appearance' | 'terminal' | 'profiles' | 'shortcuts';

/** Structural subset of the settings slice that this module reads. */
export interface TrackedSettings {
  fontSize: number;
  tabSizingMode: string;
  fixedTabWidth: number;
  colorSchemaId: string;
  nonFocusedPaneOpacity: number;
  agentColorSchemes: Record<string, string>;
  closeTabOnProcessExit: boolean;
  smartCtrlC: boolean;
  enhancedKeyboard: boolean;
  commandSuggestions: boolean;
  activateTabOnApiCreate: boolean;
  defaultEditor: string;
  defaultProfile: string;
  shellProfiles: Array<{ id: string; cwd?: string }>;
  customKeybindings: Record<string, string>;
}

export type CategorySnapshot =
  | {
      kind: 'appearance';
      fontSize: number;
      tabSizingMode: string;
      fixedTabWidth: number;
      colorSchemaId: string;
      nonFocusedPaneOpacity: number;
      // Stored as a key-sorted [agent, schemaId][] so JSON.stringify comparison is
      // order-independent (the map's insertion order must not affect dirtiness).
      agentColorSchemes: Array<[string, string]>;
    }
  | {
      kind: 'terminal';
      closeTabOnProcessExit: boolean;
      smartCtrlC: boolean;
      enhancedKeyboard: boolean;
      commandSuggestions: boolean;
      activateTabOnApiCreate: boolean;
      defaultEditor: string;
    }
  | { kind: 'profiles'; defaultProfile: string; cwds: Array<{ id: string; cwd: string }> }
  | { kind: 'shortcuts'; customKeybindings: Array<[string, string]> };

export function snapshotCategory(category: TrackedCategory, s: TrackedSettings): CategorySnapshot {
  switch (category) {
    case 'appearance':
      return {
        kind: 'appearance',
        fontSize: s.fontSize,
        tabSizingMode: s.tabSizingMode,
        fixedTabWidth: s.fixedTabWidth,
        colorSchemaId: s.colorSchemaId,
        nonFocusedPaneOpacity: s.nonFocusedPaneOpacity,
        agentColorSchemes: Object.entries(s.agentColorSchemes).sort((a, b) => a[0].localeCompare(b[0])),
      };
    case 'terminal':
      return {
        kind: 'terminal',
        closeTabOnProcessExit: s.closeTabOnProcessExit,
        smartCtrlC: s.smartCtrlC,
        enhancedKeyboard: s.enhancedKeyboard,
        commandSuggestions: s.commandSuggestions,
        activateTabOnApiCreate: s.activateTabOnApiCreate,
        defaultEditor: s.defaultEditor,
      };
    case 'profiles':
      return {
        kind: 'profiles',
        defaultProfile: s.defaultProfile,
        // Normalize undefined cwd → '' so a snapshot is stably comparable.
        cwds: s.shellProfiles.map((p) => ({ id: p.id, cwd: p.cwd ?? '' })),
      };
    case 'shortcuts':
      return {
        kind: 'shortcuts',
        customKeybindings: Object.entries(s.customKeybindings).sort((a, b) => a[0].localeCompare(b[0])),
      };
  }
}

export function isCategoryDirty(
  category: TrackedCategory,
  s: TrackedSettings,
  baseline: CategorySnapshot,
): boolean {
  // Snapshots are constructed with a fixed key order, so stringify is a stable
  // deep-equality here.
  return JSON.stringify(snapshotCategory(category, s)) !== JSON.stringify(baseline);
}
