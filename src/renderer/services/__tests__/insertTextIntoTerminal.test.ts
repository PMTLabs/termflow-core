/**
 * @jest-environment jsdom
 */
// `insertTextIntoTerminal` is the single shared entry point for terminal text
// insertion (plan/029 §2/T1) — extracted out of InputHandler.handlePasteText so a
// future caller (Snippets, Command History) cannot silently skip the raw-write
// fallback. These tests pin that contract directly, independent of InputHandler.

// `pasteToTerminal` returns true for "the terminal is mounted, xterm took it";
// insertTextIntoTerminal falls back to a raw PTY write when it returns false.
jest.mock('@termflow/terminal-core', () => ({ pasteToTerminal: jest.fn(() => true) }));
const writeToTerminal = jest.fn(() => Promise.resolve());
jest.mock('../TerminalService', () => ({ terminalService: { writeToTerminal: (...a: unknown[]) => writeToTerminal(...(a as [])) } }));

import { insertTextIntoTerminal } from '../insertTextIntoTerminal';
import { pasteToTerminal } from '@termflow/terminal-core';

beforeEach(() => {
  (pasteToTerminal as jest.Mock).mockClear();
  (pasteToTerminal as jest.Mock).mockReturnValue(true);
  writeToTerminal.mockClear();
});

describe('insertTextIntoTerminal', () => {
  it('calls pasteToTerminal with the given terminalId and text', () => {
    insertTextIntoTerminal('tm-1', 'hello world');
    expect(pasteToTerminal).toHaveBeenCalledWith('tm-1', 'hello world');
  });

  it('falls back to terminalService.writeToTerminal with the same args when pasteToTerminal returns false', () => {
    (pasteToTerminal as jest.Mock).mockReturnValueOnce(false);
    insertTextIntoTerminal('tm-1', 'hello world');
    expect(writeToTerminal).toHaveBeenCalledWith('tm-1', 'hello world');
  });

  it('does not call writeToTerminal when pasteToTerminal returns true', () => {
    (pasteToTerminal as jest.Mock).mockReturnValueOnce(true);
    insertTextIntoTerminal('tm-1', 'hello world');
    expect(writeToTerminal).not.toHaveBeenCalled();
    expect(writeToTerminal).toHaveBeenCalledTimes(0);
  });
});
