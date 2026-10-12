// Type-only, for the reason `canvasSelectors` gives: a value import of `./index` would build the
// real Redux store (and everything it imports) just to read a type.
import { useSelector } from 'react-redux';
import type { RootState } from './index';
import { findTabIdByTerminalId, findLeafByTerminalId, getPaneLeaves } from './slices/paneTreeOps';

export const TAB_NAME_COLORS: { name: string; hex: string }[] = [
  { name: 'Red', hex: '#FF3B3B' },
  { name: 'Orange', hex: '#FF8C1A' },
  { name: 'Yellow', hex: '#FFE81A' },
  { name: 'Lime', hex: '#9CF52A' },
  { name: 'Green', hex: '#22C94E' },
  { name: 'Teal', hex: '#19B39B' },
  { name: 'Cyan', hex: '#22E5FF' },
  { name: 'Sky', hex: '#8FCBFF' },
  { name: 'Blue', hex: '#3F6DFF' },
  { name: 'Purple', hex: '#A85CFF' },
  { name: 'Magenta', hex: '#FF3DE0' },
  { name: 'Pink', hex: '#FFA0D2' },
  { name: 'Brown', hex: '#C9925A' },
  { name: 'Olive', hex: '#B8B84A' },
];

/** The colour a TAB's own titles wear, or undefined when it has none. */
export function tabTitleColor(state: RootState, tabId?: string): string | undefined {
  if (!tabId) return undefined;
  return state.tabs.tabs.find((t) => t.id === tabId)?.titleColor;
}

/**
 * The colour a TERMINAL's titles wear — its own pane colour if set, otherwise its owning tab's.
 */
export function terminalTitleColor(state: RootState, terminalId?: string): string | undefined {
  if (!terminalId) return undefined;
  const leaf = findLeafByTerminalId(state.panes.treesByTabId, terminalId);
  if (leaf?.titleColor) return leaf.titleColor;
  const owner = findTabIdByTerminalId(state.panes.treesByTabId, terminalId);
  return tabTitleColor(state, owner ?? undefined);
}

/**
 * Resolves the effective title colour(s) for a tab.
 * If the tab has multiple panes with different colours, returns an array of colours
 * in pane order to render multi-colour text. Otherwise returns a single colour or undefined.
 */
export function tabEffectiveTitleColors(
  state: RootState,
  tabId?: string,
): string | string[] | undefined {
  if (!tabId) return undefined;
  const tab = state.tabs.tabs.find((t) => t.id === tabId);
  const tree = state.panes.treesByTabId[tabId];
  if (!tree) return tab?.titleColor;
  const leaves = getPaneLeaves(tree);
  if (leaves.length <= 1) {
    return leaves[0]?.titleColor ?? tab?.titleColor;
  }
  const paneColors = leaves.map(
    (l) => l.titleColor ?? tab?.titleColor ?? 'var(--tab-foreground, #cccccc)',
  );
  if (new Set(paneColors).size <= 1) {
    return leaves[0]?.titleColor ?? tab?.titleColor;
  }
  return paneColors;
}

/**
 * The single home for the "omit the style entirely" rule, supporting both single-colour
 * styles and multi-colour linear-gradient text styles.
 */
export function titleColorStyle(
  color?: string | string[],
): React.CSSProperties | undefined {
  if (!color) return undefined;
  if (Array.isArray(color)) {
    if (color.length === 0) return undefined;
    if (color.length === 1) return { color: color[0] };
    return {
      backgroundImage: `linear-gradient(90deg, ${color.join(', ')})`,
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      color: 'transparent',
      width: 'fit-content',
      maxWidth: '100%',
    };
  }
  return { color };
}

/** `tabTitleColor` for a component. */
export const useTabTitleColor = (tabId?: string): string | undefined =>
  useSelector((s: RootState) => tabTitleColor(s, tabId));

/** `terminalTitleColor` for a component. */
export const useTerminalTitleColor = (terminalId?: string): string | undefined =>
  useSelector((s: RootState) => terminalTitleColor(s, terminalId));

/** `tabEffectiveTitleColors` for a component. */
export const useTabEffectiveTitleColors = (
  tabId?: string,
): string | string[] | undefined =>
  useSelector(
    (s: RootState) => tabEffectiveTitleColors(s, tabId),
    (a, b) => {
      if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((v, i) => v === b[i]);
      }
      return a === b;
    },
  );
