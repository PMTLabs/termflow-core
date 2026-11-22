import type { RootState } from '../store';
import { browserSshBridge } from '../api/sshBridge';
import { resolveDefaultProfile } from './newTabActions';
import { launchSshConnection } from './sshLaunch';

export type SshPickerLaunch = (id: string) => string | null;

export function sshPickerUnavailable({ ssh, settings }: Pick<RootState, 'ssh' | 'settings'>): string | null {
  if (ssh.status === 'desktop-only') return 'SSH connections require the desktop app.';
  if (ssh.status === 'loading') return 'Loading SSH connections…';
  if (ssh.status === 'error') return ssh.error ?? 'Unable to load SSH connections.';
  if (ssh.view.loadError) return ssh.view.loadError.message;

  const api = window.electronAPI;
  if (!api?.ssh || api.ssh === browserSshBridge) return 'SSH connections require the desktop app.';
  if (!api.sshSessionOpen || !api.sshSessionState || !api.ssh.launchTerminal) {
    return 'SSH launch requires desktop host verification support.';
  }
  const profile = resolveDefaultProfile(settings.shellProfiles, settings.defaultProfile);
  if (!profile) return 'No default shell profile is available for SSH.';
  if (profile.is_wsl || /^wsl(?:\.exe)?$/i.test(profile.path?.split(/[/\\]/).pop() ?? '')) {
    return 'SSH connections launch in a native shell; WSL default profile not supported yet.';
  }
  return null;
}

export const launchSshInTab: SshPickerLaunch = id => {
  const result = launchSshConnection(id);
  return result.ok ? null : result.error.message;
};
