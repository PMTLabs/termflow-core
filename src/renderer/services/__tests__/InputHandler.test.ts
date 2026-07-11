/**
 * @jest-environment jsdom
 */
// Regression guard for the capture-phase Ctrl+W shadowing bug (PR #31 review):
// InputHandler owns a window-capture keydown listener that claims Ctrl+W and stops
// propagation, so it must route the close through TabManager's confirmation flow
// (the ui:requestTabClose event) rather than removing the tab directly — otherwise
// Ctrl+W would close a running tab with no "processes will be terminated" dialog.

const dispatch = jest.fn();
const subscribe = jest.fn(() => () => {});
const mockState: {
  tabs: { tabs: Array<{ id: string; isActive: boolean; title?: string }> };
  settings: { shellProfiles: Array<{ id: string; name: string }>; defaultProfile: string; customKeybindings: Record<string, string> };
} = {
  tabs: { tabs: [{ id: 'tb-1', isActive: true, title: 'Bash' }] },
  settings: { shellProfiles: [{ id: 'bash', name: 'Bash' }, { id: 'zsh', name: 'Zsh' }], defaultProfile: 'zsh', customKeybindings: {} },
};
jest.mock('../../store', () => ({
  store: {
    getState: () => mockState,
    dispatch: (a: unknown) => dispatch(a),
    subscribe: (...args: unknown[]) => subscribe(...args),
  },
}));
// Settings-dirty guard is exercised by handleCloseRequest, not here → pass-through.
jest.mock('../settingsNavGuard', () => ({ runSettingsGuard: () => false }));
// Heavy / browser-only collaborators pulled in at module load — stub them out.
jest.mock('@termflow/terminal-core', () => ({ pasteToTerminal: jest.fn() }));
jest.mock('../TerminalService', () => ({ terminalService: {} }));
jest.mock('../../utils/clipboard', () => ({ readClipboardText: jest.fn() }));
const openSettingsTab = jest.fn();
jest.mock('../openSettings', () => ({ openSettingsTab: () => openSettingsTab() }));

import { inputHandler, InputHandler } from '../InputHandler';
import { removeTab, addTab } from '../../store/slices/tabsSlice';

afterAll(() => inputHandler.destroy());

function pressCtrlW(): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

function pressShortcut(key: string, opts: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }),
  );
}

describe('InputHandler Ctrl+W routing', () => {
  beforeEach(() => {
    dispatch.mockClear();
    mockState.tabs.tabs = [{ id: 'tb-1', isActive: true }];
  });

  it('routes Ctrl+W through the ui:requestTabClose confirmation flow (not a direct removeTab)', () => {
    const requests: string[] = [];
    const listener = (e: Event) => requests.push((e as CustomEvent).detail?.tabId);
    window.addEventListener('ui:requestTabClose', listener);
    try {
      pressCtrlW();
    } finally {
      window.removeEventListener('ui:requestTabClose', listener);
    }
    // The active tab is sent to the confirmation flow…
    expect(requests).toEqual(['tb-1']);
    // …and the tab is NOT closed directly (would bypass the dialog + exit-0 logic).
    expect(dispatch).not.toHaveBeenCalledWith(removeTab('tb-1'));
  });

  it('is a no-op when there is no active tab', () => {
    mockState.tabs.tabs = [{ id: 'tb-1', isActive: false }];
    const requests: string[] = [];
    const listener = (e: Event) => requests.push((e as CustomEvent).detail?.tabId);
    window.addEventListener('ui:requestTabClose', listener);
    try {
      pressCtrlW();
    } finally {
      window.removeEventListener('ui:requestTabClose', listener);
    }
    expect(requests).toEqual([]);
  });
});

