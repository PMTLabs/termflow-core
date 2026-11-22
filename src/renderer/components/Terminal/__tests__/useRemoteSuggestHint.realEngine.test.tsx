/**
 * @jest-environment jsdom
 *
 * Plan 061, the chain the fake-engine tests in useRemoteSuggestHint.test.tsx cannot
 * pin: REAL OSC handlers inside the real TerminalEngine -> `onPromptMark` -> the hook.
 * xterm itself is the terminal-core mock (the same one terminal-core's own engine tests
 * run on), so the parser is replaced by a handler table, but every line from the
 * handler to the chip decision is production code.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

jest.mock('@xterm/xterm', () => jest.requireActual('../../../../../packages/terminal-core/src/__mocks__/xterm'));
jest.mock('@xterm/addon-fit', () => jest.requireActual('../../../../../packages/terminal-core/src/__mocks__/addon-fit'));
jest.mock('@xterm/addon-web-links', () => jest.requireActual('../../../../../packages/terminal-core/src/__mocks__/addon-web-links'));
jest.mock('@xterm/addon-unicode11', () => jest.requireActual('../../../../../packages/terminal-core/src/__mocks__/addon-unicode11'));
jest.mock('@xterm/addon-webgl', () => jest.requireActual('../../../../../packages/terminal-core/src/__mocks__/addon-webgl'));
jest.mock('@xterm/addon-search', () => jest.requireActual('../../../../../packages/terminal-core/src/__mocks__/addon-search'));

const mockSsh = new Set<string>();
const mockTrackerListeners = new Set<() => void>();
jest.mock('../../../services/AgentSchemeTracker', () => ({
  agentSchemeTracker: {
    isSshForeground: (id: string) => mockSsh.has(id),
    subscribe: (listener: () => void) => {
      mockTrackerListeners.add(listener);
      return () => { mockTrackerListeners.delete(listener); };
    },
  },
}));

import { TerminalEngine, terminalCache } from '@termflow/terminal-core';
import { resetRemoteHintDismissals } from '../remoteSuggestHint';
import { useRemoteSuggestHint } from '../useRemoteSuggestHint';

const noop = { dispose() {} };
const bridge = { onData: () => noop, onExit: () => noop, write: () => {}, resize: () => {} };

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: 600, configurable: true });
  document.body.appendChild(el);
  return el;
}

const Probe: React.FC<{ id: string; engine: TerminalEngine }> = ({ id, engine }) => {
  const ref = React.useRef<TerminalEngine | null>(engine);
  ref.current = engine;
  const { show } = useRemoteSuggestHint(id, ref, 1);
  return <div data-show={String(show)} />;
};

let container: HTMLDivElement;
let root: Root;
const shown = (): boolean => container.firstElementChild!.getAttribute('data-show') === 'true';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  mockSsh.clear();
  mockTrackerListeners.clear();
  resetRemoteHintDismissals();
  terminalCache.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mountEngine(cacheKey: string) {
  const engine = new TerminalEngine(bridge, { cacheKey, commandSuggestions: () => true } as never);
  engine.mount(makeContainer());
  engine.attach('pid-1');
  const term = terminalCache.get(cacheKey)!.terminal as unknown as {
    oscHandlers: Record<number, (data: string) => boolean>;
  };
  return { engine, term };
}

function render(engine: TerminalEngine, id: string): void {
  const store = configureStore({ reducer: { settings: (s: { commandSuggestions: boolean } = { commandSuggestions: true }) => s } });
  act(() => { root.render(<Provider store={store}><Probe id={id} engine={engine} /></Provider>); });
}

describe('real engine -> useRemoteSuggestHint', () => {
  it('chip appears after a local prompt + ssh and is gone once the host sends OSC 133;A', () => {
    const { engine, term } = mountEngine('rh-real-1');
    render(engine, 'rh-real-1');
    act(() => { term.oscHandlers[9]('9;C:\\repo'); }); // hooked local pwsh prompt
    act(() => {
      mockSsh.add('rh-real-1');
      for (const l of [...mockTrackerListeners]) l();
    });
    expect(shown()).toBe(true);
    act(() => { term.oscHandlers[133]('B'); }); // not a prompt start: chip stays
    expect(shown()).toBe(true);
    act(() => { term.oscHandlers[133]('A'); }); // the host's prompt
    expect(shown()).toBe(false);
  });

  it('a host that marked before ssh was observed never shows the chip', () => {
    const { engine, term } = mountEngine('rh-real-2');
    render(engine, 'rh-real-2');
    act(() => { term.oscHandlers[9]('9;C:\\repo'); });
    act(() => { term.oscHandlers[133]('A'); });
    act(() => {
      mockSsh.add('rh-real-2');
      for (const l of [...mockTrackerListeners]) l();
    });
    expect(shown()).toBe(false);
  });

  it('a local prompt after ssh ends brings the chip rule back to "local"', () => {
    const { engine, term } = mountEngine('rh-real-3');
    render(engine, 'rh-real-3');
    act(() => { term.oscHandlers[9]('9;C:\\repo'); });
    act(() => { term.oscHandlers[133]('A'); });
    expect(shown()).toBe(false);
    act(() => { term.oscHandlers[9]('9;C:\\repo'); }); // ssh ended, local prompt
    act(() => {
      mockSsh.add('rh-real-3');
      for (const l of [...mockTrackerListeners]) l();
    });
    expect(shown()).toBe(true); // a fresh ssh episode is offered again
  });
});
