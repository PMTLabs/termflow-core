import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
// import cycle is safe: cross-refs are call-time only (never at module load)
import { terminalCache } from './cache';
import { quarantineWebGLAddon, releaseFromWebGLQuarantine } from './renderPolicy';

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

  // Hoisted so the catch below can dispose an addon that was CONSTRUCTED and then
  // failed during onContextLoss registration or loadAddon/activate. Construction is
  // where a real WebglAddon acquires its GPU context, so returning null without
  // disposing here leaves a live context that is reachable from nothing and counted
  // by nothing (design/013 §5.2 ORPHAN, review 120).
  let webgl: WebglAddon | null = null;

  // True once `term.loadAddon()` has been ENTERED. From that instant a failure is
  // AMBIGUOUS: it may have leaked a live context that no object owns (round 8 CRITICAL).
  //
  // `@xterm/addon-webgl@0.19.0`'s `activate()` evaluates `new WebglRenderer(...)` BEFORE
  // `_register` captures it (WebglAddon.ts:73). Inside that constructor the order is:
  // acquire the WebGL2 context, append the canvas to the live screen element
  // (WebglRenderer.ts:138), run `_initializeWebGLState()` (:140) — and only THEN register
  // the disposable that removes the canvas again (:143). A shader, atlas or driver error
  // from `_initializeWebGLState()` therefore leaves a DOM-attached canvas holding a real
  // context, owned by nothing: the renderer was never returned, so the addon never
  // registered it, so `addon.dispose()` has nothing to dispose and SUCCEEDS.
  //
  // A succeeding dispose is proof of release only when the addon actually owned the
  // resource. Past this point it does not, so it proves nothing.
  let activationAttempted = false;

  try {
    const addon = new WebglAddon();
    webgl = addon;

    addon.onContextLoss(() => {
      console.warn(`terminal-core/webgl: WebGL context lost for ${terminalId}, disposing addon`);
      try {
        addon.dispose();
      } catch (e) {
        // Ignore disposal errors
      }

      // Update cache to reflect WebGL is no longer active — but ONLY if the cache
      // still holds THIS addon.
      //
      // The handler closes over `terminalId`, not over cache ownership, so it can
      // outlive the addon's tenure. That became reachable by design once the
      // quarantine let a failed-disposal addon survive its entry (review 126):
      // addon A is quarantined, the same terminal is later promoted onto addon B,
      // then A reports context loss. Without this check A's handler would clear B
      // from the cache and bump B's generation, leaving B live but unreachable —
      // and a later drain of A would then drop the count to zero while B still
      // holds a context, letting the next allocation exceed the real budget.
      //
      // A stale handler must never mutate a replacement. Disposing A above is
      // still correct: that is A's own context, and dispose() is idempotent.
      const cached = terminalCache.get(terminalId);
      if (cached && cached.webglAddon === addon) {
        cached.webglAddon = null;
        cached.useWebGL = false;
        // design/013 D6: a NON-Canvas policy change. Bumping this invalidates any
        // canvas snapshot taken before it, so leaving canvas mode cannot promote
        // this terminal back onto a context the GPU just took away (review 124).
        cached.nonCanvasPolicyGeneration = (cached.nonCanvasPolicyGeneration ?? 0) + 1;
      }
      // The context is gone, so whatever we were unable to free before is now moot
      // for THIS addon: release it from quarantine so a driver hiccup does not tax
      // the budget forever. Only this addon — never the whole registry.
      releaseFromWebGLQuarantine(addon);
    });

    activationAttempted = true;
    term.loadAddon(addon);
    console.log(`terminal-core/webgl: WebGL addon loaded for ${terminalId}`);
    return addon;
  } catch (e) {
    console.warn(`terminal-core/webgl: WebGL addon could not be loaded for ${terminalId}:`, e);
    // `webgl` is null when the CONSTRUCTOR threw (nothing to release); non-null when a
    // later step did, and then this is the only reference that will ever exist to it.
    if (webgl) {
      let disposeFailed = false;
      try {
        webgl.dispose();
      } catch (disposeErr) {
        disposeFailed = true;
        console.warn(
          `terminal-core/webgl: error disposing the addon that failed to load for ${terminalId}:`,
          disposeErr,
        );
      }
      // Review 124 HIGH — the same ownership rule as the create path. This addon was
      // CONSTRUCTED (so it may hold a context) and we are about to return null, dropping
      // the only reference that will ever exist to it. Hand it to the quarantine, which
      // keeps it counted against the budget PERMANENTLY (rev 15: there is no retry, and
      // the context-loss release cannot reach a quarantined addon — see the quarantine
      // registry's comment in renderPolicy.ts).
      //
      // Charged on EITHER of two conditions (round 8 CRITICAL widened this from one):
      //
      //   disposeFailed        — the addon refused release, so it certainly still holds.
      //   activationAttempted  — the failure came from inside `loadAddon`/`activate`,
      //                          where a partially-built WebglRenderer can have leaked a
      //                          DOM-attached canvas and a live context that the addon
      //                          never took ownership of. Here `dispose()` SUCCEEDING is
      //                          not evidence of anything: it had nothing to dispose.
      //
      // Charging an activation failure that happened to leak nothing costs one budget
      // slot for the renderer's lifetime. NOT charging one that did leak costs an
      // uncounted live context per attempt, without bound, while every budget check sees
      // zero added holders. A hard budget may only ever fail in the safe direction, and
      // that is this one.
      //
      // The real remedy is at the dependency boundary — the addon must install its canvas
      // cleanup immediately after acquisition rather than after initialisation — and is
      // recorded in design/013 §6.1 as unprovable from here.
      if (disposeFailed || activationAttempted) quarantineWebGLAddon(webgl);
    }
    return null;
  }
};
