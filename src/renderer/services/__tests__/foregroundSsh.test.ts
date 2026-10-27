import { isSshProcessName } from '../foregroundSsh';

describe('isSshProcessName', () => {
  it.each(['ssh', 'ssh.exe', 'SSH.EXE', 'Ssh', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', '/usr/bin/ssh'])(
    'recognises the ssh client: %s',
    (name) => expect(isSshProcessName(name)).toBe(true),
  );

  it.each([
    'sshd', 'sshd.exe', 'ssh-agent.exe', 'my-ssh-tool', 'plink.exe', 'pwsh.exe', 'claude.exe',
    'ssh.exe.bak', 'xssh', 'C:\\ssh\\pwsh.exe', '', '   ',
  ])('does not mistake another program for it: %j', (name) => expect(isSshProcessName(name)).toBe(false));

  it('tolerates a missing name (a process row without currentApp)', () => {
    expect(isSshProcessName(undefined)).toBe(false);
    expect(isSshProcessName(null)).toBe(false);
  });
});
