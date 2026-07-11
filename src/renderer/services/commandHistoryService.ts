// Backlog 011: in-memory command-history index for the suggestion popup.
// Hydrated once at startup from the SQLite-backed store; matching happens
// synchronously here (the list is small — capped at HYDRATE_LIMIT entries).
// Persistence is fire-and-forget: failures degrade to session-only history.

const HYDRATE_LIMIT = 2000;
const DEFAULT_MATCH_LIMIT = 8;

class CommandHistoryService {
  private commands: string[] = []; // most-recent-first

  async hydrate(): Promise<void> {
    try {
      this.commands = (await window.electronAPI?.loadCommandHistory?.(HYDRATE_LIMIT)) ?? [];
    } catch (e) {
      console.error('commandHistoryService: hydrate failed', e);
      this.commands = [];
    }
  }

  record(command: string): void {
    const cmd = command.trim();
    if (!cmd) return;
    this.commands = [cmd, ...this.commands.filter((c) => c !== cmd)];
    try {
      void window.electronAPI?.addCommandHistory?.(cmd);
    } catch (e) {
      console.error('commandHistoryService: persist failed', e);
    }
  }

  /** Remove one command everywhere (Shift+Delete on a suggestion): in-memory
   *  index + persisted store. Fire-and-forget like record(). */
  remove(command: string): void {
    this.commands = this.commands.filter((c) => c !== command);
    try {
      void window.electronAPI?.deleteCommandHistory?.(command);
    } catch (e) {
      console.error('commandHistoryService: delete failed', e);
    }
  }

  /** Prefix matches first (case-insensitive), then substring matches; the
   *  exact already-typed command is excluded (nothing to suggest). */
  match(input: string, limit = DEFAULT_MATCH_LIMIT): string[] {
    const typed = input.trim();
    const q = typed.toLowerCase();
    if (!q) return [];
    const prefix: string[] = [];
    const substr: string[] = [];
    for (const c of this.commands) {
      if (c === typed) continue;
      const lc = c.toLowerCase();
      if (lc.startsWith(q)) {
        prefix.push(c);
        if (prefix.length >= limit) break;
      } else if (substr.length < limit && lc.includes(q)) {
        substr.push(c);
      }
    }
    return [...prefix, ...substr].slice(0, limit);
  }

  /** Test hook. */
  __reset(): void {
    this.commands = [];
  }
}

export const commandHistoryService = new CommandHistoryService();
