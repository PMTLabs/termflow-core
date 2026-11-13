import type { SshConnectionInput } from '../types/ssh';
export interface SshResolvedView { hops: Pick<SshConnectionInput, 'host' | 'port' | 'user' | 'auth' | 'identityFile'>[]; extraOptions: [string,string][] }
/** Display-only argv tokens; executable shell quoting is owned by launch plan 066. */
export function buildSshArgv(resolved: SshResolvedView): string[] {
  const target = resolved.hops[resolved.hops.length - 1]; if (!target) return [];
  const argv: string[] = [];
  if (target.port !== 22) argv.push('-p', String(target.port));
  if (target.auth === 'keyFile' && target.identityFile) argv.push('-i', target.identityFile);
  if (resolved.hops.length > 1) {
    const jump = resolved.hops[0]; const host = jump.host.includes(':') && !jump.host.startsWith('[') ? `[${jump.host}]` : jump.host;
    if (jump.auth === 'keyFile' && jump.identityFile) argv.push('-o', 'ProxyCommand=<launch quoting required for jump identity>');
    else argv.push('-J', `${jump.user ? `${jump.user}@` : ''}${host}${jump.port !== 22 ? `:${jump.port}` : ''}`);
  }
  for (const [key,value] of resolved.extraOptions) argv.push('-o', `${key}=${value}`);
  argv.push(`${target.user ? `${target.user}@` : ''}${target.host}`);
  return argv;
}
