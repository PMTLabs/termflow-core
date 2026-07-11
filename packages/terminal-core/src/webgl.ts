import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
// import cycle is safe: cross-refs are call-time only (never at module load)
import { terminalCache } from './cache';

// Track global WebGL failure - if one terminal fails, disable for all new terminals.
// WebGL is the default renderer: it draws box-drawing/block glyphs as CUSTOM GLYPHS
// (filling the whole cell), so TUI borders (codex/ratatui) render solid even at
// lineHeight > 1 — the DOM renderer draws them as font glyphs that gap. The "rendering
// corruption with complex TUI apps" that previously forced this off was the xterm
// `windowsMode` wrapping heuristic (now fixed via windowsPty — see TerminalEngine), NOT
// WebGL itself. onContextLoss (below) still falls back to the DOM renderer if a GPU
// context is lost, and the context-menu toggle lets users disable it per session.
let globalWebGLDisabled = false;

// Spec §17 R8: the main-app wrapper needs this for the context-menu label.
export const isWebGLGloballyDisabled = (): boolean => globalWebGLDisabled;

// Internal setter — flips the global flag (used by cache.ts disable/enable helpers).
export const setWebGLGloballyDisabled = (v: boolean): void => {
  globalWebGLDisabled = v;
};

// Helper to safely load WebGL addon with fallback.
// Behavior ported from the legacy renderer terminal component. The cache Map is
// imported so the context-loss handler can update the matching entry by id
// (terminalCache.get(terminalId)).
export const loadWebGLAddon = (term: Terminal, terminalId: string): WebglAddon | null => {
  if (globalWebGLDisabled) {
    console.log(`terminal-core/webgl: WebGL globally disabled, using canvas for ${terminalId}`);
    return null;
  }

  try {
    const webgl = new WebglAddon();

    webgl.onContextLoss(() => {
      console.warn(`terminal-core/webgl: WebGL context lost for ${terminalId}, disposing addon`);
      try {
        webgl.dispose();
      } catch (e) {
        // Ignore disposal errors
      }

      // Update cache to reflect WebGL is no longer active
      const cached = terminalCache.get(terminalId);
      if (cached) {
        cached.webglAddon = null;
        cached.useWebGL = false;
      }
    });

    term.loadAddon(webgl);
    console.log(`terminal-core/webgl: WebGL addon loaded for ${terminalId}`);
    return webgl;
  } catch (e) {
    console.warn(`terminal-core/webgl: WebGL addon could not be loaded for ${terminalId}:`, e);
    return null;
  }
};
