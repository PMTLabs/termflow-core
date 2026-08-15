export { TerminalEngine, DEFAULT_THEME } from './TerminalEngine';
export type { RelocationResult } from './TerminalEngine';
export {
  terminalCache,
  pasteToTerminal,
  cleanupTerminalCache,
  resetTerminalRendering,
  disableWebGLGlobally,
  enableWebGLGlobally,
  refreshGlyphAtlases,
  applyColorSchemaGlobally,
  applyColorSchemaToTerminals,
  setAgentColorLock,
} from './cache';
export { shouldBlockColorOsc, COLOR_OSC_CODES } from './colorGuard';
export { isWebGLGloballyDisabled } from './webgl';
export { redactSecrets } from './redactSecrets';
export {
  HeuristicCapture,
  decideSuggestKey,
} from './commandCapture';
export type {
  SuggestAction,
  SuggestPopupState,
  CommandBoundaryTracker,
} from './commandCapture';
export type {
  TerminalBridge,
  TerminalEngineOptions,
  TerminalSnapshot,
  TerminalSearchOptions,
  TerminalSearchResult,
  Disposable,
  ContextMenuActions,
  PromptGate,
} from './types';
export {
  EndedRegionTracker,
  setEndedRegionColorsFor,
  registerEndedRegionTracker,
  unregisterEndedRegionTracker,
} from './endedRegions';

// design/013 (P0-C) — the render-policy surface Canvas Mode consumes.
export {
  setTerminalRenderPolicy,
  getTerminalRenderPolicy,
  countActiveWebGLAddons,
  setCanvasWebGLBudget,
  releaseCanvasWebGLBudget,
  getCanvasWebGLBudget,
  webglAllowedAtCreation,
  disposeOrphanedWebGLAddon,
  hasLayoutBox,
  fitIfLaidOut,
} from './renderPolicy';
export type { RenderPolicy } from './renderPolicy';
export {
  reconcileRenderPolicies,
  snapshotRenderPolicies,
  restoreRenderPolicies,
} from './renderPolicyReconciler';
export type { RenderPolicySnapshot, ReconcileInput } from './renderPolicyReconciler';
