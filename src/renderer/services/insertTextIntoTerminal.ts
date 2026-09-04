import { pasteToTerminal } from '@termflow/terminal-core';
import { terminalService } from './TerminalService';

/**
 * Insert `text` into the terminal `terminalId` as if it were pasted.
 *
 * Route through xterm (cacheKey === terminalId) so multi-line pastes get
 * bracketed-paste markers + CRLF→CR normalization — CLIs (Claude Code, Gemini)
 * then treat the whole paste as one literal block instead of submitting each
 * line. Falls back to a raw PTY write if the terminal isn't currently mounted.
 *
 * This is the ONE entry point for terminal text insertion (plan/029 §2) — every
 * caller (clipboard paste, Snippets, Command History) must go through here so
 * none of them can silently opt out of the raw-write fallback.
 */
export function insertTextIntoTerminal(terminalId: string, text: string): void {
  if (!pasteToTerminal(terminalId, text)) {
    terminalService.writeToTerminal(terminalId, text).catch(err => {
      console.error('Failed to paste to terminal:', err);
    });
  }
}
