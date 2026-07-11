import { store } from '../store';
import { addTab, setActiveTab } from '../store/slices/tabsSlice';
import { splitPane, toggleMaximizePane } from '../store/slices/panesSlice';
import { terminalService } from './TerminalService';
import { pasteToTerminal } from '@termflow/terminal-core';
import { readClipboardText } from '../utils/clipboard';
import { isEditableNonTerminalTarget } from './inputTargets';
import { runSettingsGuard } from './settingsNavGuard';
import { openSettingsTab } from './openSettings';
import { resolveDefaultProfile, buildNewTabFields } from './newTabActions';
import { SHORTCUT_ACTIONS, canonicalizeCombo } from './shortcutActions';

export class InputHandler {
  private shortcuts: Map<string, () => void | Promise<void>>;
  private enabled: boolean = true;

  // Stored so removeEventListener can actually detach it — the old
  // `this.handleKeyEvent.bind(this)` result was unreferenced and permanent.
  private readonly boundKeyHandler = (event: KeyboardEvent): void => {
    this.handleKeyEvent(event);
  };

  constructor() {
    this.shortcuts = new Map();
    this.registerDefaultShortcuts();
    this.setupKeyboardListener();
  }

  private registerDefaultShortcuts(): void {
    // Tab management
    // Ctrl+T (new tab) intentionally NOT registered — disabled per request
    // (the old handler here duplicated the "+" button with a bare hardcoded
    // tab, bypassing default-profile resolution and unique naming).
    this.registerShortcut(this.defaultComboFor('newTab'), this.handleNewTab);
    this.registerShortcut(this.defaultComboFor('closeTab'), this.handleCloseTab);
    this.registerShortcut(this.defaultComboFor('nextTab'), this.handleNextTab);
    this.registerShortcut(this.defaultComboFor('prevTab'), this.handlePrevTab);

    // Tab navigation by number — fixed, not user-customizable (see shortcutActions.ts).
    for (let i = 1; i <= 9; i++) {
      this.registerShortcut(`Ctrl+${i}`, () => this.handleTabByNumber(i));
    }

    // Pane management
    // Note: Ctrl+D is intentionally NOT bound here. It must pass through to the
    // terminal so xterm sends EOF (0x04), terminating the foreground process —
    // standard terminal behavior. Vertical split is available via the pane toolbar.
    this.registerShortcut(this.defaultComboFor('splitHorizontal'), this.handleSplitHorizontal);
    this.registerShortcut(this.defaultComboFor('closePane'), this.handleClosePane);
    this.registerShortcut(this.defaultComboFor('toggleMaximizePane'), this.handleToggleMaximizePane);

    // Pane navigation — stub (no real behavior yet), fixed, not user-customizable.
    this.registerShortcut('Alt+ArrowLeft', () => this.handlePaneNavigation('left'));
    this.registerShortcut('Alt+ArrowRight', () => this.handlePaneNavigation('right'));
    this.registerShortcut('Alt+ArrowUp', () => this.handlePaneNavigation('up'));
    this.registerShortcut('Alt+ArrowDown', () => this.handlePaneNavigation('down'));

    // Terminal actions
    // Note: Ctrl+C is handled directly in terminal for interrupt signal.
    // Note: Ctrl+Shift+C (copy) is intentionally NOT bound here. xterm's
    //   attachCustomKeyEventHandler copies the live selection correctly via
    //   term.getSelection() + clipboard.writeText(). Binding it here shadowed
    //   that handler (window-capture stopPropagation) with a no-op, because
    //   document.execCommand('copy') acts on the empty xterm-helper-textarea,
    //   not the rendered selection.
    // Note: Ctrl+A is intentionally NOT bound. It must pass through so the
    //   terminal sends 0x01 (readline: move to start of line). "Select All"
    //   remains available via the terminal right-click menu.
    this.registerShortcut(this.defaultComboFor('paste'), this.handlePaste);
    this.registerShortcut('Ctrl+Shift+V', this.handlePaste); // fixed secondary fallback, not customizable
    this.registerShortcut(this.defaultComboFor('clearTerminal'), this.handleClearTerminal);

    // Application
    // Open Settings. The key-combo layer below maps BOTH event.ctrlKey and
    // event.metaKey to 'control' (see handleKeyEvent), so this single
    // registration is OS-aware out of the box: Ctrl+, on Windows/Linux and
    // Cmd+, on macOS — matching every other shortcut in this app.
    this.registerShortcut(this.defaultComboFor('openSettings'), openSettingsTab);
    this.registerShortcut(this.defaultComboFor('toggleFullScreen'), this.handleToggleFullScreen);
    // Note: Ctrl/Cmd +/-/0 zoom is intentionally NOT bound here. Zoom is per-surface
    // (each terminal pane and the Settings screen own their level — see
    // TerminalEngine.onZoom / useSurfaceZoom). A global binding here would change
    // every pane at once and fight the per-surface handlers.

    // Snapshot what's now registered per customizable action so
    // applyKeybindingOverrides has a correct baseline before we touch `store`.
    this.appliedCombos = new Map(
      SHORTCUT_ACTIONS.map(a => [a.id, a.defaultCombo]),
    );

    // Defer the initial override-apply + store subscription to a microtask
    // instead of calling store.getState() synchronously here. Every other
    // `store` access in this class already defers to inside a handler
    // closure invoked long after startup, specifically to avoid touching
    // `store` during module evaluation/construction — this crashed the
    // whole renderer in practice ("Cannot read properties of undefined
    // (reading 'getState')") when a Hot Module Replacement re-execution of
    // this module ran before `store`'s own module had finished initializing.
    // By microtask time the synchronous module graph has fully settled.
    queueMicrotask(() => {
      // Guard against destroy() having run synchronously before this
      // microtask fired (found in final PR review — codex): without this,
      // a "destroyed" instance could still pick up a live store subscription
      // afterward, since destroy()'s teardown had nothing to unsubscribe yet.
      if (this.destroyed) return;
      this.applyKeybindingOverrides(store.getState().settings.customKeybindings);
      let lastSeenOverrides = store.getState().settings.customKeybindings;
      this.storeUnsubscribe = store.subscribe(() => {
        const current = store.getState().settings.customKeybindings;
        if (current !== lastSeenOverrides) {
          lastSeenOverrides = current;
          this.applyKeybindingOverrides(current);
        }
      });
    });
  }

