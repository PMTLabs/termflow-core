/**
 * @jest-environment jsdom
 *
 * Mounted host coverage for plan 041. The real TerminalDisplay is used; only the xterm/PTY and
 * unrelated published-surface boundaries are stubbed so the menu, store, dialogs, and terminal
 * identity all run through their production wiring.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from '../../../store';
import { setSnippets } from '../../../store/slices/settingsSlice';
import type { Snippet } from '../../../store/slices/settingsSlice';
import { TerminalDisplay } from '../TerminalDisplay';
import { splitPaneById } from '../../../services/paneActions';
import { setSurfaceChrome } from '../../../services/surfaceChrome';
import { writeClipboardText } from '../../../utils/clipboard';

jest.mock('@xterm/xterm', () => ({ Terminal: class FakeTerminal {} }));
jest.mock('@termflow/terminal-core', () => {
  class FakeTerminalEngine {
    static suppressHealUntil = 0;
    terminal = {};
    mount = jest.fn(() => true);
    unmount = jest.fn();
    relocateTo = jest.fn(() => 'relocated');
    attach = jest.fn();
    isScrolledToBottom = jest.fn(() => true);
    onScrollPosition = jest.fn(() => ({ dispose: jest.fn() }));
    setEndedRegionColors = jest.fn();
    setActive = jest.fn();
    setFontSize = jest.fn();
    setFontWeight = jest.fn();
    focus = jest.fn();
    getContextMenuActions = jest.fn(() => ({
      copy: jest.fn(), paste: jest.fn(), clear: jest.fn(), selectAll: jest.fn(),
      resetRendering: jest.fn(), toggleWebGL: jest.fn(),
    }));
    hasCopyableSelection = jest.fn(() => false);
    isWebGLGloballyDisabled = jest.fn(() => true);
    isSelectionMode = jest.fn(() => false);
    isMouseTrackingActive = jest.fn(() => false);
    getCopyableSelection = jest.fn(() => '');
    getLinkAt = jest.fn(() => null);
    getCursorPixelPosition = jest.fn(() => null);
  }
  return { TerminalEngine: FakeTerminalEngine, pasteToTerminal: jest.fn(() => true) };
});
jest.mock('../ContextMenu.css', () => ({}));
jest.mock('../TerminalDisplay.css', () => ({}));
jest.mock('../MainBridge', () => ({ createMainBridge: jest.fn(() => ({})) }));
jest.mock('../useTerminalSearch', () => ({
  useTerminalSearch: () => ({
    open: false, query: '', caseSensitive: false, wholeWord: false, regex: false,
    result: { resultIndex: -1, resultCount: 0 }, focusToken: 0,
    setQuery: jest.fn(), toggleCaseSensitive: jest.fn(), toggleWholeWord: jest.fn(),
    toggleRegex: jest.fn(), next: jest.fn(), previous: jest.fn(), close: jest.fn(),
    openSearch: jest.fn(),
  }),
}));
jest.mock('../useCommandSuggest', () => ({
  useCommandSuggest: () => ({
    open: false, items: [], selectedIndex: 0, focused: false, anchor: null,
    pick: jest.fn(), close: jest.fn(), onInputLineChanged: jest.fn(), onAction: jest.fn(),
  }),
}));
jest.mock('../useSurfaceRelocation', () => ({
  useSurfaceRelocation: () => ({ engineMounted: jest.fn(), engineGeneration: 0, host: null }),
}));
jest.mock('../useOverlayChromeGate', () => ({ useOverlayChromeGate: jest.fn() }));
jest.mock('../../../hooks/useDismissOnTabDeactivate', () => ({ useDismissOnTabDeactivate: jest.fn() }));
jest.mock('../TerminalSearchBar', () => ({ TerminalSearchBar: () => null }));
jest.mock('../CommandSuggestPopup', () => ({ CommandSuggestPopup: () => null }));
jest.mock('../ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }));
jest.mock('../../Automation/AutomationMenuSection', () => ({ automationMenuItems: () => [] }));
jest.mock('../../../services/paneActions', () => ({
  openNewTabWithDefaultProfile: jest.fn(), openNewWindow: jest.fn(), splitPaneById: jest.fn(),
}));
jest.mock('../../../services/TerminalService', () => ({
  terminalService: {
    takePromptGateHandoff: jest.fn(), takeWin32InputModeHandoff: jest.fn(),
    stashPromptGate: jest.fn(), markReattachedSession: jest.fn(),
    writeToTerminal: jest.fn(() => Promise.resolve()),
  },
}));
jest.mock('../../../services/commandHistoryService', () => ({
  commandHistoryService: { record: jest.fn(), ensureDirLoaded: jest.fn(() => Promise.resolve()), match: jest.fn(() => []) },
}));
jest.mock('../../../services/cwdSnapshot', () => ({ getCwdSnapshot: jest.fn(() => undefined) }));
jest.mock('../../../services/AgentSchemeTracker', () => ({
  agentSchemeTracker: {
    getAgentForTerminal: jest.fn(() => undefined), getDetectedAgentForTerminal: jest.fn(() => undefined),
    subscribe: jest.fn(() => jest.fn()), refreshNow: jest.fn(() => Promise.resolve()),
  },
}));
jest.mock('../../../services/openSettings', () => ({ openSettingsTab: jest.fn() }));
jest.mock('../../../services/insertTextIntoTerminal', () => ({ insertTextIntoTerminal: jest.fn() }));
jest.mock('../../../services/surfaceChrome', () => ({
  setSurfaceChrome: jest.fn(), clearSurfaceChrome: jest.fn(),
}));
jest.mock('../../../api/tauri-bridge', () => ({ getWindowsBuildNumber: jest.fn(() => 0) }));
jest.mock('@tauri-apps/api/event', () => ({ listen: jest.fn(() => Promise.resolve(jest.fn())) }));
jest.mock('../../../utils/clipboard', () => ({
  readClipboardText: jest.fn(() => Promise.resolve('')),
  writeClipboardText: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../../store/colorSchemas', () => ({
  DEFAULT_COLOR_SCHEMA_ID: 'default', COLOR_SCHEMAS: [], getSchemaTheme: jest.fn(() => ({ background: '#000000' })),
}));
jest.mock('../../../store/terminalTheme', () => ({
  resolveSchemaId: jest.fn(() => 'default'), setPaneBackgroundVar: jest.fn(),
}));
jest.mock('../../../utils/diag', () => ({ termDiag: jest.fn(), isTermDiagEnabled: jest.fn(() => false), setTermDiag: jest.fn() }));

const longText = `${'echo a very long command '.repeat(4)}\necho second line`;
const originalSnippet: Snippet = {
  id: 'mounted-snippet',
  label: 'Saved label '.repeat(8),
  text: longText,
  createdAt: 1000,
};

let container: HTMLDivElement;
let root: Root;
let dispatchSpy: jest.SpyInstance;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as any).electronAPI = {
    setConfigValue: jest.fn(),
    writeToTerminal: jest.fn(() => Promise.resolve()),
  };
});

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  store.dispatch(setSnippets([originalSnippet]));
  dispatchSpy = jest.spyOn(store, 'dispatch');
  (splitPaneById as jest.Mock).mockClear();
  (writeClipboardText as jest.Mock).mockClear();
  (setSurfaceChrome as jest.Mock).mockClear();
  await renderDisplays();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  store.dispatch(setSnippets([]));
  dispatchSpy.mockRestore();
  jest.clearAllMocks();
});

async function renderDisplays() {
  await act(async () => {
    root.render(
      <Provider store={store}>
        <TerminalDisplay terminalId="term-a" paneId="pane-a" onData={jest.fn()} onResize={jest.fn()} onTitleChange={jest.fn()} />
        <TerminalDisplay terminalId="term-b" paneId="pane-b" onData={jest.fn()} onResize={jest.fn()} onTitleChange={jest.fn()} />
      </Provider>,
    );
  });
}

const terminal = (id: string) => document.querySelector<HTMLElement>(`.terminal-display[data-terminal-id="${id}"]`)!;
const rootMenu = () => document.querySelector<HTMLElement>('.context-menu');
const flyoutRows = () => Array.from(document.querySelectorAll<HTMLButtonElement>(
  '.context-menu-flyout[data-flyout-depth="0"] .context-menu-flyout-row',
));
const action = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('.context-menu-flyout-row-action'))
  .find((button) => button.textContent === label)!;

async function rightClickTerminal(id: string) {
  await act(async () => {
    terminal(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  });
}

async function openSnippetsFromContext(id: string) {
  await rightClickTerminal(id);
  const item = Array.from(document.querySelectorAll<HTMLElement>('.context-menu-item'))
    .find((candidate) => candidate.textContent?.includes('Snippets'))!;
  await act(async () => item.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

async function openSnippetActions(id: string) {
  await openSnippetsFromContext(id);
  const row = flyoutRows()[0];
  await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
}

function setField(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('mounted TerminalDisplay plan 041 hosts', () => {
  it('renders one New Pane row for terminal B and maps body plus every inline direction', async () => {
    const expected = [
      ['vertical', 'after'], ['horizontal', 'after'], ['vertical', 'before'], ['horizontal', 'before'],
    ] as const;
    const labels = ['New pane right', 'New pane bottom', 'New pane left', 'New pane up'];

    for (let index = 0; index < expected.length; index += 1) {
      await rightClickTerminal('term-b');
      const menu = rootMenu()!;
      const panes = menu.querySelectorAll('.new-pane-row');
      expect(panes).toHaveLength(1);
      expect(menu.textContent).toContain('New Pane');
      for (const oldLabel of ['New Pane Right', 'New Pane Left', 'New Pane Up', 'New Pane Down']) {
        expect(menu.textContent).not.toContain(oldLabel);
      }
      const row = panes[0] as HTMLElement;
      const controls = Array.from(row.querySelectorAll<HTMLButtonElement>('.new-pane-row-action'));
      expect(controls.map((button) => button.getAttribute('aria-label'))).toEqual(labels);
      await act(async () => {
        if (index === 0) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        else controls[index].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(splitPaneById).toHaveBeenNthCalledWith(index + 1, 'pane-b', ...expected[index]);
      expect(rootMenu()).toBeNull();
    }
  });

  it('routes every live snippet action through terminal B, including dialogs and standalone Insert', async () => {
    const insertTextIntoTerminal = jest.requireMock('../../../services/insertTextIntoTerminal').insertTextIntoTerminal as jest.Mock;

    await openSnippetActions('term-b');
    const row = flyoutRows()[0];
    expect(row.querySelector('.context-menu-flyout-label')!.textContent!.length)
      .toBeLessThan(longText.split('\n', 1)[0].length);
    await act(async () => action('Insert').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(insertTextIntoTerminal).toHaveBeenCalledWith('term-b', longText);
    expect(store.getState().settings.snippets[0].usageCount).toBe(1);
    const recordCall = dispatchSpy.mock.calls.findIndex(([value]) => value.type === 'settings/recordSnippetUse');
    expect(recordCall).toBeGreaterThanOrEqual(0);
    expect(dispatchSpy.mock.invocationCallOrder[recordCall]).toBeLessThan(insertTextIntoTerminal.mock.invocationCallOrder[0]);

    await openSnippetActions('term-b');
    await act(async () => action('Copy').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(writeClipboardText).toHaveBeenCalledWith(longText);

    await openSnippetActions('term-b');
    await act(async () => action('Edit').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const dialog = document.querySelector<HTMLElement>('.snippet-dialog')!;
    const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    const label = dialog.querySelector<HTMLInputElement>('[data-field="label"]')!;
    expect(textarea.value).toBe(longText);
    expect(label.value).toBe(originalSnippet.label);
    await act(async () => setField(textarea, 'edited first line\nedited second line'));
    await act(async () => dialog.querySelector<HTMLButtonElement>('[data-dialog-confirm]')!.click());
    expect(store.getState().settings.snippets[0]).toMatchObject({ id: originalSnippet.id, text: 'edited first line\nedited second line' });

    await openSnippetActions('term-b');
    await act(async () => action('Edit').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const cancelBefore = dispatchSpy.mock.calls.length;
    await act(async () => document.querySelector<HTMLButtonElement>('.snippet-dialog [data-dialog-cancel]')!.click());
    expect(dispatchSpy.mock.calls).toHaveLength(cancelBefore);
    expect(store.getState().settings.snippets[0].text).toBe('edited first line\nedited second line');

    await openSnippetActions('term-b');
    await act(async () => action('Delete').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(document.querySelector('.confirm-dialog')).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog [data-dialog-cancel]')!.click());
    expect(store.getState().settings.snippets).toHaveLength(1);

    const bChrome = [...(setSurfaceChrome as jest.Mock).mock.calls]
      .reverse().find(([id]) => id === 'term-b')![2];
    await act(async () => bChrome.openSnippets());
    const standaloneRow = flyoutRows()[0];
    await act(async () => standaloneRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    await act(async () => action('Insert').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(insertTextIntoTerminal).toHaveBeenLastCalledWith('term-b', 'edited first line\nedited second line');

    await openSnippetActions('term-b');
    await act(async () => action('Delete').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const confirmBefore = dispatchSpy.mock.calls.length;
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog [data-dialog-confirm]')!.click());
    expect(dispatchSpy.mock.calls.length).toBeGreaterThan(confirmBefore);
    expect(dispatchSpy.mock.calls.some(([value]) => value.type === 'settings/removeSnippet' && value.payload === originalSnippet.id)).toBe(true);
    expect(store.getState().settings.snippets).toHaveLength(0);
  });
});
