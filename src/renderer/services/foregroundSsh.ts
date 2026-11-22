/**
 * Is this foreground-process name the ssh client? Matched by exact executable base name
 * (`ssh`, `ssh.exe`, any case, with or without a directory), never by substring — `sshd`,
 * `my-ssh-tool` and `plink` are different programs and must not raise the remote-hook chip.
 */
export function isSshProcessName(name: string | null | undefined): boolean {
  if (!name) return false;
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.exe$/, '') === 'ssh';
}
