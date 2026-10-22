import { TerminalEngine } from '../TerminalEngine';
import { terminalCache } from '../cache';
import { Terminal as MockTerminal } from '../__mocks__/xterm';
import type { TerminalBridge } from '../types';

export function makeEngine(id = 'source', shellType = 'pwsh', isMac = false) {
  (globalThis as any).ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} };
  const write = jest.fn();
  const bridge: TerminalBridge = { write, resize() {}, onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) };
  const container = document.createElement('div');
  Object.defineProperties(container, { offsetWidth: { value: 800 }, offsetHeight: { value: 600 } });
  document.body.appendChild(container);
  const engine = new TerminalEngine(bridge, { cacheKey: id, shellType: () => shellType, isWindows: !isMac, isMac });
  engine.mount(container);
  engine.attach(`pid-${id}`);
  const term = terminalCache.get(id)!.terminal as unknown as MockTerminal;
  return { engine, term, write, container };
}
export function event(key: string, options: KeyboardEventInit & { type?: string } = {}) {
  const codes: Record<string, number> = { Enter: 13, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Tab: 9, Escape: 27, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45 };
  return new KeyboardEvent(options.type ?? 'keydown', {
    key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    keyCode: codes[key] ?? key.toUpperCase().charCodeAt(0), ...options,
  });
}
