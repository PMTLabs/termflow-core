// Type-only, for the reason `canvasSelectors` gives: a value import of `./index` would build the
// real Redux store (and everything it imports) just to read a type.
import { useSelector } from 'react-redux';
import type { RootState } from './index';
import { findTabIdByTerminalId } from './slices/paneTreeOps';

/**
 * Where a title's colour comes from, for every surface that shows one.
 *
 * A tab's `titleColor` is the ONE home for this: no pane, node or row carries a colour of its own,
 * so anything naming a terminal or a tab asks here rather than being handed a copy. That is what
 * makes an API/MCP-created pane inherit with nothing to copy, and what makes a colour change or
 * reset reach every surface at once.
 *
 * These live beside `terminalTheme.ts` — the same shape of question (which appearance does this
 * terminal get?) resolved through the store rather than duplicated at each consumer.
 */

/** The colour a TAB's own titles wear, or undefined when it has none. */
export function tabTitleColor(state: RootState, tabId?: string): string | undefined {
  if (!tabId) return undefined;
  return state.tabs.tabs.find((t) => t.id === tabId)?.titleColor;
}

/**
 * The colour a TERMINAL's titles wear — its owning tab's.
 *
 * Resolved through the pane tree, NOT by matching `t.id === terminalId`: that equality only ever
 * held for a renderer-created tab root and design 014 removed it, so the naive lookup silently
 * matches nothing for every pane in the app.
 */
export function terminalTitleColor(state: RootState, terminalId?: string): string | undefined {
  if (!terminalId) return undefined;
  const owner = findTabIdByTerminalId(state.panes.treesByTabId, terminalId);
  return tabTitleColor(state, owner ?? undefined);
}

/**
 * The single home for the "omit the style entirely" rule.
 *
 * Returning `undefined` rather than `{ color: undefined }` is the whole point: a tab with no
 * colour must leave its titles on whatever the stylesheet already decides, so there is no inline
 * property to override a state rule (`.canvas-node.ended`, a rename input's own colour) with.
 */
export function titleColorStyle(color?: string): { color: string } | undefined {
  return color ? { color } : undefined;
}

/** `tabTitleColor` for a component. */
export const useTabTitleColor = (tabId?: string): string | undefined =>
  useSelector((s: RootState) => tabTitleColor(s, tabId));

/** `terminalTitleColor` for a component. */
export const useTerminalTitleColor = (terminalId?: string): string | undefined =>
  useSelector((s: RootState) => terminalTitleColor(s, terminalId));
