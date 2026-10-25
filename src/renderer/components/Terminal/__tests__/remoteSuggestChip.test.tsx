/**
 * @jest-environment jsdom
 *
 * `RemoteSuggestChip` (plan 061 AC6): clicking a shell copies exactly that shell's
 * snippet, reports the outcome, and never touches the pty — the remote end may be a
 * pager, an editor or an agent CLI, and text typed into those is not ours to place.
 */
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { REMOTE_HOOK_SHELLS, REMOTE_HOOK_SNIPPETS } from '../remoteHookSnippets';

const mockWrite = jest.fn<Promise<void>, [string]>();
jest.mock('../../../utils/clipboard', () => ({
  writeClipboardText: (text: string) => mockWrite(text),
}));

import { RemoteSuggestChip } from '../RemoteSuggestChip';

let container: HTMLDivElement;
let root: Root;
let actions: Array<{ type: string; payload?: { message?: string; type?: string } }>;

function renderChip(onDismiss: () => void = () => {}): void {
  const store = configureStore({
    reducer: (state: object = {}, action: { type: string }) => {
      actions.push(action as (typeof actions)[number]);
      return state;
    },
  });
  act(() => { root.render(<Provider store={store}><RemoteSuggestChip onDismiss={onDismiss} /></Provider>); });
}
const toasts = () => actions.filter((a) => a.type.endsWith('addToast'));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  mockWrite.mockReset();
  mockWrite.mockResolvedValue(undefined);
  actions = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const button = (label: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

describe('RemoteSuggestChip', () => {
  it.each(REMOTE_HOOK_SHELLS)('copies exactly the %s snippet and reports success', async (shell) => {
    renderChip();
    await act(async () => { button(shell).click(); });
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledWith(REMOTE_HOOK_SNIPPETS[shell]);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].payload).toMatchObject({ type: 'success' });
    expect(toasts()[0].payload?.message).toContain(shell);
  });

  it('reports a clipboard failure instead of claiming it copied', async () => {
    mockWrite.mockRejectedValue(new Error('denied'));
    renderChip();
    await act(async () => { button('bash').click(); });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].payload).toMatchObject({ type: 'error' }); // never claims it copied
  });

  it('dismisses without copying', () => {
    const onDismiss = jest.fn();
    renderChip(onDismiss);
    act(() => { button('×').click(); });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(0);
  });

  // The component is the whole write surface of this feature. A negative census over its
  // source is the broadest "never writes to the pty" assertion available: it names no call
  // signature (so a differently-spelled write cannot slip past), it names the modules that
  // can reach a pty at all.
  it('imports nothing that can write to a terminal', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'RemoteSuggestChip.tsx'), 'utf8');
    const imports = [...src.matchAll(/^import\s[^;]*?'([^']+)';/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      './RemoteSuggestChip.css',
      './remoteHookSnippets',
      '../../store/slices/uiSlice',
      '../../utils/clipboard',
      'react',
      'react-redux',
    ].sort());
    expect(src).not.toMatch(/electronAPI|terminalService|TerminalService|writeToTerminal|sendInput/);
  });
});
