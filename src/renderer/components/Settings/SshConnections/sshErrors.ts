import type { SshReply, SshStoreApi } from '../../../types/ssh';

const allowedOptions = 'ServerAliveInterval, ServerAliveCountMax, TCPKeepAlive, ConnectTimeout, ConnectionAttempts, Compression, AddressFamily, IPQoS, LogLevel, RekeyLimit, LocalForward, RemoteForward, DynamicForward, ExitOnForwardFailure, ForwardAgent, SendEnv, SetEnv';
const allowedKeys = new Set(allowedOptions.toLowerCase().split(', '));
const fieldCopy: Record<string,string> = {
  'name/length':"Name must be 1–80 characters.",
  'name/invalid':"Name can't contain control characters.",
  'host/required':"Enter a host.",
  'host/leading-dash':"Host can't start with “-”.",
  'host/invalid':"Enter a hostname, IPv4 address, or IPv6 address without spaces or control characters.",
  'host/length':"Host must be at most 255 characters.",
  'port/range':"Port must be a number from 1 to 65535.",
  'user/leading-dash':"User can't start with “-”.",
  'user/invalid':"User can't contain spaces, control characters, or “@”.",
  'user/length':"User must be at most 128 characters.",
  'identityFile/required':"Choose an identity file for key-file authentication.",
  'identityFile/not-applicable':"Identity files are only used with key-file authentication.",
  'identityFile/invalid':"Identity file can't contain control characters.",
  'identityFile/length':"Identity file must be at most 4096 characters.",
  'folderId/not-found':"Choose a folder that still exists.",
  'folderId/invalid':"Choose a valid folder.",
  'folderId/length':"Folder ID must be at most 64 characters.",
  'jumpConnectionId/not-found':"Choose a jump host that still exists.",
  'jumpConnectionId/invalid':"Choose a valid jump host.",
  'jumpConnectionId/length':"Jump host ID must be at most 64 characters.",
  'jumpConnectionId/self':"A connection can't use itself as a jump host.",
  'jumpConnectionId/nested':"Choose a jump host that doesn't use another jump host.",
  'id/invalid':"Connection ID can only contain letters, numbers, hyphens, and underscores.",
  'id/length':"Connection ID must be at most 64 characters.",
  'lastUsedAt/invalid':"Last-used timestamp can't contain control characters.",
  'lastUsedAt/length':"Last-used timestamp must be at most 64 characters.",
  'secret/invalid':"Secret can't contain control characters.",
  'secret/length':"Secret must be at most 16384 characters.",
  'extraOptions/too-many':"Up to 32 options.",
  'extraOptions/invalid-key':"Option names must contain only letters A–Z.",
  'extraOptions/invalid-value':"Option values can't contain control characters.",
  'extraOptions/length':"Each option value must be at most 1024 characters.",
  'extraOptions/local-expansion':"Option values can't use “${…}” or “%” tokens, which ssh would fill in from this computer.",
  'extraOptions/one-line':"Options must be on one line.",
  'extraOptions/invalid-pair':"Use Key=Value pairs.",
  'extraOptions/unclosed-quote':"Close the unclosed quote in Extra options.",
};

export function sshFieldMessage(field:string, code:string, key?:string):string {
  if (field === 'extraOptions' && code === 'option-not-allowed') return `${key ? `“${key}” isn't` : 'This option isn’t'} allowed here. Allowed options: ${allowedOptions}.`;
  return fieldCopy[`${field}/${code}`] ?? 'Check this field.';
}

export const isAllowedSshOption = (key:string) => allowedKeys.has(key.toLowerCase());

export function sshErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return typeof error === 'string' ? error : 'SSH operation failed';
}

export async function refreshReadOnly(error: unknown, api: SshStoreApi, apply: (reply: SshReply) => void): Promise<void> {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'store-read-only') apply(await api.get());
}
