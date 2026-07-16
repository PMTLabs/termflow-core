import type { RootState } from './index';
import { findTabIdByTerminalId, getSelectedPaneId, findLeaf } from './slices/paneTreeOps';
import { getSchemaTheme } from './colorSchemas';
import {
  applyColorSchemaToTerminals,
  setAgentColorLock,
  setEndedRegionColorsFor,
} from '@termflow/terminal-core';
import { blendEndedTint, endedRailColor } from './endedTint';

/**
 * Effective color-schema id for a single terminal, resolving the three override
 * levels in priority order:
 *   agent override (a mapped agent is running in this pane)  — highest
 *   ?? per-tab override (tab.colorSchemaId)
 *   ?? global default (settings.colorSchemaId)               — lowest
 *
 * `agentFor` returns the effective agent label for a terminal (detected or
 * sticky; see AgentSchemeTracker), or null when no agent override applies.
 */
export function resolveSchemaId(
  terminalId: string,
  state: RootState,
  agentFor: (id: string) => string | null,
): string {
  const agent = agentFor(terminalId);
  const agentSchema = agent ? state.settings.agentColorSchemes[agent] : undefined;
  if (agentSchema) return agentSchema;
  const tabId = findTabIdByTerminalId(state.panes.treesByTabId, terminalId);
  const tab = tabId ? state.tabs.tabs.find((t) => t.id === tabId) : undefined;
  return tab?.colorSchemaId ?? state.settings.colorSchemaId;
}

/** Scope `--terminal-display-background` to a single pane's element so the slack
 *  padding + scrollbar track behind xterm's canvas match THAT pane's scheme —
 *  split panes with different schemes no longer share one global background. The
 *  var is read locally by `.terminal-display` and its descendant `.xterm-viewport`
 *  scrollbar pseudo-elements. No-op outside the browser / before the pane mounts. */
export function setPaneBackgroundVar(terminalId: string, background: string | undefined): void {
  if (typeof document === 'undefined' || !background) return;
  const el = document.querySelector(
    `.terminal-display[data-terminal-id="${CSS.escape(terminalId)}"]`,
  ) as HTMLElement | null;
  el?.style.setProperty('--terminal-display-background', background);
}

/**
 * Recompute and apply the effective theme for each of the given terminals.
 * Mirrors the App.tsx per-tab apply, but routed through resolveSchemaId so the
 * per-pane agent override is honored and never clobbered. Also scopes each pane's
 * background var so its surrounding chrome matches its own scheme.
 */
export function applyEffectiveThemes(
  terminalIds: string[],
  state: RootState,
  agentFor: (id: string) => string | null,
): void {
  for (const id of terminalIds) {
    const theme = getSchemaTheme(resolveSchemaId(id, state, agentFor));
    applyColorSchemaToTerminals(theme, [id]);
    setPaneBackgroundVar(id, theme.background);
    // The ended-program marks must be pre-blended (xterm's decoration colours take
    // no alpha) and recomputed whenever the effective scheme changes — including a
    // per-agent override. This is where scheme changes actually land; the pane
    // component never re-renders for them.
    setEndedRegionColorsFor([id], blendEndedTint(theme.background), endedRailColor(theme.background));
    // Lock the pane's colors ONLY when an assigned agent override owns it, so the
    // agent's own color-control sequences can't overwrite our scheme (colorGuard).
    // Plain shells / unmapped agents stay unlocked → normal terminal behavior.
    const agent = agentFor(id);
    setAgentColorLock([id], !!(agent && state.settings.agentColorSchemes[agent]));
  }
}

/** Effective schema id for the active tab's selected pane, so surrounding chrome
 *  (the wrapper/scrollbar slack behind xterm's canvas) can match an agent
 *  override too. Falls back to the active tab's own schema when the pane's
 *  terminal can't be resolved. */
export function resolveActivePaneSchemaId(
  state: RootState,
  agentFor: (id: string) => string | null,
): string {
  const activeTabId = state.tabs.activeTabId;
  const trees = state.panes.treesByTabId;
  if (activeTabId) {
    const paneId = getSelectedPaneId(trees, state.panes.activePaneByTabId, activeTabId);
    const termId = paneId ? findLeaf(trees[activeTabId] ?? null, paneId)?.terminalId : undefined;
    if (termId) return resolveSchemaId(termId, state, agentFor);
  }
  const activeTab = state.tabs.tabs.find((t) => t.id === activeTabId);
  return activeTab?.colorSchemaId ?? state.settings.colorSchemaId;
}

/** Set the `--terminal-display-background` CSS var to the active pane's effective
 *  background. Shared by App's schema effect and the AgentSchemeTracker so an
 *  agent override updates the slack background live. No-op outside the browser. */
export function applyActivePaneBackground(
  state: RootState,
  agentFor: (id: string) => string | null,
): void {
  if (typeof document === 'undefined') return;
  const id = resolveActivePaneSchemaId(state, agentFor);
  document.documentElement.style.setProperty('--terminal-display-background', getSchemaTheme(id).background);
}
