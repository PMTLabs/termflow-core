/** @jest-environment jsdom */
// Root renderer tests drive `react-dom/client` + `act` directly; the root
// package does not depend on @testing-library.
import React, { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { SshMenus } from '../../Settings/SshConnections/SshMenus';
import type { SshFolder, SshStoreApi } from '../../../types/ssh';
import { ContextMenu } from '../ContextMenu';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

// Accessible name: aria-labelledby, then aria-label, then text outside aria-hidden.
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) return labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  const label = el.getAttribute('aria-label');
  if (label !== null) return label.trim();
  const text = (node: Node): string => node.nodeType === Node.TEXT_NODE
    ? node.textContent ?? ''
    : node instanceof Element && node.getAttribute('aria-hidden') === 'true' ? '' : [...node.childNodes].map(text).join('');
  return text(el).replace(/\s+/g, ' ').trim();
}
const roleOf = (el: Element) => el.getAttribute('role') ?? (el.tagName === 'BUTTON' ? 'button' : null);
function allByRole(role: string, name?: string | RegExp, scope: ParentNode = document.body): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('*')].filter(el => roleOf(el) === role
    && (name === undefined || (typeof name === 'string' ? accessibleName(el) === name : name.test(accessibleName(el)))));
}
function queryByRole(role: string, name?: string | RegExp): HTMLElement | null {
  const found = allByRole(role, name);
  if (found.length > 1) throw new Error(`more than one ${role} ${name ?? ''}`);
  return found[0] ?? null;
}
function byRole(role: string, name?: string | RegExp, scope?: ParentNode): HTMLElement {
  const found = allByRole(role, name, scope);
  if (found.length !== 1) throw new Error(`expected one ${role} ${name ?? ''}, found ${found.length}`);
  return found[0];
}
// Like getByText: an element whose own text nodes equal the text.
function queryByText(text: string): HTMLElement | null {
  const found = [...document.body.querySelectorAll<HTMLElement>('*')].filter(el =>
    [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim() === text);
  if (found.length > 1) throw new Error(`more than one element with text ${text}`);
  return found[0] ?? null;
}
function byText(text: string): HTMLElement {
  const found = queryByText(text);
  if (!found) throw new Error(`no element with text ${text}`);
  return found;
}
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
const keyDown = (el: Element, key: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
async function waitFor(check: () => void, timeoutMs = 1000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { check(); return; } catch (error) { if (Date.now() >= end) throw error; }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

test('checkbox_menu_aria_checked_tracks_actual_visibility', () => {
  const disabledAction = jest.fn();
  function Host() {
    const [open, setOpen] = useState(false);
    const [hidden, setHidden] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Metrics menu</button>
      {!hidden && <output>CPU reading</output>}
      {open && <ContextMenu x={10} y={10} onClose={() => setOpen(false)} items={[
        { type: 'heading', label: 'Show in status bar', click: disabledAction },
        { label: 'CPU', checked: !hidden, click: () => setHidden(value => !value) },
        { label: 'RAM', checked: true, enabled: false, click: disabledAction },
      ]} />}
    </>;
  }
  render(<Host />);
  const open = () => click(byRole('button', 'Metrics menu'));
  const cpu = () => byRole('menuitemcheckbox', 'CPU');
  open();
  click(byText('Show in status bar'));
  expect(cpu().getAttribute('aria-checked')).toBe('true');
  expect(cpu().textContent).toBe('✓CPU');
  click(cpu());
  expect(queryByText('CPU reading')).toBeNull();
  open();
  expect(cpu().getAttribute('aria-checked')).toBe('false');
  expect(cpu().textContent).toBe('CPU');
  const ram = byRole('menuitemcheckbox', 'RAM') as HTMLButtonElement;
  expect(ram.disabled).toBe(true);
  click(ram);
  keyDown(ram, 'Enter');
  keyDown(ram, ' ');
  expect(disabledAction).not.toHaveBeenCalled();
  keyDown(byRole('menu'), 'End');
  expect(document.activeElement).toBe(cpu());
  keyDown(cpu(), ' ');
  expect(byText('CPU reading')).not.toBeNull();
  open();
  expect(cpu().getAttribute('aria-checked')).toBe('true');
  keyDown(cpu(), 'Enter');
  expect(queryByText('CPU reading')).toBeNull();
});

test('normal_disabled_and_submenu_behaviour_unchanged', async () => {
  const folder: SshFolder = { id: 'folder', parentId: null, name: 'Hosts', icon: 'folder', color: 'blue', order: 0 };
  const rename = jest.fn();
  const commit = jest.fn(async () => true);
  function Host() {
    const [open, setOpen] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Folder actions</button>
      {open && <SshMenus target={{ x: 10, y: 10, row: folder, kind: 'folder' }}
        view={{ folders: [folder], connections: [], revision: 1, loadError: null }}
        api={{} as SshStoreApi} commit={commit} onClose={() => setOpen(false)}
        onFolder={jest.fn()} onConnection={jest.fn()} onRename={rename} />}
    </>;
  }
  render(<Host />);
  const invoker = byRole('button', 'Folder actions');
  act(() => invoker.focus());
  click(invoker);
  const row = (name: RegExp) => byRole('menuitem', name) as HTMLButtonElement;
  const menu = byRole('menu');
  expect(document.activeElement).toBe(menu);
  const disabled = row(/move down/i);
  expect(disabled.disabled).toBe(true);
  click(disabled);
  keyDown(disabled, 'Enter');
  expect(commit).not.toHaveBeenCalled();
  const danger = row(/delete folder/i);
  expect(danger.classList.contains('danger')).toBe(true);
  expect(danger.hasAttribute('aria-checked')).toBe(false);
  keyDown(menu, 'End');
  expect(document.activeElement).toBe(danger);
  keyDown(danger, 'ArrowUp');
  expect(document.activeElement).toBe(row(/rename/i));
  const submenu = row(/folder icon/i);
  act(() => submenu.focus());
  keyDown(submenu, 'ArrowRight');
  expect(submenu.getAttribute('aria-expanded')).toBe('true');
  expect(allByRole('button', undefined, byRole('group', 'Choose icon'))).toContain(document.activeElement);
  act(() => submenu.focus());
  keyDown(submenu, 'ArrowLeft');
  expect(submenu.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(submenu);
  const renameRow = row(/rename/i);
  act(() => renameRow.focus());
  keyDown(renameRow, 'Enter');
  expect(rename).toHaveBeenCalledWith(folder, 'folder');
  expect(queryByRole('menu')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(invoker));
});