  private defaultComboFor(actionId: string): string {
    const action = SHORTCUT_ACTIONS.find(a => a.id === actionId);
    if (!action) throw new Error(`InputHandler: unknown shortcut action id "${actionId}"`);
    return action.defaultCombo;
  }

  private appliedCombos: Map<string, string> = new Map();
  private storeUnsubscribe: (() => void) | null = null;
  private destroyed: boolean = false;

  private actionHandler(actionId: string): (() => void | Promise<void>) | undefined {
    const handlers: Record<string, () => void | Promise<void>> = {
      newTab: this.handleNewTab,
      closeTab: this.handleCloseTab,
      nextTab: this.handleNextTab,
      prevTab: this.handlePrevTab,
      splitHorizontal: this.handleSplitHorizontal,
      closePane: this.handleClosePane,
      toggleMaximizePane: this.handleToggleMaximizePane,
      paste: this.handlePaste,
      clearTerminal: this.handleClearTerminal,
      openSettings: openSettingsTab,
      toggleFullScreen: this.handleToggleFullScreen,
    };
    return handlers[actionId];
  }

  /**
   * Rebinds each customizable action to its override combo (or back to its
   * default if the override was removed). Diffs against what's currently
   * registered so it's a no-op when nothing changed. Unknown actionIds in
   * `customKeybindings` (e.g. stale data from a removed feature) are never
   * read, since the loop below only iterates SHORTCUT_ACTIONS.
   *
   * Runs as TWO full passes rather than one interleaved unregister+register
   * per action — a single pass breaks when two actions swap combos
   * (processing action A first would register it onto action B's old combo,
   * then processing B would unregister that same combo string, leaving A
   * unbound). Nothing is registered until every stale combo has already been
   * cleared.
   */
  applyKeybindingOverrides(customKeybindings: Record<string, string> = {}): void {
    const desiredByAction = new Map<string, string>(
      SHORTCUT_ACTIONS.map(a => [a.id, customKeybindings[a.id] ?? a.defaultCombo]),
    );

    // Phase 1: clear every action's current combo that's about to change.
    for (const action of SHORTCUT_ACTIONS) {
      const current = this.appliedCombos.get(action.id);
      const desired = desiredByAction.get(action.id)!;
      if (current && current !== desired) {
        this.unregisterShortcut(current);
      }
    }

    // Phase 2: claim every action's desired combo.
    for (const action of SHORTCUT_ACTIONS) {
      const current = this.appliedCombos.get(action.id);
      const desired = desiredByAction.get(action.id)!;
      if (current === desired) continue;

      const handler = this.actionHandler(action.id);
      if (!handler) continue;

      this.registerShortcut(desired, handler);
      this.appliedCombos.set(action.id, desired);
    }

    // The fixed Ctrl+Shift+V paste fallback lives outside appliedCombos (it's
    // not itself customizable) — guarantee it survives even if some action's
    // OLD combo happened to equal it and got cleared in phase 1 above (e.g.
    // paste was customized to Ctrl+Shift+V and then changed away again).
    this.registerShortcut('Ctrl+Shift+V', this.handlePaste);
  }

