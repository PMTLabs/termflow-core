import type { PromptMarkState } from '@termflow/terminal-core';

/**
 * Plan 061: when to offer the remote prompt-hook chip.
 *
 * The chip exists for one situation: a hooked local pwsh tab whose user ran `ssh`, so
 * Enter disarmed the command-suggest gate and the remote shell has not (yet) told us
 * it renders prompts. It is decided from ORDER, not timing: the foreground-process
 * poll lags up to a couple of seconds, so a pre-hooked host can send its first mark
 * before ssh is even observed. Whatever the latest prompt mark was is the truth —
 * a local OSC 9;9 means the host has said nothing; a host mark (OSC 133;A / OSC 7)
 * means it already re-arms the gate and the chip has nothing to offer.
 */
export interface RemoteHintInputs {
  /** ssh is the terminal's foreground program (stale by up to one poll). */
  sshForeground: boolean;
  /** Latest prompt-mark knowledge from the engine, null until an engine exists. */
  mark: PromptMarkState | null;
  /** The command-suggest setting. */
  suggestEnabled: boolean;
  /** The user dismissed the chip for this tab. */
  dismissed: boolean;
}

export function shouldShowRemoteHint(i: RemoteHintInputs): boolean {
  return (
    i.sshForeground &&
    i.suggestEnabled &&
    !i.dismissed &&
    i.mark !== null &&
    i.mark.seen && // only a hooked local shell has a gate the remote can fail to re-arm
    i.mark.kind === 'local'
  );
}

// Dismissal is per tab and lives in renderer memory: it survives the TerminalDisplay
// remounts that tab switches and splits cause, and resets when the app restarts.
// Terminal ids are never reused within a session, so the set is only as large as the
// number of tabs a user dismissed the chip on.
const dismissedTerminals = new Set<string>();

export function isRemoteHintDismissed(terminalId: string): boolean {
  return dismissedTerminals.has(terminalId);
}

export function dismissRemoteHint(terminalId: string): void {
  dismissedTerminals.add(terminalId);
}

/** Test seam: forget every dismissal. */
export function resetRemoteHintDismissals(): void {
  dismissedTerminals.clear();
}
