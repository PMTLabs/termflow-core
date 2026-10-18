/** @jest-environment jsdom */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    render(<CopyableInfoRow label="Process ID:" value={PC} />);
    const shown = screen.getByText('pc-bbc0309a…04313b73');
    expect(shown.getAttribute('title')).toBe(PC);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Process ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PC));
  });
});
