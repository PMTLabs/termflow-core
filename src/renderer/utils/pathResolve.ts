// Path helpers for backlog 003 link resolution. The renderer runs in a WebView
// (no Node `path`), so these are minimal and platform-sniffing by string shape.

/** Windows drive (C:\ or C:/), UNC (\\server), or POSIX (/) absolute path. */
export function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);
}

/** Join a relative path under a cwd, picking the separator from the cwd's shape
 *  (backslash for Windows-style cwd, slash otherwise), stripping a leading `./`
 *  or separators from the relative part, and normalizing the relative part's
 *  separators to the native one — so a forward-slash path under a Windows cwd
 *  becomes a backslash path the OS can actually open (not "File not found"). */
export function joinCwd(cwd: string, rel: string): string {
  const isWin = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.includes('\\');
  const sep = isWin ? '\\' : '/';
  const base = cwd.replace(/[\\/]+$/, '');
  const tail = rel
    .replace(/^\.[\\/]/, '')
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, () => sep);
  return `${base}${sep}${tail}`;
}
