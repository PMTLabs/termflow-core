/**
 * Which OSC titles a tab should adopt.
 *
 * A shell can rename its terminal at any time by emitting an OSC 0/2 sequence, and
 * `TerminalPane` feeds those straight into `setAutoTabTitle`. Most shells say something useful
 * — the working directory, the running program, `user@host`. **`cmd.exe` says its own full
 * path**, so a "Command Prompt" tab renames itself to `C:\WINDOWS\system32\cmd.exe` within a
 * frame of opening, and Canvas Mode's group frame — which is labelled with the tab title —
 * shows that path as the name of the group.
 *
 * Reported from live testing 2026-08-17, noticed on the canvas; the tab strip had always shown
 * it too.
 */

/** Extensions that make a final path segment an EXECUTABLE rather than a document. */
const EXECUTABLE_EXT = /\.(exe|com|bat|cmd|ps1|scr)$/i;

/**
 * Is this auto-title just the shell naming its own binary?
 *
 * Deliberately NARROW, because the useful titles look superficially similar and losing one is
 * worse than keeping a path. It matches only a title whose **entire** value is a path (or bare
 * filename) whose final segment ends in an executable extension:
 *
 * | Title | Adopted? | |
 * |---|---|---|
 * | `C:\WINDOWS\system32\cmd.exe` | no | the bug |
 * | `cmd.exe` | no | same thing without the path |
 * | `C:\Users\user\project` | **yes** | a directory is real information |
 * | `~/src/app` | **yes** | as above |
 * | `dev@box: ~/src` | **yes** | contains a separator, is not a path |
 * | `build.cmd (~/scripts) - VIM` | **yes** | ends in the program, not the extension |
 * | `npm run build` | **yes** | no separator, no extension |
 *
 * An empty or whitespace title is refused too. Nothing in the pipeline filtered it, so a shell
 * clearing its title left a nameless tab and an unlabelled group — a much smaller bug living
 * in exactly the same line.
 */
export function isExecutablePathTitle(raw: string): boolean {
  const t = raw.trim();
  if (!t) return true;
  // The final segment, under either separator — a Windows path can arrive with forward
  // slashes (Git Bash, WSL interop) and a POSIX one never has backslashes.
  const seg = t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1);
  if (!seg) return true;                     // a trailing separator: `C:\WINDOWS\`
  return EXECUTABLE_EXT.test(seg);
}

/**
 * The tab keeps the name it already had.
 *
 * Refusing the update beats rewriting it to a friendly name: the title in place is the shell
 * PROFILE's name — "Command Prompt", "PowerShell 7", "WSL - Ubuntu (v2)" — which is already
 * the friendly form, is what the "+" menu offered, and is what a user who edited their
 * profiles chose. A lookup table mapping `cmd.exe` back to "Command Prompt" would be a second
 * source of truth for a name we were already holding.
 */
export function shouldAdoptAutoTitle(raw: string): boolean {
  return !isExecutablePathTitle(raw);
}
