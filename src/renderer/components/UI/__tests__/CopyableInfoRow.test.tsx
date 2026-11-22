/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CopyableInfoRow, shortenMiddle } from '../CopyableInfoRow';

const PC = 'pc-bbc0309af3fa4842937dbc0d04313b73';

describe('CopyableInfoRow', () => {
  it('leaves short ids untouched', () => {
    expect(shortenMiddle('tb-7wr88wm9g')).toBe('tb-7wr88wm9g');
    expect(shortenMiddle('x'.repeat(24))).toBe('x'.repeat(24));
  });

  it('middle-ellipsizes a long id', () => {
    expect(shortenMiddle(PC)).toBe('pc-bbc0309a…04313b73');
  });

  it('shows the short form, keeps the full id in the tooltip, and copies the full id', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<CopyableInfoRow label="Process ID:" value={PC} />));
    const shown = Array.from(container.querySelectorAll<HTMLElement>('*'))
      .find(el => el.children.length === 0 && el.textContent === 'pc-bbc0309a…04313b73')!;
    expect(shown.getAttribute('title')).toBe(PC);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Copy Process ID"]')!.click());
    expect(writeText).toHaveBeenCalledWith(PC);
    await act(async () => root.unmount());
    container.remove();
  });
});
