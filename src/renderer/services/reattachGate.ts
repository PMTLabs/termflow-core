import type { PromptGate } from '@termflow/terminal-core';

/**
 * The command-suggest prompt gate (backlog 011) to seed when reattaching to a
 * PTY that survived a full renderer reload (webview reload, app auto-update via
 * PTY-host hot-swap). The gate is the load-bearing suppression on Windows, yet
 * it lives only in the renderer's in-memory `terminalCache` — a reload wipes it,
 * so an agent CLI (agy/codex/claude) that was running across the reload would
 * otherwise leak its keystrokes into the history popup (see TerminalEngine's
 * promptOscSeen/promptArmed and StateManager.reconcileExistingTerminals).
 *
 * A shell the backend reports as prompt-hooked (`promptHook` from /api/terminals
 * — interactive PowerShell) reattaches in the DISARMED state: `armed:false`
 * suppresses capture until a real prompt-render OSC arrives. While the CLI owns
 * the pty no prompt renders, so nothing is captured; once the CLI exits the
 * shell's next prompt (OSC 9;9) re-arms the gate and normal capture resumes.
 *
 * A hookless shell (cmd, remote ssh) reports false and gets NO seed — it keeps
 * the ungated heuristic. Seeding it would gate it forever, since no OSC ever
 * arrives to re-arm it, permanently disabling the popup for that terminal.
 *
 * Design 006 refinement: `atPrompt` is the backend's STRICT bare-prompt signal
 * (shell process alive with zero children). When true, the gate seeds ARMED so
 * the FIRST command after a reload/hot-swap at an idle prompt keeps suggestions
 * and history. Anything else — child present, absent field, wrong type, older
 * backend — stays disarmed (leak-safe) and self-heals at the next prompt OSC.
 */
export function reattachPromptGate(promptHook: unknown, atPrompt?: unknown): PromptGate | null {
  if (promptHook !== true) return null;
  return { seen: true, armed: atPrompt === true };
}
