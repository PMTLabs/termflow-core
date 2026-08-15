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
 * still read so an event from an older backend does not crash — but review 099
 * T2-F3 found that "keeps working" was too strong a claim for a legacy SPLIT
 * event: see the leafId fallback below for the corrected (degraded, not
 * regressed) behaviour.
 */
export function resolveApiCreateIds(detail: {
  terminalId?: string;
  tabId?: string;
  processId?: string;
  rendererTerminalId?: string;
  owningTabId?: string;
}): ApiCreateIds {
  const owningTabId = detail.owningTabId ?? detail.tabId;
  const processId = detail.processId ?? detail.terminalId;
  return {
    processId,
    // Before P0-A no leaf was sent. Every consumer of `leafId` (App.tsx Mode 1
    // and Mode 2) is minting a NEW sibling pane in a tab that may already have
    // an occupied root pane whose leaf === owningTabId — so falling back to
    // owningTabId here would hand that new pane the root's own leaf, which
    // App.tsx then rebinds in TerminalService and inserts a second pane-tree
    // node carrying it, corrupting both the root's PTY mapping and the tree's
    // identity uniqueness (review 099 T2-F3). Fall back to the unique
    // `processId` instead: this reproduces the exact pre-P0-A behaviour, where
    // a process id briefly doubles as a leaf until StateManager.sanitizeLayoutData
    // remaps it to a fresh `tm-*` on the next restore (design 011 §6) — a known,
    // already-handled degradation, not a fresh collision. `owningTabId` remains
    // the final fallback only for the no-ids-at-all case.
    leafId: detail.rendererTerminalId ?? processId ?? owningTabId,
    owningTabId,
  };
}

/**
 * Dependencies `runApiCreateMode0` needs from its caller, injected so the
 * function is unit-testable without mounting `App.tsx` or its IPC/store
 * plumbing. Production (`App.tsx handleAPICreateTerminalTab`) supplies real
 * store/terminalService bindings; tests supply a real Redux store's dispatch
 * plus lightweight fakes for the rest.
 */
export interface ApiCreateMode0Deps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dispatch: (action: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generateId: (prefix: any) => string;
  defaultProfile?: string;
  /** Bind the backend PTY to the pane's leaf id — same role as
   *  `terminalService.registerExistingTerminal`. */
  registerExistingTerminal: (leafId: string, processId: string) => void;
  /** The module-scoped `window.tabPanes` map (or a test double for it). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tabPanes: Record<string, any>;
  /** True if a tab with this id already exists in the store. */
  tabExists: (id: string) => boolean;
  activateOnApiCreate: boolean;
  tabCount: number;
  /** Fired once the UI tab is ready — mirrors the `api:terminalTabCreated`
   *  IPC notify. Optional so tests that don't care can omit it. */
  notifyTabCreated?: (payload: { terminalId?: string; tabId: string; name?: string }) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addTab: (tab: any) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addTabTree: (payload: { tabId: string; tree: any }) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setActiveTab: (tabId: string) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setActiveTabId: (tabId: string) => any;
}

export interface ApiCreateMode0Result {
  targetTabId: string;
  /** The leaf the pane tree's root node ends up carrying — `tm-*` for an
   *  API-created tab, per option A. */
  leafId?: string;
  paneTree: { id: string; type: 'terminal'; terminalId?: string; name?: string; shellType?: string };
}

/**
 * Mode 0 of `api:createTerminalTab`: create a brand-new UI tab for a
 * backend-spawned terminal that has no open UI tab yet (e.g. an agent created
 * it via the API/MCP). Extracted from `App.tsx handleAPICreateTerminalTab` so
 * it can be exercised directly by a test that drives the REAL code path
 * (review 109 MEDIUM) instead of hand-assembling the tree/registration the
 * production ordering is supposed to produce.
 *
 * Mirrors `App.tsx` exactly: seed the window `tabPanes` map AND dispatch
 * `addTabTree` in the SAME synchronous block as `addTab`, before returning —
 * that ordering is what keeps `TerminalContainer`'s default-seed effect from
 * ever overwriting an API tab's `tm-*` leaf with `tab.id`.
 */
export function runApiCreateMode0(
  detail: {
    name?: string;
    profile?: string;
    processId?: string;
    terminalId?: string;
    rendererTerminalId?: string;
    owningTabId?: string;
    tabId?: string;
  },
  deps: ApiCreateMode0Deps,
): ApiCreateMode0Result {
  const { name, profile } = detail;
  const { processId: terminalId, leafId, owningTabId } = resolveApiCreateIds(detail);
  const tabId = owningTabId;

  const targetTabId = tabId || deps.generateId('tb');

  // Bind the backend PTY to the LEAF id (the `tm-*` the pane tree below is
  // given), not to the tab id — must match the pane tree's terminalId or
  // TerminalPane's mount effect finds no registered process and spawns a
  // duplicate PTY.
  if (leafId && terminalId) {
    deps.registerExistingTerminal(leafId, terminalId);
  }

  const newTab = buildApiCreatedTab({ targetTabId, name, profile, defaultProfile: deps.defaultProfile });

  const paneTree: ApiCreateMode0Result['paneTree'] = {
    id: deps.generateId('pn'),
    type: 'terminal',
    terminalId: leafId,
    name: name || 'Terminal',
    shellType: profile || deps.defaultProfile || 'default',
  };

  // Seed the window map (API/persistence) AND the authoritative Redux store
  // (which TerminalContainer renders from) so the tab shows immediately —
  // BEFORE the tab itself enters the `tabs` slice, so a tree-less window
  // never exists for this tab.
  deps.tabPanes[targetTabId] = paneTree;

  const shouldActivate = deps.activateOnApiCreate || deps.tabCount === 0;
  deps.dispatch(deps.addTab({ ...newTab, isActive: shouldActivate }));
  deps.dispatch(deps.addTabTree({ tabId: targetTabId, tree: paneTree }));
  if (shouldActivate) {
    deps.dispatch(deps.setActiveTab(targetTabId));
    deps.dispatch(deps.setActiveTabId(targetTabId));
  }

  deps.notifyTabCreated?.({ terminalId, tabId: targetTabId, name });

  return { targetTabId, leafId, paneTree };
}
