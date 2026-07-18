export { TerminalEngine, DEFAULT_THEME } from './TerminalEngine';
export {
  terminalCache,
  pasteToTerminal,
  cleanupTerminalCache,
  resetTerminalRendering,
  disableWebGLGlobally,
  enableWebGLGlobally,
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
