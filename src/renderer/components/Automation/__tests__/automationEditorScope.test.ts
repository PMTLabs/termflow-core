/**
 * @jest-environment jsdom
 *
 * §10.22 — the ref-counted keyboard suspension.
 *
 * `InputHandler` registers Ctrl+W, Ctrl+1–9, Ctrl+Shift+D/W/Enter, Alt+[/], Ctrl+V, Ctrl+, and F11
 * on `window` in the **capture** phase, and capture runs root→target before any component's own
 * listener — which is why every existing dialog in this app already leaks those keys to the app
 * behind it. A near-fullscreen editor cannot.
 *
 * The three assertions are the three ways this goes wrong:
 *
 * 1. **Suspended, the key does not reach its handler.** Otherwise Ctrl+W typed while naming an
 *    automation closes the tab underneath.
 * 2. **Released, it does again.** A suspension that never lifts leaves the app permanently deaf to
 *    every shortcut, with no visible cause.
 * 3. **Two overlapping suspensions need two releases.** This is why it is a counter and not the
 *    existing boolean `disable()`: a boolean is cleared by the first of two owners to leave
 *    (`boolean-cannot-hold-overlapping-ownership`), so the first dialog to close would hand the
 *    keyboard back on the editor's behalf.
 */
const dispatch = jest.fn();
const mockState = {
    tabs: { activeTabId: 'tb-1', tabs: [{ id: 'tb-1', isActive: true, title: 'Bash' }] },
    settings: { shellProfiles: [], defaultProfile: 'bash', customKeybindings: {} },
    panes: { activePaneId: 'p-1', activeTabId: 'tb-1', paneTree: { id: 'p-1', type: 'terminal', terminalId: 'tm-1' } },
    canvas: { focusedId: null },
};
jest.mock('../../../store', () => ({
    store: {
        getState: () => mockState,
        dispatch: (a: unknown) => dispatch(a),
        subscribe: () => () => {},
    },
}));
jest.mock('../../../services/settingsNavGuard', () => ({ runSettingsGuard: () => false }));
jest.mock('@termflow/terminal-core', () => ({ pasteToTerminal: jest.fn(() => true) }));
jest.mock('../../../services/TerminalService', () => ({
    terminalService: { writeToTerminal: jest.fn(() => Promise.resolve()) },
}));
jest.mock('../../../utils/clipboard', () => ({ readClipboardText: jest.fn() }));
jest.mock('../../../services/openSettings', () => ({ openSettingsTab: jest.fn() }));

// eslint-disable-next-line import/first
import { inputHandler, suspendGlobalShortcuts } from '../../../services/InputHandler';

afterAll(() => inputHandler.destroy());

/** Ctrl+W, as the window-capture listener would see it. */
const ctrlW = () =>
    new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true });

/**
 * Did the key reach a handler?
 *
 * `handleKeyEvent` returns `true` exactly when a registered shortcut ran — the same boolean the
 * window listener acts on. Asserting the RETURN rather than a spy on one specific handler is what
 * makes this a test of the suspension rather than of the close-tab action: a suspension that let
 * some other combo through would still be broken.
 */
const reaches = () => inputHandler.handleKeyEvent(ctrlW());

/**
 * Did the CLOSE-TAB action actually run?
 *
 * Ctrl+W does not dispatch into the store — it raises `ui:requestTabClose`, so `TabManager` can run
 * its "processes will be terminated" confirmation first. Spying on `store.dispatch` therefore proves
 * nothing about this key, which is the arrange-right-assert-blind shape: the test would have passed
 * on a suspension that let every combo through, because the thing it watched never fires either way.
 */
function closeRequests(run: () => void): number {
    let seen = 0;
    const onClose = () => {
        seen += 1;
    };
    window.addEventListener('ui:requestTabClose', onClose);
    try {
        run();
    } finally {
        window.removeEventListener('ui:requestTabClose', onClose);
    }
    return seen;
}

describe('suspendGlobalShortcuts', () => {
    beforeEach(() => {
        // The counter is on a singleton, so a leaked suspension from one test would silently pass
        // the next one. Drain it rather than assuming.
        while (inputHandler.suspensionCount() > 0) inputHandler.suspendGlobalShortcuts()();
    });

    it('lets Ctrl+W reach the close-tab request when nothing is suspended', () => {
        expect(closeRequests(() => expect(reaches()).toBe(true))).toBe(1);
    });

    it('does NOT let it through while suspended', () => {
        const release = suspendGlobalShortcuts();
        expect(closeRequests(() => expect(reaches()).toBe(false))).toBe(0);
        release();
    });

    it('lets it through again after the release', () => {
        const release = suspendGlobalShortcuts();
        release();
        expect(inputHandler.suspensionCount()).toBe(0);
        expect(reaches()).toBe(true);
    });

    it('needs TWO releases for two overlapping suspensions', () => {
        const first = suspendGlobalShortcuts();
        const second = suspendGlobalShortcuts();
        expect(inputHandler.suspensionCount()).toBe(2);

        first();
        // The editor is still open behind the dialog that just closed. A boolean would have handed
        // the keyboard back here, and Ctrl+W in the editor would close a tab.
        expect(inputHandler.suspensionCount()).toBe(1);
        expect(reaches()).toBe(false);

        second();
        expect(inputHandler.suspensionCount()).toBe(0);
        expect(reaches()).toBe(true);
    });

    it('ignores a release called twice', () => {
        // React runs an effect cleanup once, but a component that also called it defensively would
        // otherwise decrement on someone else's behalf.
        const first = suspendGlobalShortcuts();
        const second = suspendGlobalShortcuts();
        first();
        first();
        first();
        expect(inputHandler.suspensionCount()).toBe(1);
        expect(reaches()).toBe(false);
        second();
        expect(reaches()).toBe(true);
    });

    it('never lets the counter go negative', () => {
        // A stray release with nothing suspended must not bank a credit that swallows the NEXT
        // suspension — which would be a deaf editor rather than a deaf app, and just as invisible.
        const stray = suspendGlobalShortcuts();
        stray();
        stray();
        expect(inputHandler.suspensionCount()).toBe(0);
        const real = suspendGlobalShortcuts();
        expect(reaches()).toBe(false);
        real();
    });

    it('is independent of the enabled flag', () => {
        // Two mechanisms, two questions: `disable()` is "this window is not taking input at all",
        // suspension is "a surface has borrowed the shortcuts". Conflating them is how one owner
        // ends up clearing the other's state.
        const release = suspendGlobalShortcuts();
        inputHandler.enable();
        expect(inputHandler.isEnabled()).toBe(true);
        expect(reaches()).toBe(false);
        release();
        expect(reaches()).toBe(true);
    });
});
