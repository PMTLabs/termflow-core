/**
 * Pure, unit-testable helper for building the Tab fields used when the API/MCP
 * layer creates a new tab (see App.tsx handleAPICreateTerminalTab, Mode 0 and
 * Mode 3 — the two branches that create a brand-new tab from an API/MCP call).
 *
 * Kept free of React/Redux so the titleIsCustom decision can be tested in
 * isolation (see __tests__/apiCreatedTab.test.ts).
 */

export interface ApiCreatedTabOptions {
  targetTabId: string;
  name?: string;
  profile?: string;
  defaultProfile?: string;
  /** Title used when no name is supplied. Defaults to `Terminal (${profile || 'default'})` (Mode 0's convention). */
  fallbackTitle?: string;
  /** shellType fallback when neither profile nor defaultProfile is set. Defaults to 'default' (Mode 0's convention; Mode 3 uses 'cmd'). */
  shellTypeFallback?: string;
}

export interface ApiCreatedTabFields {
  id: string;
  title: string;
  shellType: string;
  icon: string;
  titleIsCustom?: true;
}

/**
 * An explicitly-supplied `name` must pin the title (titleIsCustom: true) so
 * the tab's first OSC dynamic-title event from the shell doesn't silently
 * overwrite the caller-supplied name. An empty-string name is treated the
 * same as "not supplied" (falls through to the fallback title), matching the
 * pre-existing `name || fallback` convention this replaces.
 */
export function buildApiCreatedTab(options: ApiCreatedTabOptions): ApiCreatedTabFields {
  const { targetTabId, name, profile, defaultProfile, fallbackTitle, shellTypeFallback = 'default' } = options;

  const tab: ApiCreatedTabFields = {
    id: targetTabId,
    title: name || fallbackTitle || `Terminal (${profile || 'default'})`,
    shellType: profile || defaultProfile || shellTypeFallback,
    icon: '🖥️',
  };

  if (name) {
    tab.titleIsCustom = true;
  }

  return tab;
}

/** The three ids an `api:createTerminalTab` event can carry. */
export interface ApiCreateIds {
  /** Backend PTY id (`pc-*`) to bind the pane to. */
  processId?: string;
  /** Renderer pane-tree leaf (`tb-*` root, `tm-*` split). */
  leafId?: string;
  /** The tab that owns the leaf (`tb-*`). */
  owningTabId?: string;
}

/**
 * Disambiguate the event payload. `terminalId` on THIS event has always been the
 * backend PROCESS id (api_server.rs `create_terminal` emit), unlike a REST
 * response where it is the leaf — which is exactly why P0-A added the explicit
 * `processId` / `rendererTerminalId` / `owningTabId` keys. The legacy keys are
 * still read so an event from an older backend keeps working.
 */
export function resolveApiCreateIds(detail: {
  terminalId?: string;
  tabId?: string;
  processId?: string;
  rendererTerminalId?: string;
  owningTabId?: string;
}): ApiCreateIds {
  const owningTabId = detail.owningTabId ?? detail.tabId;
  return {
    processId: detail.processId ?? detail.terminalId,
    // Before P0-A no leaf was sent; the owning tab was the only renderer id
    // available, and it IS the leaf for a root pane.
    leafId: detail.rendererTerminalId ?? owningTabId,
    owningTabId,
  };
}
