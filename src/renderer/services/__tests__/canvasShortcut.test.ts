/**
 * @jest-environment jsdom
 */
// Canvas Mode's toggle shortcut, end to end: registered as data, wired to a
// dispatch, and matched by a real keypress.
//
// The last of those is the point. `Ctrl+Shift+Alt+Space` registers as
// "control+alt+shift+space", but the live path builds its combo from
// `event.key`, which for the space bar is a literal " " — and
// canonicalizeCombo trims each segment and drops the empty ones, so the live
// string was "control+alt+shift+" and matched nothing. The shortcut would have
// shipped registered, listed in Settings, and completely dead. Exactly the
// shape of the Plus-key bug this file's sibling already guards.

const dispatch = jest.fn();
const subscribe = jest.fn(() => () => {});
const mockState = {
  tabs: { tabs: [{ id: 'tb-1', isActive: true, title: 'Bash' }] },
  settings: { shellProfiles: [], defaultProfile: 'bash', customKeybindings: {} },
  panes: { activePaneId: 'p-1', activeTabId: 'tb-1' },
  canvas: { enabled: false },
};
jest.mock('../../store', () => ({
  store: {
    getState: () => mockState,
    dispatch: (a: unknown) => dispatch(a),
    subscribe: (...args: unknown[]) => subscribe(...args),
  },
}));
jest.mock('../settingsNavGuard', () => ({ runSettingsGuard: () => false }));
jest.mock('@termflow/terminal-core', () => ({ pasteToTerminal: jest.fn() }));
jest.mock('../TerminalService', () => ({ terminalService: {} }));
jest.mock('../../utils/clipboard', () => ({ readClipboardText: jest.fn() }));
jest.mock('../openSettings', () => ({ openSettingsTab: jest.fn() }));
// Canvas Mode is a tab, so the shortcut calls a service rather than dispatching an action.
// Mocked here so this file stays about the KEY PATH; openCanvas.test.ts owns the tab
// behaviour itself.
const toggleCanvasTab = jest.fn();
jest.mock('../openCanvas', () => ({ toggleCanvasTab: () => toggleCanvasTab() }));

import { inputHandler } from '../InputHandler';
import { SHORTCUT_ACTIONS, findConflict } from '../shortcutActions';

afterAll(() => inputHandler.destroy());

function press(key: string, opts: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
}

const CANVAS_COMBO = { key: ' ', ctrlKey: true, shiftKey: true, altKey: true };

describe('canvas mode shortcut registration', () => {
  it('registers toggleCanvasMode with the agreed default combo', () => {
    const action = SHORTCUT_ACTIONS.find((a) => a.id === 'toggleCanvasMode');
    expect(action).toBeDefined();
    expect(action!.defaultCombo).toBe('Ctrl+Shift+Alt+Space');
    expect(action!.label).toBe('Toggle Canvas Mode');
  });

  // Derived from the real list rather than a hand-maintained one: every action
  // is checked against every other AND against the reserved combos, so this
  // also covers conflicts the raw-string comparison below cannot see (Cmd vs
  // Ctrl, modifier order, casing).
  it('gives every action a default combo that conflicts with nothing', () => {
    for (const a of SHORTCUT_ACTIONS) {
      expect(findConflict(a.id, a.defaultCombo, {})).toBeNull();
    }
  });

  it('does not collide with any other default combo', () => {
    const combos = SHORTCUT_ACTIONS.map((a) => a.defaultCombo.toLowerCase());
    expect(new Set(combos).size).toBe(combos.length);
  });
});

describe('canvas mode shortcut behaviour', () => {
  beforeEach(() => { dispatch.mockClear(); toggleCanvasTab.mockClear(); });

  it('toggles the canvas tab when the combo is pressed', () => {
    press(CANVAS_COMBO.key, CANVAS_COMBO);
    expect(toggleCanvasTab).toHaveBeenCalledTimes(1);
  });

  it('does not toggle when only some modifiers are held', () => {
    press(' ', { ctrlKey: true, shiftKey: true });
    press(' ', { ctrlKey: true, altKey: true });
    press(' ', {});
    expect(toggleCanvasTab).not.toHaveBeenCalled();
  });

  // `applyKeybindingOverrides` re-registers through the action->handler map.
  // An action missing from that map registers correctly at startup and then
  // silently disappears the first time the user rebinds it.
  it('still works after the user rebinds it', () => {
    try {
      inputHandler.applyKeybindingOverrides({ toggleCanvasMode: 'Ctrl+Alt+K' });
      toggleCanvasTab.mockClear();

      press('k', { ctrlKey: true, altKey: true });
      expect(toggleCanvasTab).toHaveBeenCalledTimes(1);

      toggleCanvasTab.mockClear();
      press(CANVAS_COMBO.key, CANVAS_COMBO); // the old default must be released
      expect(toggleCanvasTab).not.toHaveBeenCalled();
    } finally {
      inputHandler.applyKeybindingOverrides({});
    }
  });

  it('returns to the default combo when the override is removed', () => {
    inputHandler.applyKeybindingOverrides({ toggleCanvasMode: 'Ctrl+Alt+K' });
    inputHandler.applyKeybindingOverrides({});
    toggleCanvasTab.mockClear();
    press(CANVAS_COMBO.key, CANVAS_COMBO);
    expect(toggleCanvasTab).toHaveBeenCalledTimes(1);
  });
});