  registerShortcut(key: string, handler: () => void | Promise<void>): void {
    this.shortcuts.set(this.normalizeKey(key), handler);
  }

  unregisterShortcut(key: string): void {
    this.shortcuts.delete(this.normalizeKey(key));
  }

  private normalizeKey(key: string): string {
    return canonicalizeCombo(key);
  }

  private setupKeyboardListener(): void {
    window.addEventListener('keydown', this.boundKeyHandler, true);
  }

  /** Full teardown: disable AND detach the window listener. */
  destroy(): void {
    this.disable();
    this.destroyed = true;
    window.removeEventListener('keydown', this.boundKeyHandler, true);
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe();
      this.storeUnsubscribe = null;
    }
  }

  handleKeyEvent(event: KeyboardEvent): boolean {
    if (!this.enabled) return false;

    // Some keydown events carry no usable `key` (undefined) — e.g. autofill /
    // IME-injected events from WebView2, or synthetic events. They can never
    // match a shortcut, and calling `.toLowerCase()` on them throws. Bail out.
    if (typeof event.key !== 'string') return false;

    // When focus is in a regular form field (Settings inputs, dialogs, the
    // search bar) the user expects native editing — Ctrl+V paste, Ctrl+A select,
    // Ctrl+C/X copy/cut, Ctrl+Z undo. This window-capture handler otherwise
    // claims Ctrl+V (and other combos) and routes them to the terminal, so e.g.
    // the "Default editor" setting field could not be pasted into. The terminal
    // owns its OWN editable textarea (xterm-helper-textarea) and DOES rely on
    // this handler for paste, so we exempt it explicitly (see inputTargets.ts).
    if (isEditableNonTerminalTarget(event.target)) return false;

    // macOS: never let InputHandler claim plain "V" — it must reach the native layer.
    //  • Cmd+V must use the native paste path (Tauri Edit ▸ Paste / WebView default).
    //    A programmatic navigator.clipboard.readText() instead makes WebKit show its
    //    "Paste" confirmation popup for cross-app clipboard content. Native paste is
    //    user-initiated, so it pastes external content directly without that popup.
    //  • Ctrl+V must pass through to the focused terminal so foreground programs
    //    (e.g. Claude Code CLI's image paste) receive it as 0x16 (SYN).
    // (Ctrl+Shift+V and other platforms keep their existing paste behavior.)
    const isMac = typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac');
    if (isMac && event.key.toLowerCase() === 'v' &&
        (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      return false; // no preventDefault: let the native paste / PTY handle it
    }

    // Special handling for Ctrl+C when terminal is focused
    if (event.ctrlKey && event.key.toLowerCase() === 'c' && !event.shiftKey) {
      const activeElement = document.activeElement;
      // Check if focus is in a terminal
      if (activeElement && (activeElement.classList.contains('xterm') ||
        activeElement.closest('.terminal-display'))) {
        // Let the terminal handle Ctrl+C for interrupt
        return false;
      }
    }

    // Build a raw combo string from the live event, then canonicalize it with
    // the SAME function normalizeKey uses at registration time — the two can
    // no longer drift out of sync (that drift previously caused the arrow-key,
    // Cmd/Meta, and modifier-order matching bugs).
    const rawParts: string[] = [];
    if (event.ctrlKey || event.metaKey) rawParts.push('Ctrl');
    if (event.altKey) rawParts.push('Alt');
    if (event.shiftKey) rawParts.push('Shift');
    // '+' is also the combo-string delimiter, so the literal Plus key must be
    // mapped to the word "Plus" here too, mirroring the same mapping the
    // Settings recording UI applies when capturing it — otherwise a Plus-key
    // shortcut registers correctly but this live path builds "Ctrl++",
    // canonicalizes to "control+" (key lost, split as an empty segment), and
    // never matches "control+plus". Found in final PR review (agy): the
    // recording-side fix alone was incomplete without this counterpart.
    rawParts.push(event.key === '+' ? 'Plus' : event.key);

    const keyCombo = canonicalizeCombo(rawParts.join('+'));
    const handler = this.shortcuts.get(keyCombo);

    if (handler) {
      event.preventDefault();
      event.stopPropagation();
      handler.call(this);
      return true;
    }

    return false;
  }

  // Handler implementations
  // Goes through the same resolveDefaultProfile/buildNewTabFields helpers as
  // the "+" button (NewTabDropdown.createNewTab) so both paths agree on
  // default-profile resolution and unique naming.
  private handleNewTab = (): void => {
    const state = store.getState();
    const { shellProfiles, defaultProfile } = state.settings;
    const profile = resolveDefaultProfile(shellProfiles, defaultProfile);
    if (!profile) return;

    const newTab = buildNewTabFields(profile, state.tabs.tabs.map(tab => tab.title));
    store.dispatch(addTab(newTab));
  };

  private handleCloseTab = (): void => {
    const state = store.getState();
    const activeTab = state.tabs.tabs.find(tab => tab.isActive);
    if (!activeTab) return;
    // Route Ctrl+W through TabManager's close-confirmation flow (running-process
    // dialog + clean-exit "exit 0" skip + settings-dirty guard) rather than removing
    // the tab directly. This handler runs in the capture phase and stops propagation,
    // so it would otherwise shadow TabManager's own Ctrl+W handler and close without
    // confirming. handleCloseRequest (the ui:requestTabClose listener) owns the guards.
    window.dispatchEvent(new CustomEvent('ui:requestTabClose', { detail: { tabId: activeTab.id } }));
  };

  private handleNextTab = (): void => {
    const proceed = () => {
      const state = store.getState();
      const tabs = state.tabs.tabs;
      const currentIndex = tabs.findIndex(tab => tab.isActive);
      const nextIndex = (currentIndex + 1) % tabs.length;
      if (tabs[nextIndex]) {
        store.dispatch(setActiveTab(tabs[nextIndex].id));
      }
    };
    if (runSettingsGuard(proceed)) return;
    proceed();
  };

  private handlePrevTab = (): void => {
    const proceed = () => {
      const state = store.getState();
      const tabs = state.tabs.tabs;
      const currentIndex = tabs.findIndex(tab => tab.isActive);
      const prevIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
      if (tabs[prevIndex]) {
        store.dispatch(setActiveTab(tabs[prevIndex].id));
      }
    };
    if (runSettingsGuard(proceed)) return;
    proceed();
  };

  private handleTabByNumber = (num: number): void => {
    const proceed = () => {
      const state = store.getState();
      const tabs = state.tabs.tabs;
      if (tabs[num - 1]) {
        store.dispatch(setActiveTab(tabs[num - 1].id));
      }
    };
    if (runSettingsGuard(proceed)) return;
    proceed();
  };

  private handleSplitHorizontal = (): void => {
    const state = store.getState();
    const activePaneId = state.panes.activePaneId;
    if (activePaneId) {
      store.dispatch(splitPane({ paneId: activePaneId, direction: 'horizontal' }));
    }
  };

  private handleClosePane = (): void => {
    const state = store.getState();
    const activePaneId = state.panes.activePaneId;
    if (activePaneId) {
      const { closePane } = require('../store/slices/panesSlice');
      store.dispatch(closePane(activePaneId));
    }
  };

  private handleToggleMaximizePane = (): void => {
    const state = store.getState();
    const tabId = state.panes.activeTabId;
    const paneId = state.panes.activePaneId;
    if (tabId && paneId) {
      store.dispatch(toggleMaximizePane({ tabId, paneId }));
    }
  };

  private handlePaneNavigation = (direction: 'left' | 'right' | 'up' | 'down'): void => {
    // This would use the navigatePane helper from PaneManager
    console.log(`Navigate pane ${direction}`);
  };

  private handlePaste = async (): Promise<void> => {
    try {
      // Native clipboard read (Tauri) — avoids the WebView "wants to see
      // clipboard" permission popup that navigator.clipboard.readText() triggers.
      const text = await readClipboardText();
      this.handlePasteText(text);
    } catch (err) {
      console.error('Failed to read clipboard:', err);
    }
  };

  handlePasteText(text: string, id?: string): void {
    const state = store.getState();
    let targetId = id;

    // If no ID provided (e.g. from global shortcut), find the terminalId of the active pane
    if (!targetId && state.panes.activePaneId && state.panes.paneTree) {
      const findTerminalId = (node: any): string | null => {
        if (node.id === state.panes.activePaneId) return node.terminalId || null;
        if (node.children) {
          for (const child of node.children) {
            const result = findTerminalId(child);
            if (result) return result;
          }
        }
        return null;
      };
      targetId = findTerminalId(state.panes.paneTree) || undefined;
    }

    if (targetId) {
      // Route through xterm (cacheKey === terminalId) so multi-line pastes get
      // bracketed-paste markers + CRLF→CR normalization — CLIs (Claude Code, Gemini)
      // then treat the whole paste as one literal block instead of submitting each
      // line. Falls back to a raw PTY write if the terminal isn't currently mounted.
      if (!pasteToTerminal(targetId, text)) {
        terminalService.writeToTerminal(targetId, text).catch(err => {
          console.error('Failed to paste to terminal:', err);
        });
      }
    } else {
      console.warn('InputHandler: Could not determine target terminal for paste');
    }
  }

  private handleClearTerminal = (): void => {
    const state = store.getState();
    let targetId: string | undefined;

    if (state.panes.activePaneId && state.panes.paneTree) {
      const findTerminalId = (node: any): string | null => {
        if (node.id === state.panes.activePaneId) return node.terminalId || null;
        if (node.children) {
          for (const child of node.children) {
            const result = findTerminalId(child);
            if (result) return result;
          }
        }
        return null;
      };
      targetId = findTerminalId(state.panes.paneTree) || undefined;
    }

    if (targetId) {
      // Send clear command using terminalService
      terminalService.writeToTerminal(targetId, '\x0c').catch(err => {
        console.error('Failed to clear terminal:', err);
      });
    }
  };

  private handleToggleFullScreen = (): void => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  };

  // Public methods
  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

// Create singleton instance
export const inputHandler = new InputHandler();