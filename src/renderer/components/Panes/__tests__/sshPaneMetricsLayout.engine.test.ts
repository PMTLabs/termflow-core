/** @jest-environment jsdom */
import { TerminalEngine } from '../../../../../packages/terminal-core/src/TerminalEngine';
import { terminalCache } from '../../../../../packages/terminal-core/src/cache';
import type { TerminalBridge } from '../../../../../packages/terminal-core/src/types';

jest.mock('@xterm/xterm', () => require('../../../../../packages/terminal-core/src/__mocks__/xterm'));
jest.mock('@xterm/addon-fit', () => require('../../../../../packages/terminal-core/src/__mocks__/addon-fit'));
jest.mock('@xterm/addon-web-links', () => require('../../../../../packages/terminal-core/src/__mocks__/addon-web-links'));
jest.mock('@xterm/addon-unicode11', () => require('../../../../../packages/terminal-core/src/__mocks__/addon-unicode11'));
jest.mock('@xterm/addon-webgl', () => require('../../../../../packages/terminal-core/src/__mocks__/addon-webgl'));
jest.mock('@xterm/addon-search', () => require('../../../../../packages/terminal-core/src/__mocks__/addon-search'));

test('hidden_pane_defers_refit_until_activation (bar insertion then removal)', async () => {
  jest.useFakeTimers();
  let observer!: ResizeObserverCallback;
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { observer = callback; }
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  const host = document.createElement('div');
  Object.defineProperties(host, {
    offsetWidth: { value: 800 }, offsetHeight: { value: 600 }, offsetParent: { value: document.body },
  });
  document.body.append(host);
  const resize = jest.fn();
  const listen = () => ({ dispose() {} });
  const bridge: TerminalBridge = { onData: listen, onExit: listen, write() {}, resize };
  const cacheKey = 'hidden-ssh-bar';
  const engine = new TerminalEngine(bridge, { cacheKey });
  const settle = () => jest.runAllTimersAsync();
  const observe = () => observer([], {} as ResizeObserver);
  try {
    engine.mount(host);
    engine.attach('pc');
    await settle();
    const { terminal, fitAddon } = terminalCache.get(cacheKey)!;
    const fit = fitAddon as typeof fitAddon & { setNextFit(cols: number, rows: number): void };
    // Hypothetical measurements exercise the actual engine's observer and
    // activation contract, not pixel geometry (the separate T8 oracle).
    fit.setNextFit(80, 28);
    observe(); await settle();
    expect(terminal.rows).toBe(28);
    resize.mockClear();
    const fitSpy = jest.spyOn(fit, 'fit');

    engine.setActive(false);
    fit.setNextFit(80, 26); // bar inserted
    observe(); await settle();
    fit.setNextFit(80, 30); // bar removed and host grew while still hidden
    observe(); await settle();
    expect(terminal.rows).toBe(28);
    expect(fitSpy).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();

    engine.setActive(true);
    await settle();
    expect(fitSpy).toHaveBeenCalledTimes(1);
    expect(terminal.rows).toBe(30);
    expect(resize.mock.calls).toEqual([['pc', 80, 30]]);
  } finally {
    engine.dispose();
    terminalCache.clear();
    host.remove();
    globalThis.ResizeObserver = originalObserver;
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
});

test.todo('T8: ssh_bar_reserves_exact_height_without_covering_last_xterm_row (browser + real xterm and resize adapter)');
