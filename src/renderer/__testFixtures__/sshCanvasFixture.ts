/**
 * Shared fixtures for the plan 070 SSH canvas tests.
 *
 * JSDOM DOES NO LAYOUT. Every rectangle and computed width below is an explicit fixture standing
 * in for what the engine would report; these tests prove the wiring (which element is measured,
 * registered and sized, and the arithmetic between them), not engine geometry. Real-engine
 * evidence is plan 070 T8.
 */
import { FitAddon } from '@xterm/addon-fit';
import type { PaneNode } from '../store/slices/panesSlice';
import type { SshPaneTag } from '../components/Ssh/ssh066Contract';

/** `.terminal-display { padding: 4px; box-sizing: border-box }` (TerminalDisplay.css). */
export const HOST_PADDING = 4;
export const CELL_W = 8.6015625;
export const CELL_H = 17;

export function rect(width: number, height: number): DOMRect {
  return { width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) } as DOMRect;
}

export function stubRect(el: Element, width: number, height: number): void {
  (el as HTMLElement).getBoundingClientRect = () => rect(width, height);
}

/** Emulates the CSS chain: a border-box host whose content box is FitAddon's input. */
export function sizeHostContent(host: HTMLElement, borderW: number, borderH: number): void {
  host.style.width = `${borderW - 2 * HOST_PADDING}px`;
  host.style.height = `${borderH - 2 * HOST_PADDING}px`;
}

export interface SeededPane {
  shell: HTMLElement;
  browser: HTMLElement;
  status: HTMLElement;
  host: HTMLElement;
  element: HTMLElement;
}

/**
 * An SSH pane shaped exactly as `SshPaneShell` + `TerminalPane` render it, with fixture boxes.
 * `terminal` is the fit host's BORDER box; `browserW`/`statusH` include their borders.
 */
export function seedSshPane(cache: Map<string, unknown>, terminalId: string, o: {
  terminal: { w: number; h: number }; browserW: number; collapsed?: boolean; statusH: number;
}): SeededPane {
  const shell = document.createElement('section');
  shell.className = 'ssh-pane-shell';
  const body = document.createElement('div');
  body.className = 'ssh-pane-body';
  const browser = document.createElement('aside');
  browser.className = o.collapsed ? 'ssh-browser collapsed' : 'ssh-browser';
  const slot = document.createElement('div');
  slot.className = 'ssh-terminal-host';
  const content = document.createElement('div');
  content.className = 'terminal-pane-content';
  const host = document.createElement('div');
  host.className = 'terminal-display';
  const element = document.createElement('div');
  element.style.padding = '0px';
  const status = document.createElement('div');
  status.className = 'ssh-status';
  host.appendChild(element);
  content.appendChild(host);
  slot.appendChild(content);
  body.append(browser, slot);
  shell.append(body, status);
  document.body.appendChild(shell);
  stubRect(host, o.terminal.w, o.terminal.h);
  stubRect(browser, o.browserW, o.terminal.h);
  stubRect(status, o.terminal.w + o.browserW, o.statusH);
  sizeHostContent(host, o.terminal.w, o.terminal.h);
  cache.set(terminalId, { terminal: { element } });
  return { shell, browser, status, host, element };
}

/** A minimal xterm double for the REAL FitAddon, as `canvasHostBoxes.test.ts` builds it. */
export function fitTerminal(element: HTMLElement) {
  const term = {
    element, cols: 0, rows: 0, options: { scrollback: 1000 }, resize: jest.fn(),
    _core: { _renderService: { dimensions: { css: { cell: { width: CELL_W, height: CELL_H } } }, clear: jest.fn() } },
  } as any;
  const fit = new FitAddon();
  fit.activate(term);
  Object.assign(term, fit.proposeDimensions());
  return { term, fit };
}

/** Move `term.element` into `to` and fit, as the relocation effect and its observer do. */
export function relocateAndFit(t: ReturnType<typeof fitTerminal>, to: HTMLElement) {
  const before = t.fit.proposeDimensions()!;
  to.appendChild(t.term.element);
  const after = t.fit.proposeDimensions()!;
  t.fit.fit();
  return { before, after, resized: t.term.resize.mock.calls.length };
}

export function sshTag(over: Partial<SshPaneTag> = {}): SshPaneTag {
  return { connectionId: 'conn-shared', browserCollapsed: false, followCd: false, hiddenMetrics: [], ...over };
}

/**
 * A pane tree whose leaves carry the `ssh` field structurally (066 is not merged; the seam
 * `readSshPaneTag` reads it this way). `undefined` tags make local leaves.
 */
export function sshTree(leaves: Array<{ terminalId: string; ssh?: SshPaneTag }>): PaneNode {
  const nodes = leaves.map(l => ({ id: `pn-${l.terminalId}`, type: 'terminal', terminalId: l.terminalId, ...(l.ssh ? { ssh: l.ssh } : {}) }) as PaneNode);
  return nodes.length === 1 ? nodes[0] : { id: 'pn-split', type: 'split', direction: 'horizontal', children: nodes };
}