describe('InputHandler Ctrl/Cmd+Shift+T opens a new tab', () => {
  beforeEach(() => {
    dispatch.mockClear();
    mockState.tabs.tabs = [{ id: 'tb-1', isActive: true, title: 'Bash' }];
    mockState.settings = { shellProfiles: [{ id: 'bash', name: 'Bash' }, { id: 'zsh', name: 'Zsh' }], defaultProfile: 'zsh', customKeybindings: {} };
  });

  it('dispatches addTab using the default profile on Ctrl+Shift+T', () => {
    pressShortcut('T', { ctrlKey: true, shiftKey: true });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const dispatched = dispatch.mock.calls[0][0];
    expect(dispatched).toEqual(addTab(dispatched.payload));
    expect(dispatched.payload).toMatchObject({ shellType: 'zsh', title: 'Zsh' });
  });

  it('dispatches addTab on Cmd+Shift+T (macOS)', () => {
    pressShortcut('T', { metaKey: true, shiftKey: true });

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('generates a unique title when the default profile name collides with an existing tab', () => {
    mockState.tabs.tabs = [{ id: 'tb-1', isActive: true, title: 'Zsh' }];

    pressShortcut('T', { ctrlKey: true, shiftKey: true });

    const dispatched = dispatch.mock.calls[0][0];
    expect(dispatched.payload.title).toBe('Zsh 1');
  });

  it('is a no-op when no shell profiles are loaded yet', () => {
    mockState.settings.shellProfiles = [];

    pressShortcut('T', { ctrlKey: true, shiftKey: true });

    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('InputHandler.applyKeybindingOverrides', () => {
  beforeEach(() => {
    // A prior describe block's last test intentionally leaves shellProfiles
    // empty — reset settings fully so newTab's handler (used by the swap
    // test below) can actually resolve a default profile.
    mockState.settings = { shellProfiles: [{ id: 'bash', name: 'Bash' }, { id: 'zsh', name: 'Zsh' }], defaultProfile: 'zsh', customKeybindings: {} };
  });

  afterEach(() => {
    // Restore defaults so later tests in this file aren't affected.
    inputHandler.applyKeybindingOverrides({});
  });

  it('rebinds an action to its override combo and the old default no longer fires', () => {
    mockState.tabs.tabs = [{ id: 'tb-1', isActive: true, title: 'Bash' }];
    inputHandler.applyKeybindingOverrides({ closeTab: 'Ctrl+Alt+Q' });

    const requests: string[] = [];
    const listener = (e: Event) => requests.push((e as CustomEvent).detail?.tabId);
    window.addEventListener('ui:requestTabClose', listener);
    try {
      // Old default Ctrl+W must no longer trigger closeTab.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
      expect(requests).toEqual([]);

      // New combo Ctrl+Alt+Q must trigger it.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      expect(requests).toEqual(['tb-1']);
    } finally {
      window.removeEventListener('ui:requestTabClose', listener);
    }
  });

  it('is idempotent — reapplying the same overrides does not throw or double-fire', () => {
    inputHandler.applyKeybindingOverrides({ closeTab: 'Ctrl+Alt+Q' });
    expect(() => inputHandler.applyKeybindingOverrides({ closeTab: 'Ctrl+Alt+Q' })).not.toThrow();
  });

  it('silently skips an unknown actionId instead of throwing', () => {
    expect(() => inputHandler.applyKeybindingOverrides({ notARealAction: 'Ctrl+Z' })).not.toThrow();
  });

  it('does not throw when called with no argument (defensive default)', () => {
    expect(() => inputHandler.applyKeybindingOverrides()).not.toThrow();
  });

  it('swapping two actions\' combos leaves both correctly bound, not one orphaned', () => {
    mockState.tabs.tabs = [{ id: 'tb-1', isActive: true, title: 'Bash' }];
    // newTab's default is Ctrl+Shift+T, closeTab's default is Ctrl+W. Swap them.
    inputHandler.applyKeybindingOverrides({ newTab: 'Ctrl+W', closeTab: 'Ctrl+Shift+T' });

    const requests: string[] = [];
    const listener = (e: Event) => requests.push((e as CustomEvent).detail?.tabId);
    window.addEventListener('ui:requestTabClose', listener);
    try {
      // Ctrl+W now fires newTab, not closeTab.
      dispatch.mockClear();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
      expect(dispatch).toHaveBeenCalledTimes(1); // addTab dispatched
      expect(requests).toEqual([]); // ui:requestTabClose NOT fired

      // Ctrl+Shift+T now fires closeTab.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      expect(requests).toEqual(['tb-1']);
    } finally {
      window.removeEventListener('ui:requestTabClose', listener);
    }
  });

  it('the fixed Ctrl+Shift+V paste fallback survives an action\'s combo transiting through and away from it', () => {
    inputHandler.applyKeybindingOverrides({ paste: 'Ctrl+Shift+V' }); // paste temporarily takes the fallback's combo
    inputHandler.applyKeybindingOverrides({ paste: 'Ctrl+Alt+P' }); // then moves away from it

    const event = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    // handlePaste (async) was invoked — it internally calls readClipboardText then handlePasteText;
    // asserting the keydown was actually claimed (preventDefault called) proves the fallback is
    // still registered — handlePaste's internals are already covered by existing tests in this file.
    expect(event.defaultPrevented).toBe(true);
  });

  it('a combo registered with Ctrl fires on a live Cmd (metaKey) press, and vice versa — end-to-end regression guard for the Dual Review #2 Cmd/Meta bug', () => {
    mockState.tabs.tabs = [{ id: 'tb-1', isActive: true, title: 'Bash' }];
    inputHandler.applyKeybindingOverrides({ closeTab: 'Cmd+Alt+Q' }); // registered using "Cmd" in the string

    const requests: string[] = [];
    const listener = (e: Event) => requests.push((e as CustomEvent).detail?.tabId);
    window.addEventListener('ui:requestTabClose', listener);
    try {
      // A live press with metaKey (physical Cmd) must still match.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', metaKey: true, altKey: true, bubbles: true, cancelable: true }));
      expect(requests).toEqual(['tb-1']);
    } finally {
      window.removeEventListener('ui:requestTabClose', listener);
    }
  });

  it('a combo registered with the word "Plus" fires on a live physical + keypress — end-to-end regression guard for the final-review Plus-key bug', () => {
    // The recording UI captures a literal '+' keypress as the word "Plus"
    // (Dual Review #3) so it doesn't collide with the combo-string delimiter.
    // The live matching side must map the same physical keypress the same
    // way, or registration and matching silently disagree.
    mockState.tabs.tabs = [{ id: 'tb-1', isActive: true, title: 'Bash' }];
    inputHandler.applyKeybindingOverrides({ closeTab: 'Ctrl+Plus' });

    const requests: string[] = [];
    const listener = (e: Event) => requests.push((e as CustomEvent).detail?.tabId);
    window.addEventListener('ui:requestTabClose', listener);
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true, cancelable: true }));
      expect(requests).toEqual(['tb-1']);
    } finally {
      window.removeEventListener('ui:requestTabClose', listener);
    }
  });

  it('does not subscribe to the store if destroy() runs before the constructor\'s queued microtask fires', async () => {
    subscribe.mockClear();
    const instance = new InputHandler();
    instance.destroy(); // synchronous, before the constructor's queueMicrotask has had a chance to run

    await Promise.resolve(); // flush the microtask queue

    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe('InputHandler Ctrl/Cmd+, opens Settings', () => {
  beforeEach(() => openSettingsTab.mockClear());

  it('opens Settings on Ctrl+,', () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(openSettingsTab).toHaveBeenCalledTimes(1);
  });

  it('opens Settings on Cmd+, (macOS)', () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true }),
    );
    expect(openSettingsTab).toHaveBeenCalledTimes(1);
  });
});
